import { createHash, randomUUID } from "node:crypto";
import type { IngesterConfig } from "./config.js";
import type { OutboxRecord, SinkOutbox } from "./sink-outbox.js";
import type {
	IngestContext,
	RuntimeLlmCall,
	RuntimeMetricPoint,
	RuntimeOccurrence,
} from "./types.js";

/**
 * At-least-once delivery to the sink webhook.
 *
 * The sink feeds the consumer's issue grouping and incident detection, so a
 * lost batch means silently missing error occurrences. Batches queue and
 * retry with exponential backoff until delivered, permanently rejected, too
 * old (SINK_MAX_AGE_HOURS) or out of attempts (SINK_MAX_ATTEMPTS).
 *
 * Durability (1.12): with an outbox (sink-outbox.ts, on by default) every
 * batch is on disk before the ingest request is answered and is deleted
 * only once the webhook accepts it, so a restart or crash resumes delivery
 * instead of losing the queue. A batch given up on is dead-lettered: kept
 * under `<outbox>/dead/`, counted in runtime_ingest_drops (route "sink")
 * and recorded with its signal range in runtime_sink_dead_letters, so it
 * can be re-sent or its range replayed from ClickHouse. Everything
 * forwarded here was already written to ClickHouse (ingest 503s
 * otherwise). Without an outbox (SINK_OUTBOX_DIR=off) the queue is in
 * memory only, as before.
 *
 * `batchId` is derived from the ingest request (its body and tenant) when
 * the caller gives a key, so a request the exporter retries after a lost
 * response produces the same ids and the consumer's batch dedupe drops the
 * repeat. Large batches are split (SINK_BATCH_LIMITS) to stay under the
 * consumer's per-batch caps; each part has its own id.
 */

/** Per-batch caps: the Autter platform's sink route takes at most 2000
 * occurrences and 5000 metric points a batch and silently ignores the rest. */
export const SINK_BATCH_LIMITS = { occurrences: 1000, metricPoints: 2000, llmCalls: 1000 } as const;

