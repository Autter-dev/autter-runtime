import { createHash } from "node:crypto";
import type { DropRoute } from "./ingest-drops.js";
import type { IngestContext, RuntimeOccurrence } from "./types.js";

/**
 * Loop collapse (1.9.0, EI-38): an error that repeats in a loop is stored
 * as its first N occurrences of the minute plus ONE sample that carries the
 * exact count of the rest, so a loop of 10,000 events a minute costs N + 1
 * rows a minute, not 10,000, and only duplicate payloads are lost.
 *
 * Identical: same tenant, ingest route and arrival minute, and the same
 * - identity: legacy `fingerprint` and every `fingerprints` candidate;
 * - service, environment, release, source, severity, `expected`;
 * - error type and declared error code;
 * - normalised message (`messageNormalized`: ids, numbers and quoted
 *   strings templated out) and normalised top frames (`topFrames`);
 * - session id: an error hitting many sessions is volume, not a loop, and
 *   each session must still count as a user.
 * Trace, request and occurrence ids, route, timestamps, attributes and
 * breadcrumbs may differ: they are what a loop varies.
 *
 * Per window (that identity in one arrival minute): the first `after`
 * occurrences (LOOP_COLLAPSE_AFTER, default 10) are stored and forwarded as
 * they arrive. Every later one is folded: not stored on its own, counted.
 * When the minute is over, the window's newest folded occurrence is stored
 * and forwarded as the sample with `collapsedCount` = folded − 1, so the
 * sample stands for every folded occurrence: stored rows + Σ collapsed_count
 * is exactly the number of occurrences accepted. Its time is the newest
 * folded one, so an issue's last-seen stays exact; its weight lands in the
 * minute it arrived in.
 *
 * Exactness under retries: a request's folds are reserved when it is planned
 * and only counted once its ClickHouse writes succeed (`commit`); a request
 * that fails (503, the exporter retries) gives them back (`rollback`). Ids
 * already seen in the window are recognised, so a batch retried after a lost
 * 2xx is not counted twice. A window is flushed only once no request still
 * holds it (or, as a safety net, five minutes after its minute); a fold that
 * commits after that is carried into the next flush. A failed flush write is
 * kept and retried every tick. Shutdown (SIGTERM) flushes every window, so a
 * deploy loses nothing; only a crash loses the folded counts of the minute in
 * progress.
 *
 * Memory is bounded (safety, not a work cap): windows live for their minute
 * and are cleared on the next flush; past `maxWindows` windows a minute, or
 * `maxSamples` held samples, occurrences of new identities pass through
 * uncollapsed (stored as usual, never lost), and past `maxTrackedIds` folded
 * ids a minute, retry recognition stops for new folds.
 */

export interface LoopCollapseOptions {
	/** Occurrences stored per window before folding starts; 0 turns collapse off. */
	after: number;
	/** Windows (identities) per minute. Default 100,000. */
	maxWindows?: number;
	/** Samples held across all windows until they are flushed. Default 5,000. */
	maxSamples?: number;
	/** Folded occurrence ids remembered per minute, for retry recognition. Default 500,000. */
	maxTrackedIds?: number;
	/** How often due windows are flushed. Default 5 s. */
	flushIntervalMs?: number;
	/** A window still held by a request is flushed anyway this long after its minute. Default 4 min. */
	forceAfterMs?: number;
	now?: () => number;
	log?: (message: string) => void;
}

/** One window's sample, ready to store: `sample.collapsedCount` = folded − 1. */
export interface CollapsedSample {
	route: DropRoute;
	sample: RuntimeOccurrence;
	/** Occurrences the sample stands for (itself included). */
	folded: number;
}

/** Store and forward one tenant's samples. A rejection keeps them for the next tick. */
export type CollapseFlush = (ctx: IngestContext, samples: CollapsedSample[]) => Promise<void>;

export interface CollapsePlan {
	/** Occurrences to store and forward now. */
	kept: RuntimeOccurrence[];
	/** Occurrences folded into a window's sample by this request. */
	folded: number;
	/** Occurrences recognised as already counted (a retried batch); not stored again. */
	repeated: number;
	/** The request's writes succeeded: count its folds. */
	commit(): void;
	/** The request failed: give its reservations back. */
	rollback(): void;
}

