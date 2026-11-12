import { createHash, randomUUID } from "node:crypto";
import { SUMMARY_HISTOGRAM_BOUNDS_MS, type LatencyHistogram } from "./latency.js";
import { countedBySummary, ERROR_REPORTED_ATTRIBUTE } from "./log-promotion.js";
import type { RuntimeLogRecord } from "./logs.js";
import type { IngestContext } from "./types.js";

/**
 * Edge request latency histograms (`runtime_latency_histograms` points built
 * from request summaries marked `autter.request.counted_by = "summary"`,
 * i.e. `@autter/runtime-edge`, which sends no histogram).
 *
 * runtime-edge exports at the end of each request, so a /v1/logs batch
 * usually holds one request: building one point per batch wrote about one
 * histogram row per edge request. Instead summaries are added, in memory,
 * to one point per tenant, service, environment, release, method, route and
 * minute, and a minute is written once it is over (plus a grace period for
 * late batches). A late summary for a minute already written starts a new
 * point for it; readers sum the points of a minute (`sumForEach(counts)`).
 *
 * Retries: /v1/logs adds a batch's summaries through the request's insert
 * receipts (insert-receipts.ts, table `runtime_latency_histograms`), so a
 * retried batch whose summaries were already added adds nothing, on this
 * replica or (with Redis) another one; within an open minute a record id
 * already added is skipped too. A point keeps its id across failed writes,
 * so a write retried after a timeout replaces rather than adds.
 *
 * Bounded and validated:
 * - a summary without its own timestamp (bucketed at ingest time, which a
 *   retry would not repeat), outside [now − 2 h, now + 5 min], or whose
 *   duration is missing, negative, not finite or over 15 minutes is left
 *   out (`latency_summary_invalid`);
 * - at most 200 routes per service and environment in the last 10 minutes,
 *   50,000 open points in all; past them a summary is left out
 *   (`latency_routes_over_limit`);
 * - a service, environment and route that also reports Node histograms
 *   (`/v1/metrics`, the last 10 minutes) gets no edge point: its histogram
 *   already counts the request, and both would count it twice.
 *
 * A crash loses the open minutes' points (at most about two minutes of edge
 * latency; the summaries themselves are in runtime_logs and the request
 * counts in runtime_metrics_1m). Shutdown writes them.
 */

export const EDGE_ROUTES_PER_SERVICE = 200;
export const EDGE_MAX_OPEN_POINTS = 50_000;
export const EDGE_MAX_DURATION_MS = 15 * 60_000;
export const EDGE_PAST_MS = 2 * 60 * 60_000;
export const EDGE_FUTURE_MS = 5 * 60_000;
/** A minute is written this long after it ends. */
export const EDGE_FLUSH_GRACE_MS = 15_000;
const FLUSH_EVERY_MS = 10_000;
/** How long a route counts towards its service's cap, and how long Node
 * histograms for a route keep its edge summaries out. */
const ROUTE_WINDOW_MS = 10 * 60_000;
const MAX_NODE_ROUTES = 100_000;
/** Record ids remembered per open point for in-minute dedupe. */
const MAX_IDS_PER_POINT = 50_000;

export interface EdgeLatencySample {
	id: string;
	service: string;
	environment: string;
	release: string;
	method: string;
	route: string;
	bucketAtMs: number;
	durationMs: number;
	failed: boolean;
}

/** Summaries left out of edge latency histograms, by reason. */
export interface EdgeLatencyDrops {
	invalid: number;
	overLimit: number;
}

export function emptyEdgeLatencyDrops(): EdgeLatencyDrops {
	return { invalid: 0, overLimit: 0 };
}