/** A stable UUID-shaped id from a key (v4 layout, content-derived). */
export function batchIdFor(key: string): string {
	const hex = createHash("sha256").update(key).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Delivery timing/concurrency knobs; overridable for tests. */
export interface SinkTuning {
	/** Base delay before the second attempt; doubles per attempt to the cap. */
	retryBaseMs: number;
	retryCapMs: number;
	requestTimeoutMs: number;
	/** Deliveries run concurrently while healthy, serially while failing. */
	healthyConcurrency: number;
}

const DEFAULT_TUNING: SinkTuning = {
	retryBaseMs: 1000,
	retryCapMs: 60_000,
	requestTimeoutMs: 10_000,
	healthyConcurrency: 4,
};

/** A batch the sink gave up on (counted in runtime_ingest_drops, route "sink";
 * recorded in runtime_sink_dead_letters). */
export interface SinkDrop {
	orgId: string;
	repositoryId: string;
	/** sink_overflow: buffer overflow, or a batch bigger than the buffer;
	 * sink_rejected: the consumer answered a permanent 4xx;
	 * sink_gave_up: SINK_MAX_ATTEMPTS deliveries failed. */
	reason: "sink_overflow" | "sink_rejected" | "sink_gave_up";
	/** Occurrences in the batch. */
	occurrences: number;
	batchId: string;
	metricPoints: number;
	llmCalls: number;
	signalsFrom: string | null;
	signalsTo: string | null;
	attempts: number;
	enqueuedAt: string;
	droppedAt: string;
	/** Dead-letter file under `<outbox>/dead/`; null without an outbox. */
	file: string | null;
}

interface QueuedBatch {
	batchId: string;
	/** Tenant that produced the batch — buffer pressure is charged per org. */
	orgId: string;
	repositoryId: string;
	/** Occurrences inside (for drop counts). */
	occurrences: number;
	metricPoints: number;
	llmCalls: number;
	body: string;
	bytes: number;
	/** Enqueue order; the queue stays sorted by this so "oldest" is queue[0]. */
	seq: number;
	/** Delivery attempts made so far. */
	attempts: number;
	nextAttemptAt: number;
	/** ISO range of the signals inside — the replay hint when dropped. */
	signalsFrom: string | null;
	signalsTo: string | null;
	enqueuedAt: number;
}

/**
 * Operational counters for /healthz. Failure detail is reduced to a fixed
 * category (`timeout`, `connection_error`, `http_<status>`, `error`) — the
 * health endpoint is unauthenticated, so raw transport/exception text stays
 * in server-side logs only.
 */
export interface SinkStats {
	queued: number;
	queuedBytes: number;
	inFlight: number;
	delivered: number;
	retried: number;
	droppedOverflow: number;
	droppedPermanent: number;
	consecutiveFailures: number;
	lastFailureAt: string | null;
	lastFailureReason: string | null;
	oldestQueuedSince: string | null;
	/** Seconds the oldest undelivered batch has waited: delivery lag. */
	oldestQueuedAgeSeconds: number;
	/** True when batches survive a restart (an outbox is in use). */
	durable: boolean;
	/** Batches loaded from the outbox at startup and sent again. */
	restored: number;
	/** Batches given up on and dead-lettered (all reasons). */
	deadLettered: number;
	/** Dead letters kept on disk now. */
	deadLetterFiles: number;
	/** Batches that could not be written to the outbox (memory only). */
	outboxWriteFailures: number;
}

/** Fixed failure category — safe for the unauthenticated health response. */
function failureReason(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "TimeoutError" || err.name === "AbortError") {
			return "timeout";
		}
		// fetch surfaces DNS/TLS/socket failures as TypeError.
		if (err instanceof TypeError) return "connection_error";
	}
	return "error";
}

export class SinkForwarder {
	/** Always sorted by `seq`: queue[0] is the oldest batch. */
	private readonly queue: QueuedBatch[] = [];
	private queuedBytes = 0;
	/** Per-org share of queuedBytes — overflow evicts from the heaviest org. */
	private readonly queuedBytesByOrg = new Map<string, number>();
	private inFlight = 0;
	private timer: NodeJS.Timeout | null = null;
	private stopped = false;
	private seqCounter = 0;

	private delivered = 0;
	private retried = 0;
	private droppedOverflow = 0;
	private droppedPermanent = 0;
	private consecutiveFailures = 0;
	/**
	 * Bumped on every failure. A success only clears consecutiveFailures if
	 * no failure happened after that request STARTED — a concurrent success
	 * that overlapped a failure proves nothing about current sink health and
	 * must not reopen full concurrency mid-outage.
	 */
	private failureEpoch = 0;
	private lastFailureAt: string | null = null;
	private lastFailureReason: string | null = null;

	private readonly tuning: SinkTuning;
	private readonly outbox: SinkOutbox | null;
	private restored = 0;
	private deadLettered = 0;

	/** Called for every batch given up on; must not throw (errors are swallowed). */
	onDrop: ((drop: SinkDrop) => void) | null = null;

	/**
	 * `outbox`: an opened SinkOutbox whose pending batches are loaded here
	 * and sent again (oldest first); null keeps the queue in memory only.
	 */
	constructor(
		private readonly config: IngesterConfig,
		private readonly fetchImpl: typeof fetch = fetch,
		tuning: Partial<SinkTuning> = {},
		outbox: { outbox: SinkOutbox; pending: OutboxRecord[] } | null = null,
	) {
		this.tuning = { ...DEFAULT_TUNING, ...tuning };
		this.outbox = outbox?.outbox ?? null;
		if (outbox) this.restore(outbox.pending);
	}