export interface LoopCollapseStats {
	windows: number;
	heldSamples: number;
	/** Occurrences folded (committed) since start. */
	folded: number;
	/** Samples stored since start. */
	samplesFlushed: number;
	/** Occurrences that passed through uncollapsed because a bound was reached. */
	overflow: number;
	/** Flush writes that failed (their samples were kept and retried). */
	failedFlushes: number;
}

interface Window {
	ctx: IngestContext;
	route: DropRoute;
	minute: number;
	/** Occurrences counted against `after`, in-flight reservations included. */
	admitted: number;
	/** Ids stored individually in this window (at most `after`). */
	kept: Set<string>;
	/** Ids folded (reserved or committed); null once the id budget ran out. */
	foldedIds: Set<string> | null;
	/** Committed folds and the newest of them. */
	count: number;
	sample: RuntimeOccurrence | null;
	/** Folds reserved by requests still in flight. */
	reserved: number;
	/** Plans still holding this window. */
	pending: number;
	/** True while this window holds (or has reserved) a sample slot. */
	holdsSlot: boolean;
	flushed: boolean;
	/** Folds committed after the flush, carried into the next one. */
	late: Due | null;
}

interface Due {
	ctx: IngestContext;
	route: DropRoute;
	sample: RuntimeOccurrence;
	count: number;
	/** The window whose sample slot this is, released once stored. */
	window: Window | null;
	/** Late folds of this window (window.late points here until collected). */
	lateOf: Window | null;
}

const MINUTE_MS = 60_000;

/**
 * The identity two occurrences must share to fold together (see above),
 * hashed: the raw parts can run to kilobytes (frames, messages).
 */
export function collapseIdentity(o: RuntimeOccurrence): string {
	const parts = [
		o.fingerprint,
		(o.fingerprints ?? []).map((candidate) => `${candidate.scheme}:${candidate.fingerprint}`).join(","),
		o.service,
		o.environment,
		o.release ?? "",
		o.source,
		o.severity,
		o.expected ? "1" : "0",
		o.errorType,
		o.errorCode ?? "",
		o.messageNormalized,
		o.topFrames.join("\n"),
		o.sessionId ?? "",
	];
	return createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 32);
}

const tenantKey = (ctx: IngestContext) => `${ctx.orgId}\u0000${ctx.repositoryId}`;

export class LoopCollapser {
	private readonly minutes = new Map<number, Map<string, Window>>();
	/** Folds committed after their window was flushed, and failed flushes. */
	private carry: Due[] = [];
	private heldSamples = 0;
	private trackedIds = new Map<number, number>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private flushing: Promise<void> | null = null;
	private lastFailureLog = Number.NEGATIVE_INFINITY;
	private stats_ = { folded: 0, samplesFlushed: 0, overflow: 0, failedFlushes: 0 };
	private readonly after: number;
	private readonly maxWindows: number;
	private readonly maxSamples: number;
	private readonly maxTrackedIds: number;
	private readonly flushIntervalMs: number;
	private readonly forceAfterMs: number;
	private readonly now: () => number;
	private readonly log: (message: string) => void;

	constructor(
		private readonly flushSink: CollapseFlush,
		options: LoopCollapseOptions,
	) {
		this.after = Math.max(0, Math.floor(options.after));
		this.maxWindows = options.maxWindows ?? 100_000;
		this.maxSamples = options.maxSamples ?? 5_000;
		this.maxTrackedIds = options.maxTrackedIds ?? 500_000;
		this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
		this.forceAfterMs = options.forceAfterMs ?? 4 * MINUTE_MS;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? ((message) => console.warn(message));
	}

	get enabled(): boolean {
		return this.after > 0;
	}