/** The counted request summaries of a batch that can be aggregated. */
export function edgeLatencySamples(rows: RuntimeLogRecord[], drops: EdgeLatencyDrops, now = Date.now()): EdgeLatencySample[] {
	const out: EdgeLatencySample[] = [];
	for (const row of rows) {
		if (row.kind !== "request" || !countedBySummary(row.attributes)) continue;
		const method = String(row.attributes["http.request.method"] ?? "").toUpperCase().slice(0, 20);
		// No method or route: no endpoint to put it on (as before, not a drop).
		if (!method || !row.route) continue;
		const at = row.occurredAt.getTime();
		if (
			row.timestamped === false
			|| !Number.isFinite(at) || at < now - EDGE_PAST_MS || at > now + EDGE_FUTURE_MS
			|| row.durationValid === false
			|| !Number.isFinite(row.durationMs) || row.durationMs < 0 || row.durationMs > EDGE_MAX_DURATION_MS
		) {
			drops.invalid += 1;
			continue;
		}
		out.push({
			id: row.id,
			service: row.service,
			environment: row.environment,
			release: row.release,
			method,
			route: row.route,
			bucketAtMs: Math.floor(at / 60_000) * 60_000,
			durationMs: row.durationMs,
			failed: row.outcome === "failed" || row.statusCode >= 500 || row.attributes[ERROR_REPORTED_ATTRIBUTE] === true,
		});
	}
	return out;
}

interface OpenPoint {
	ctx: IngestContext;
	point: LatencyHistogram;
	ids: Set<string>;
}

interface PendingWrite {
	ctx: IngestContext;
	points: LatencyHistogram[];
}

export interface EdgeLatencyOptions {
	write: (ctx: IngestContext, points: LatencyHistogram[], dedupToken: string) => Promise<void>;
	now?: () => number;
	routesPerService?: number;
	maxOpenPoints?: number;
	log?: (message: string) => void;
}

const tenantOf = (ctx: IngestContext) => `${ctx.orgId}\u0000${ctx.repositoryId}`;

export class EdgeLatencyAggregator {
	private readonly open = new Map<string, OpenPoint>();
	/** Written minutes whose write failed: retried with the same ids. */
	private pending: PendingWrite[] = [];
	/** tenant+service+environment → route → last seen. */
	private readonly routes = new Map<string, Map<string, number>>();
	/** tenant+service+environment+route → last Node histogram. */
	private readonly nodeRoutes = new Map<string, number>();
	private readonly instance = randomUUID();
	private sequence = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private flushing: Promise<void> | null = null;
	private failing = false;
	private readonly now: () => number;
	private readonly routesPerService: number;
	private readonly maxOpenPoints: number;
	private readonly log: (message: string) => void;

	constructor(private readonly options: EdgeLatencyOptions) {
		this.now = options.now ?? Date.now;
		this.routesPerService = options.routesPerService ?? EDGE_ROUTES_PER_SERVICE;
		this.maxOpenPoints = options.maxOpenPoints ?? EDGE_MAX_OPEN_POINTS;
		this.log = options.log ?? ((message) => console.warn(message));
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
		this.timer.unref?.();
	}