	/** Attempts before giving up; 0 = no limit (the age limit still applies).
	 * Default: unlimited with an outbox, 12 (~8 min) without. */
	private maxAttempts(): number {
		return this.config.sinkMaxAttempts ?? (this.outbox ? 0 : 12);
	}

	private maxAgeMs(): number {
		return (this.config.sinkMaxAgeHours ?? 72) * 3_600_000;
	}

	/** Queue the batches a previous process left in the outbox. */
	private restore(records: OutboxRecord[]): void {
		for (const record of records) {
			const batch: QueuedBatch = {
				batchId: record.batchId,
				orgId: record.orgId,
				repositoryId: record.repositoryId,
				occurrences: record.occurrences,
				metricPoints: record.metricPoints ?? 0,
				llmCalls: record.llmCalls ?? 0,
				body: record.body,
				bytes: Buffer.byteLength(record.body),
				seq: record.seq,
				attempts: 0,
				nextAttemptAt: Date.now(),
				signalsFrom: record.signalsFrom,
				signalsTo: record.signalsTo,
				enqueuedAt: record.enqueuedAt,
			};
			this.seqCounter = Math.max(this.seqCounter, record.seq);
			this.queue.push(batch);
			this.track(batch);
			this.restored += 1;
		}
		this.queue.sort((a, b) => a.seq - b.seq);
		if (records.length > 0) {
			console.log(`sink outbox: ${records.length} undelivered batch(es) from the last run queued for delivery`);
			this.enforceBounds();
			this.pump();
		}
	}

	/**
	 * Queue signals for delivery (split into parts under SINK_BATCH_LIMITS).
	 * No-op when there is nothing to send. `batchKey`: what identifies the
	 * ingest request (tenant + body digest), so a retried request yields
	 * the same batch ids; random ids without it.
	 */
	enqueue(
		ctx: IngestContext,
		occurrences: RuntimeOccurrence[],
		metricPoints: RuntimeMetricPoint[] = [],
		llmCalls: RuntimeLlmCall[] = [],
		batchKey?: string,
	): void {
		if (!this.config.sinkUrl || this.stopped) return;
		const parts = Math.max(
			Math.ceil(occurrences.length / SINK_BATCH_LIMITS.occurrences),
			Math.ceil(metricPoints.length / SINK_BATCH_LIMITS.metricPoints),
			Math.ceil(llmCalls.length / SINK_BATCH_LIMITS.llmCalls),
		);
		for (let part = 0; part < parts; part++) {
			const batch = this.buildBatch(
				ctx,
				occurrences.slice(part * SINK_BATCH_LIMITS.occurrences, (part + 1) * SINK_BATCH_LIMITS.occurrences),
				metricPoints.slice(part * SINK_BATCH_LIMITS.metricPoints, (part + 1) * SINK_BATCH_LIMITS.metricPoints),
				llmCalls.slice(part * SINK_BATCH_LIMITS.llmCalls, (part + 1) * SINK_BATCH_LIMITS.llmCalls),
				batchKey ? batchIdFor(`${batchKey}:${part}`) : randomUUID(),
			);
			// A batch bigger than the whole buffer could never be admitted
			// without evicting everyone else — and the consumer's body cap
			// would reject it anyway. Dead-letter it alone instead of letting
			// it flush the queue.
			if (batch.bytes > this.maxBufferedBytes()) {
				this.droppedOverflow += 1;
				console.warn(
					`sink batch ${batch.batchId} (org ${batch.orgId}) exceeds the buffer cap (${batch.bytes} bytes) — dead-lettered; signals ${batch.signalsFrom ?? "?"} .. ${batch.signalsTo ?? "?"}`,
				);
				this.noteDrop(batch, "sink_overflow");
				continue;
			}
			this.outbox?.write(this.record(batch));
			this.queue.push(batch);
			this.track(batch);
		}
		if (parts === 0) return;
		this.enforceBounds();
		this.pump();
	}