	/**
	 * Split a request's occurrences into those stored now and those folded
	 * into their window's sample. Synchronous; never throws (on an internal
	 * error every occurrence is kept).
	 */
	plan(ctx: IngestContext, route: DropRoute, occurrences: RuntimeOccurrence[]): CollapsePlan {
		if (!this.enabled || occurrences.length === 0) return passThrough(occurrences);
		try {
			return this.planWindows(ctx, route, occurrences);
		} catch (err) {
			this.log(`loop collapse skipped for a batch: ${(err as Error)?.message ?? err}`);
			return passThrough(occurrences);
		}
	}

	private planWindows(ctx: IngestContext, route: DropRoute, occurrences: RuntimeOccurrence[]): CollapsePlan {
		const minute = Math.floor(this.now() / MINUTE_MS);
		let windows = this.minutes.get(minute);
		if (!windows) {
			windows = new Map();
			this.minutes.set(minute, windows);
		}
		const kept: RuntimeOccurrence[] = [];
		const keptReservations: Array<[Window, string]> = [];
		const folds: Array<[Window, RuntimeOccurrence]> = [];
		const touched = new Set<Window>();
		let repeated = 0;
		const tenant = tenantKey(ctx);
		for (const o of occurrences) {
			const key = `${tenant}\u0000${route}\u0000${collapseIdentity(o)}`;
			let window = windows.get(key);
			if (!window) {
				if (windows.size >= this.maxWindows) {
					this.stats_.overflow += 1;
					kept.push(o);
					continue;
				}
				window = {
					ctx, route, minute, admitted: 0, kept: new Set(), foldedIds: new Set(),
					count: 0, sample: null, reserved: 0, pending: 0, holdsSlot: false, flushed: false, late: null,
				};
				windows.set(key, window);
			}
			if (!touched.has(window)) {
				touched.add(window);
				window.pending += 1;
			}
			const id = o.occurrenceId;
			if (window.kept.has(id)) {
				// A retried batch: stored again with the same id (deduped downstream).
				kept.push(o);
				continue;
			}
			if (window.foldedIds?.has(id)) {
				repeated += 1;
				continue;
			}
			if (window.admitted < this.after) {
				window.admitted += 1;
				window.kept.add(id);
				keptReservations.push([window, id]);
				kept.push(o);
				continue;
			}
			if (!window.holdsSlot) {
				if (this.heldSamples >= this.maxSamples) {
					this.stats_.overflow += 1;
					kept.push(o);
					continue;
				}
				window.holdsSlot = true;
				this.heldSamples += 1;
			}
			window.admitted += 1;
			window.reserved += 1;
			if (window.foldedIds) {
				const tracked = this.trackedIds.get(minute) ?? 0;
				if (tracked < this.maxTrackedIds) {
					window.foldedIds.add(id);
					this.trackedIds.set(minute, tracked + 1);
				} else {
					window.foldedIds = null;
				}
			}
			folds.push([window, o]);
		}
		let settled = false;
		const release = () => {
			for (const window of touched) window.pending -= 1;
		};
		return {
			kept,
			folded: folds.length,
			repeated,
			commit: () => {
				if (settled) return;
				settled = true;
				for (const [window, o] of folds) {
					window.reserved -= 1;
					if (window.flushed) {
						// Its minute was flushed while this request ran: carry the fold
						// (with every other late one of the window) into the next flush.
						if (!window.late) {
							window.late = { ctx: window.ctx, route: window.route, sample: o, count: 0, window: null, lateOf: window };
							this.carry.push(window.late);
						}
						window.late.count += 1;
						if (o.occurredAt.getTime() >= window.late.sample.occurredAt.getTime()) window.late.sample = o;
						continue;
					}
					window.count += 1;
					if (!window.sample || o.occurredAt.getTime() >= window.sample.occurredAt.getTime()) window.sample = o;
				}
				this.stats_.folded += folds.length;
				release();
			},
			rollback: () => {
				if (settled) return;
				settled = true;
				for (const [window, id] of keptReservations) {
					window.admitted -= 1;
					window.kept.delete(id);
				}
				for (const [window, o] of folds) {
					window.admitted -= 1;
					window.reserved -= 1;
					window.foldedIds?.delete(o.occurrenceId);
					// Nothing folded after all: free the sample slot. (A flushed
					// window's slot was freed by the flush, or is by its sample.)
					if (!window.flushed && window.count === 0 && window.reserved === 0) this.releaseSlot(window);
				}
				release();
			},
		};
	}