	/** Write everything, the open minutes too (shutdown). */
	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.flush({ all: true });
	}

	/** Points open or waiting to be written (for tests and health). */
	get size(): number {
		return this.open.size + this.pending.reduce((n, write) => n + write.points.length, 0);
	}

	/** Node histograms (`/v1/metrics`) for these routes: their edge summaries
	 * are counted there already. */
	noteNodeHistograms(ctx: IngestContext, points: LatencyHistogram[]): void {
		const now = this.now();
		for (const point of points) {
			const key = [tenantOf(ctx), point.service, point.environment, point.route].join("\u0000");
			this.nodeRoutes.delete(key);
			this.nodeRoutes.set(key, now);
			for (const [route, at] of this.nodeRoutes) {
				if (this.nodeRoutes.size <= MAX_NODE_ROUTES && at > now - ROUTE_WINDOW_MS) break;
				this.nodeRoutes.delete(route);
			}
		}
	}

	/** Add a batch's samples; returns how many were added. */
	add(ctx: IngestContext, samples: EdgeLatencySample[], drops: EdgeLatencyDrops): number {
		const now = this.now();
		const tenant = tenantOf(ctx);
		let added = 0;
		for (const sample of samples) {
			const node = this.nodeRoutes.get([tenant, sample.service, sample.environment, sample.route].join("\u0000"));
			if (node !== undefined && node > now - ROUTE_WINDOW_MS) continue;
			if (!this.admitRoute(tenant, sample, now)) {
				drops.overLimit += 1;
				continue;
			}
			const key = JSON.stringify([tenant, sample.service, sample.environment, sample.release, sample.method, sample.route, sample.bucketAtMs]);
			let open = this.open.get(key);
			if (!open) {
				if (this.open.size >= this.maxOpenPoints) {
					drops.overLimit += 1;
					continue;
				}
				open = {
					ctx: { ...ctx },
					ids: new Set(),
					point: {
						pointId: "",
						service: sample.service,
						environment: sample.environment,
						release: sample.release,
						method: sample.method,
						route: sample.route,
						bucketAt: new Date(sample.bucketAtMs),
						requestCount: 0,
						errorCount: 0,
						durationSumMs: 0,
						boundsMs: [...SUMMARY_HISTOGRAM_BOUNDS_MS],
						counts: new Array<number>(SUMMARY_HISTOGRAM_BOUNDS_MS.length + 1).fill(0),
					},
				};
				this.open.set(key, open);
			}
			if (open.ids.has(sample.id)) continue;
			if (open.ids.size < MAX_IDS_PER_POINT) open.ids.add(sample.id);
			const { point } = open;
			const bucket = SUMMARY_HISTOGRAM_BOUNDS_MS.findIndex((bound) => sample.durationMs <= bound);
			point.counts[bucket === -1 ? SUMMARY_HISTOGRAM_BOUNDS_MS.length : bucket]! += 1;
			point.requestCount += 1;
			point.durationSumMs += sample.durationMs;
			if (sample.failed) point.errorCount += 1;
			added += 1;
		}
		return added;
	}

	/**
	 * Write the minutes that are over (all open ones with `all`) and any
	 * earlier write that failed. Never throws: a failed write is kept and
	 * retried on the next flush.
	 */
	flush(options: { all?: boolean } = {}): Promise<void> {
		const run = async () => {
			const now = this.now();
			const byTenant = new Map<string, PendingWrite>();
			for (const [key, open] of this.open) {
				if (!options.all && open.point.bucketAt.getTime() + 60_000 + EDGE_FLUSH_GRACE_MS > now) continue;
				this.open.delete(key);
				open.point.pointId = createHash("sha256")
					.update(JSON.stringify(["edge-summary", this.instance, ++this.sequence, key]))
					.digest("hex");
				const tenant = tenantOf(open.ctx);
				let write = byTenant.get(tenant);
				if (!write) byTenant.set(tenant, (write = { ctx: open.ctx, points: [] }));
				write.points.push(open.point);
			}
			const writes = [...this.pending, ...byTenant.values()];
			this.pending = [];
			for (const write of writes) {
				const token = createHash("sha256").update(write.points.map((p) => p.pointId).join(",")).digest("hex");
				try {
					await this.options.write(write.ctx, write.points, `edge-latency:${token}`);
					if (this.failing) this.log("edge latency histograms: writes recovered");
					this.failing = false;
				} catch (err) {
					if (!this.failing) this.log(`edge latency histograms: write failed, retrying: ${(err as Error)?.message ?? err}`);
					this.failing = true;
					this.pending.push(write);
				}
			}
			// Bounded: the oldest failed writes go first.
			let waiting = this.pending.reduce((n, write) => n + write.points.length, 0);
			while (waiting > this.maxOpenPoints && this.pending.length > 0) {
				waiting -= this.pending.shift()!.points.length;
			}
		};
		// One flush at a time; a flush asked for while one runs follows it.
		const next = (this.flushing ?? Promise.resolve()).then(run, run);
		this.flushing = next;
		void next.finally(() => {
			if (this.flushing === next) this.flushing = null;
		});
		return next;
	}

	private admitRoute(tenant: string, sample: EdgeLatencySample, now: number): boolean {
		const service = [tenant, sample.service, sample.environment].join("\u0000");
		let routes = this.routes.get(service);
		if (!routes) this.routes.set(service, (routes = new Map()));
		if (routes.has(sample.route)) {
			routes.set(sample.route, now);
			return true;
		}
		if (routes.size >= this.routesPerService) {
			for (const [route, at] of routes) if (at <= now - ROUTE_WINDOW_MS) routes.delete(route);
			if (routes.size >= this.routesPerService) return false;
		}
		routes.set(sample.route, now);
		return true;
	}
}