	private record(batch: QueuedBatch): OutboxRecord {
		return {
			v: 1,
			seq: batch.seq,
			batchId: batch.batchId,
			orgId: batch.orgId,
			repositoryId: batch.repositoryId,
			occurrences: batch.occurrences,
			metricPoints: batch.metricPoints,
			llmCalls: batch.llmCalls,
			signalsFrom: batch.signalsFrom,
			signalsTo: batch.signalsTo,
			enqueuedAt: batch.enqueuedAt,
			body: batch.body,
		};
	}

	stats(): SinkStats {
		const oldest = this.queue[0]?.enqueuedAt ?? null;
		return {
			queued: this.queue.length,
			queuedBytes: this.queuedBytes,
			inFlight: this.inFlight,
			delivered: this.delivered,
			retried: this.retried,
			droppedOverflow: this.droppedOverflow,
			droppedPermanent: this.droppedPermanent,
			consecutiveFailures: this.consecutiveFailures,
			lastFailureAt: this.lastFailureAt,
			lastFailureReason: this.lastFailureReason,
			oldestQueuedSince: oldest ? new Date(oldest).toISOString() : null,
			oldestQueuedAgeSeconds: oldest ? Math.max(0, Math.round((Date.now() - oldest) / 1000)) : 0,
			durable: this.outbox !== null,
			restored: this.restored,
			deadLettered: this.deadLettered,
			deadLetterFiles: this.outbox?.stats().deadFiles ?? 0,
			outboxWriteFailures: this.outbox?.stats().writeFailures ?? 0,
		};
	}

	/** Give up on a batch: dead-letter it (kept on disk with an outbox) and
	 * report it through onDrop for the counters and the dead-letter table. */
	private noteDrop(batch: QueuedBatch, reason: SinkDrop["reason"]): void {
		this.deadLettered += 1;
		const droppedAt = Date.now();
		let file: string | null = null;
		try {
			file = this.outbox?.deadLetter(this.record(batch), reason, batch.attempts, droppedAt) ?? null;
		} catch {
			// deadLetter never throws by contract; belt and braces.
		}
		try {
			this.onDrop?.({
				orgId: batch.orgId,
				repositoryId: batch.repositoryId,
				reason,
				occurrences: batch.occurrences,
				batchId: batch.batchId,
				metricPoints: batch.metricPoints,
				llmCalls: batch.llmCalls,
				signalsFrom: batch.signalsFrom,
				signalsTo: batch.signalsTo,
				attempts: batch.attempts,
				enqueuedAt: new Date(batch.enqueuedAt).toISOString(),
				droppedAt: new Date(droppedAt).toISOString(),
				file,
			});
		} catch {
			// Drop accounting must never affect delivery.
		}
	}

	pendingCount(): number {
		return this.queue.length + this.inFlight;
	}

	/**
	 * Try to deliver everything queued before shutdown, for up to
	 * `timeoutMs`: waiting backoffs are cut short. Resolves with what is
	 * still undelivered (kept in the outbox when there is one).
	 */
	async drain(timeoutMs: number): Promise<number> {
		if (this.stopped || !this.config.sinkUrl) return this.pendingCount();
		const until = Date.now() + timeoutMs;
		while (this.pendingCount() > 0 && Date.now() < until) {
			const now = Date.now();
			for (const batch of this.queue) batch.nextAttemptAt = Math.min(batch.nextAttemptAt, now);
			this.pump();
			await new Promise((resolve) => setTimeout(resolve, 50));
			// A webhook that keeps failing will not recover in the seconds left.
			if (this.consecutiveFailures >= 3) break;
		}
		return this.pendingCount();
	}

	/** True when queued batches survive a restart. */
	get durable(): boolean {
		return this.outbox !== null;
	}