	/** Flush due windows every flushIntervalMs (unref'd). */
	start(): void {
		if (!this.enabled || this.timer) return;
		this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
		this.timer.unref?.();
	}

	/** Stop the timer and flush every window, the current minute's too (shutdown). */
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.flush(true);
	}

	/**
	 * Store the samples of every window whose minute is over and that no
	 * request still holds, plus carried folds and earlier failed writes.
	 * `all`: every window, current minute included. One flush at a time;
	 * never rejects.
	 */
	flush(all = false): Promise<void> {
		if (this.flushing) {
			if (!all) return this.flushing;
			return this.flushing.then(() => this.flush(true));
		}
		this.flushing = this.flushDue(all).finally(() => {
			this.flushing = null;
		});
		return this.flushing;
	}

	private collectDue(all: boolean): Due[] {
		const due: Due[] = this.carry;
		this.carry = [];
		// Late folds committed from now on start a new carried sample.
		for (const item of due) if (item.lateOf?.late === item) item.lateOf.late = null;
		const nowMs = this.now();
		const current = Math.floor(nowMs / MINUTE_MS);
		for (const [minute, windows] of this.minutes) {
			if (!all && minute >= current) continue;
			const forced = all || nowMs - (minute + 1) * MINUTE_MS >= this.forceAfterMs;
			let open = 0;
			for (const window of windows.values()) {
				if (window.flushed) continue;
				if (window.pending > 0 && !forced) {
					open += 1;
					continue;
				}
				window.flushed = true;
				if (window.count > 0 && window.sample) {
					due.push({ ctx: window.ctx, route: window.route, sample: window.sample, count: window.count, window, lateOf: null });
				} else {
					// Nothing to store; folds still in flight are carried without a slot.
					this.releaseSlot(window);
				}
			}
			if (open === 0) {
				this.minutes.delete(minute);
				this.trackedIds.delete(minute);
			}
		}
		return due;
	}

	private async flushDue(all: boolean): Promise<void> {
		let due: Due[];
		try {
			due = this.collectDue(all);
		} catch (err) {
			this.log(`loop collapse flush failed: ${(err as Error)?.message ?? err}`);
			return;
		}
		if (due.length === 0) return;
		const byTenant = new Map<string, Due[]>();
		for (const item of due) {
			const key = tenantKey(item.ctx);
			byTenant.set(key, [...(byTenant.get(key) ?? []), item]);
		}
		for (const items of byTenant.values()) {
			const samples: CollapsedSample[] = items.map((item) => ({
				route: item.route,
				sample: { ...item.sample, collapsedCount: item.count - 1 },
				folded: item.count,
			}));
			try {
				await this.flushSink(items[0]!.ctx, samples);
				this.stats_.samplesFlushed += samples.length;
				for (const item of items) if (item.window) this.releaseSlot(item.window);
			} catch (err) {
				this.stats_.failedFlushes += 1;
				// Kept (with their slots) and written again next tick.
				this.carry.push(...items);
				if (this.now() - this.lastFailureLog >= MINUTE_MS) {
					this.lastFailureLog = this.now();
					this.log(
						`loop collapse: ${samples.length} collapsed sample(s) not stored yet, retrying: ${(err as Error)?.message ?? err}`,
					);
				}
			}
		}
	}

	private releaseSlot(window: Window): void {
		if (!window.holdsSlot) return;
		window.holdsSlot = false;
		this.heldSamples -= 1;
	}

	stats(): LoopCollapseStats {
		let windows = 0;
		for (const minute of this.minutes.values()) windows += minute.size;
		return { windows, heldSamples: this.heldSamples, ...this.stats_ };
	}
}

function passThrough(occurrences: RuntimeOccurrence[]): CollapsePlan {
	return { kept: occurrences, folded: 0, repeated: 0, commit() {}, rollback() {} };
}
