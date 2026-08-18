import { randomUUID } from "node:crypto";
import type { IngesterConfig } from "./config.js";
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
 * lost batch means silently missing error occurrences — a single
 * fire-and-forget POST is not enough (a routine consumer deploy is longer
 * than one request timeout). Batches therefore queue in memory and retry
 * with exponential backoff until delivered, permanently rejected, or the
 * bounded buffer overflows.
 *
 * Durability boundary: the queue is in-memory only. Everything forwarded
 * here was already written to ClickHouse (ingest 503s otherwise), so after
 * a process crash or an overflow/permanent drop the consumer recovers by
 * replaying the logged time range from ClickHouse — see
 * docs/ARCHITECTURE.md "Sink webhook". Every batch carries a unique
 * `batchId` so consumers can deduplicate retried deliveries.
 */

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

interface QueuedBatch {
	batchId: string;
	/** Tenant that produced the batch — buffer pressure is charged per org. */
	orgId: string;
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

	constructor(
		private readonly config: IngesterConfig,
		private readonly fetchImpl: typeof fetch = fetch,
		tuning: Partial<SinkTuning> = {},
	) {
		this.tuning = { ...DEFAULT_TUNING, ...tuning };
	}

	/** Queue a batch for delivery. No-op when there is nothing to send. */
	enqueue(
		ctx: IngestContext,
		occurrences: RuntimeOccurrence[],
		metricPoints: RuntimeMetricPoint[] = [],
		llmCalls: RuntimeLlmCall[] = [],
	): void {
		if (!this.config.sinkUrl || this.stopped) return;
		if (
			occurrences.length === 0 &&
			metricPoints.length === 0 &&
			llmCalls.length === 0
		) {
			return;
		}
		const batch = this.buildBatch(ctx, occurrences, metricPoints, llmCalls);
		// A batch bigger than the whole buffer could never be admitted without
		// evicting everyone else — and the consumer's body cap would reject it
		// anyway. Drop it alone instead of letting it flush the queue.
		if (batch.bytes > this.maxBufferedBytes()) {
			this.droppedOverflow += 1;
			console.warn(
				`sink batch ${batch.batchId} (org ${batch.orgId}) exceeds the buffer cap (${batch.bytes} bytes) — dropped; replay signals ${batch.signalsFrom ?? "?"} .. ${batch.signalsTo ?? "?"} from ClickHouse`,
			);
			return;
		}
		this.queue.push(batch);
		this.track(batch);
		this.enforceBounds();
		this.pump();
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
		};
	}

	pendingCount(): number {
		return this.queue.length + this.inFlight;
	}

	/** Stop scheduling new deliveries (shutdown). Queued batches are logged
	 * by the caller — they are recoverable from ClickHouse, not from here. */
	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Serialize one delivery payload; `seq` pins its age for ordering. */
	private buildBatch(
		ctx: IngestContext,
		occurrences: RuntimeOccurrence[],
		metricPoints: RuntimeMetricPoint[],
		llmCalls: RuntimeLlmCall[],
	): QueuedBatch {
		const batchId = randomUUID();
		const body = JSON.stringify({
			version: 1,
			batchId,
			orgId: ctx.orgId,
			repositoryId: ctx.repositoryId,
			occurrences: occurrences.map((o) => ({
				...o,
				occurredAt: o.occurredAt.toISOString(),
			})),
			metrics: metricPoints.map((p) => ({
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
				`sink buffer overflow: dropped batch ${dropped.batchId} (org ${dropped.orgId}, signals ${dropped.signalsFrom ?? "?"} .. ${dropped.signalsTo ?? "?"}) — replay this range from ClickHouse`,
			);
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

		if (permanent || batch.attempts >= this.config.sinkMaxAttempts) {
			this.droppedPermanent += 1;
			console.error(
				`sink delivery gave up after ${batch.attempts} attempt(s) (${detail}): batch ${batch.batchId} (signals ${batch.signalsFrom ?? "?"} .. ${batch.signalsTo ?? "?"}) — replay this range from ClickHouse`,
			);
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
				`sink delivery failed (attempt ${batch.attempts}/${this.config.sinkMaxAttempts}, will retry): ${detail}`,
			);
		}
		this.enforceBounds();
		this.scheduleWake();
	}
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