	/** Stop scheduling new deliveries (shutdown). With an outbox, queued and
	 * in-flight batches stay on disk and are sent by the next process. */
	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.outbox?.close();
	}

	/** Serialize one delivery payload; `seq` pins its age for ordering. */
	private buildBatch(
		ctx: IngestContext,
		occurrences: RuntimeOccurrence[],
		metricPoints: RuntimeMetricPoint[],
		llmCalls: RuntimeLlmCall[],
		batchId: string,
	): QueuedBatch {
		const body = JSON.stringify({
			version: 1,
			batchId,
			orgId: ctx.orgId,
			repositoryId: ctx.repositoryId,
			occurrences: occurrences.map(sinkOccurrence),
			// Latency samples feed runtime_route_latency_1m only (IP-02).
			metrics: metricPoints.map(({ latency: _latency, ...p }) => ({
				...p,
				bucketAt: p.bucketAt.toISOString(),
			})),
			llmCalls: llmCalls.map((c) => ({
				...c,
				startedAt: c.startedAt.toISOString(),
			})),
		});
		const range = signalRange(occurrences, metricPoints, llmCalls);
		return {
			batchId,
			orgId: ctx.orgId,
			repositoryId: ctx.repositoryId,
			occurrences: occurrences.length,
			metricPoints: metricPoints.length,
			llmCalls: llmCalls.length,
			body,
			bytes: Buffer.byteLength(body),
			seq: ++this.seqCounter,
			attempts: 0,
			nextAttemptAt: Date.now(),
			signalsFrom: range.from,
			signalsTo: range.to,
			enqueuedAt: Date.now(),
		};
	}

	private maxBufferedBytes(): number {
		return this.config.sinkMaxBufferedMb * 1024 * 1024;
	}

	private track(batch: QueuedBatch): void {
		this.queuedBytes += batch.bytes;
		this.queuedBytesByOrg.set(
			batch.orgId,
			(this.queuedBytesByOrg.get(batch.orgId) ?? 0) + batch.bytes,
		);
	}

	private untrack(batch: QueuedBatch): void {
		this.queuedBytes -= batch.bytes;
		const left = (this.queuedBytesByOrg.get(batch.orgId) ?? 0) - batch.bytes;
		if (left > 0) this.queuedBytesByOrg.set(batch.orgId, left);
		else this.queuedBytesByOrg.delete(batch.orgId);
	}

	/** Re-insert a retrying batch at its age position (queue is seq-sorted),
	 * so overflow eviction still drops the genuinely oldest signals first. */
	private insertBySeq(batch: QueuedBatch): void {
		const at = this.queue.findIndex((b) => b.seq > batch.seq);
		if (at === -1) this.queue.push(batch);
		else this.queue.splice(at, 0, batch);
	}

	/**
	 * Oldest-first eviction, charged to the heaviest tenant: the freshest
	 * signals matter most to grouping, and one org flooding the shared
	 * buffer must not evict everyone else's batches.
	 */
	private enforceBounds(): void {
		const maxBytes = this.maxBufferedBytes();
		while (
			this.queue.length > this.config.sinkMaxBufferedBatches ||
			(this.queuedBytes > maxBytes && this.queue.length > 1)
		) {
			const dropped = this.evictOne();
			if (!dropped) break;
			this.droppedOverflow += 1;
			console.warn(
				`sink buffer overflow: dead-lettered batch ${dropped.batchId} (org ${dropped.orgId}, signals ${dropped.signalsFrom ?? "?"} .. ${dropped.signalsTo ?? "?"})`,
			);
			this.noteDrop(dropped, "sink_overflow");
		}
	}

	/** The oldest batch of the org holding the most buffered bytes. */
	private evictOne(): QueuedBatch | null {
		let heaviest: string | null = null;
		let heaviestBytes = -1;
		for (const [orgId, bytes] of this.queuedBytesByOrg) {
			if (bytes > heaviestBytes) {
				heaviest = orgId;
				heaviestBytes = bytes;
			}
		}
		const at = heaviest
			? this.queue.findIndex((b) => b.orgId === heaviest)
			: 0;
		const [dropped] = this.queue.splice(at === -1 ? 0 : at, 1);
		if (!dropped) return null;
		this.untrack(dropped);
		return dropped;
	}

	private currentLimit(): number {
		return this.consecutiveFailures > 0 ? 1 : this.tuning.healthyConcurrency;
	}

	private pump(): void {
		if (this.stopped || !this.config.sinkUrl) return;
		const limit = this.currentLimit();
		const now = Date.now();
		while (this.inFlight < limit) {
			const index = this.queue.findIndex((b) => b.nextAttemptAt <= now);
			if (index === -1) break;
			const [batch] = this.queue.splice(index, 1);
			if (!batch) break;
			this.untrack(batch);
			this.inFlight += 1;
			void this.send(batch).finally(() => {
				this.inFlight -= 1;
				this.pump();
			});
		}
		this.scheduleWake();
	}

	private scheduleWake(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.stopped || this.queue.length === 0) return;
		// At capacity there is nothing to wake for: every completion pumps
		// again anyway, and a 0 ms timer here would spin the event loop while
		// a ready batch waits on a slow in-flight request.
		if (this.inFlight >= this.currentLimit()) return;
		const next = Math.min(...this.queue.map((b) => b.nextAttemptAt));
		this.timer = setTimeout(
			() => {
				this.timer = null;
				this.pump();
			},
			Math.max(0, next - Date.now()),
		);
		this.timer.unref();
	}

	private async send(batch: QueuedBatch): Promise<void> {
		batch.attempts += 1;
		const epochAtStart = this.failureEpoch;
		let reason: string | null = null;
		/** Raw failure text — logged server-side, never surfaced in stats. */
		let detail: string | null = null;
		let permanent = false;
		try {
			const res = await this.fetchImpl(this.config.sinkUrl as string, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.config.sinkToken
						? { authorization: `Bearer ${this.config.sinkToken}` }
						: {}),
				},
				body: batch.body,
				signal: AbortSignal.timeout(this.tuning.requestTimeoutMs),
			});
			// Drain the body so keep-alive sockets are reusable; its content is
			// irrelevant to delivery.
			await res.text().catch(() => {});
			if (res.ok) {
				this.delivered += 1;
				this.outbox?.remove(batch);
				if (epochAtStart === this.failureEpoch) {
					this.consecutiveFailures = 0;
				}
				return;
			}
			reason = `http_${res.status}`;
			detail = `sink responded ${res.status}`;
			// 4xx (except timeout/rate-limit) means the consumer rejected the
			// batch — retrying the same body cannot succeed.
			permanent = res.status < 500 && res.status !== 408 && res.status !== 429;
		} catch (err) {
			reason = failureReason(err);
			detail = err instanceof Error ? err.message : String(err);
		}

		this.failureEpoch += 1;
		this.consecutiveFailures += 1;
		this.lastFailureAt = new Date().toISOString();
		this.lastFailureReason = reason;

		const maxAttempts = this.maxAttempts();
		const exhausted =
			(maxAttempts > 0 && batch.attempts >= maxAttempts) ||
			Date.now() - batch.enqueuedAt >= this.maxAgeMs();
		if (permanent || exhausted) {
			this.droppedPermanent += 1;
			console.error(
				`sink delivery gave up after ${batch.attempts} attempt(s) (${detail}): batch ${batch.batchId} (signals ${batch.signalsFrom ?? "?"} .. ${batch.signalsTo ?? "?"}) — dead-lettered`,
			);
			this.noteDrop(batch, permanent ? "sink_rejected" : "sink_gave_up");
			return;
		}

		this.retried += 1;
		// Full jitter avoids retry stampedes when the consumer comes back.
		const backoff = Math.min(
			this.tuning.retryCapMs,
			this.tuning.retryBaseMs * 2 ** (batch.attempts - 1),
		);
		batch.nextAttemptAt = Date.now() + backoff / 2 + Math.random() * (backoff / 2);
		this.insertBySeq(batch);
		this.track(batch);
		if (batch.attempts === 1 || batch.attempts % 5 === 0) {
			console.warn(
				`sink delivery failed (attempt ${batch.attempts}${maxAttempts > 0 ? `/${maxAttempts}` : ""}, will retry): ${detail}`,
			);
		}
		this.enforceBounds();
		this.scheduleWake();
	}
}

/**
 * Wire shape of one occurrence (payload `version: 1`). 1.5.0 adds, all
 * optional and omitted when absent: errorCode, why, fix, link, expected,
 * requestId, traceId, route, method, statusCode, fingerprintScheme. The
 * request-context four were previously spread as `null` when unknown and
 * are now simply left out, matching the documented optional-string shape.
 * 1.6.0 adds `frames` (innermost first, ≤ 50), `fingerprints` (every
 * identity candidate, highest precedence first, ending with the legacy
 * `fingerprint`) and `fingerprintRecord`; `fingerprint`/`fingerprintScheme`
 * keep their legacy meaning. 1.9.0 adds `count`: the occurrences this
 * record stands for, sent only when above 1 (a loop-collapse sample:
 * 1 + collapsedCount, see loop-collapse.ts); consumers add `count ?? 1` to
 * their event counts. Unreleased (RF-06): `fingerprints` may end with a
 * `cause-v1` candidate after the legacy one; consumers that do not know the
 * scheme drop it (the platform validates schemes one by one). RF-05: in-app
 * frames' context lines are up to 5 on each side (3 before). Older consumers
 * ignore unknown keys, so the version stays 1.
 */
export function sinkOccurrence(o: RuntimeOccurrence): Record<string, unknown> {
	const {
		traceId,
		route,
		method,
		statusCode,
		errorCode,
		why,
		fix,
		link,
		expected,
		requestId,
		breadcrumbs,
		frames,
		fingerprints,
		fingerprintRecord,
		// Input-only: locates source maps, never leaves the ingester.
		debugIds: _debugIds,
		collapsedCount,
		...rest
	} = o;
	return {
		...rest,
		occurredAt: o.occurredAt.toISOString(),
		...(traceId ? { traceId } : {}),
		...(route ? { route } : {}),
		...(method ? { method } : {}),
		...(statusCode != null ? { statusCode } : {}),
		...(errorCode ? { errorCode } : {}),
		...(why ? { why } : {}),
		...(fix ? { fix } : {}),
		...(link ? { link } : {}),
		...(expected ? { expected: true } : {}),
		...(requestId ? { requestId } : {}),
		// 1.6.0: steps before the error, oldest first, ≤ 30.
		...(breadcrumbs?.length ? { breadcrumbs } : {}),
		...(frames?.length ? { frames } : {}),
		...(fingerprints?.length ? { fingerprints } : {}),
		...(fingerprintRecord ? { fingerprintRecord } : {}),
		// 1.9.0: a collapsed sample stands for 1 + collapsedCount occurrences.
		...(collapsedCount && collapsedCount > 0 ? { count: 1 + collapsedCount } : {}),
	};
}

/** ISO range across every signal in the batch — the replay hint on drops. */
function signalRange(
	occurrences: RuntimeOccurrence[],
	metricPoints: RuntimeMetricPoint[],
	llmCalls: RuntimeLlmCall[],
): { from: string | null; to: string | null } {
	const timestamps = [
		...occurrences.map((o) => o.occurredAt),
		...metricPoints.map((p) => p.bucketAt),
		...llmCalls.map((c) => c.startedAt),
	].map((d) => d.getTime());
	if (timestamps.length === 0) return { from: null, to: null };
	return {
		from: new Date(Math.min(...timestamps)).toISOString(),
		to: new Date(Math.max(...timestamps)).toISOString(),
	};
}
