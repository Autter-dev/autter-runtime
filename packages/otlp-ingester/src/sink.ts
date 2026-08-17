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

/** Base delay before the second attempt; doubles per attempt up to the cap. */
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Deliveries run concurrently while healthy, serially while failing. */
const HEALTHY_CONCURRENCY = 4;

interface QueuedBatch {
	batchId: string;
	body: string;
	bytes: number;
	/** Delivery attempts made so far. */
	attempts: number;
	nextAttemptAt: number;
	/** ISO range of the signals inside — the replay hint when dropped. */
	signalsFrom: string | null;
	signalsTo: string | null;
	enqueuedAt: number;
}

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
	lastFailureMessage: string | null;
	oldestQueuedSince: string | null;
}

export class SinkForwarder {
	private readonly queue: QueuedBatch[] = [];
	private queuedBytes = 0;
	private inFlight = 0;
	private timer: NodeJS.Timeout | null = null;
	private stopped = false;

	private delivered = 0;
	private retried = 0;
	private droppedOverflow = 0;
	private droppedPermanent = 0;
	private consecutiveFailures = 0;
	private lastFailureAt: string | null = null;
	private lastFailureMessage: string | null = null;

	constructor(
		private readonly config: IngesterConfig,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

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
		const timestamps = [
			...occurrences.map((o) => o.occurredAt),
			...metricPoints.map((p) => p.bucketAt),
			...llmCalls.map((c) => c.startedAt),
		].map((d) => d.getTime());
		const batch: QueuedBatch = {
			batchId,
			body,
			bytes: Buffer.byteLength(body),
			attempts: 0,
			nextAttemptAt: Date.now(),
			signalsFrom: timestamps.length
				? new Date(Math.min(...timestamps)).toISOString()
				: null,
			signalsTo: timestamps.length
				? new Date(Math.max(...timestamps)).toISOString()
				: null,
			enqueuedAt: Date.now(),
		};
		this.queue.push(batch);
		this.queuedBytes += batch.bytes;
		this.enforceBounds();
		this.pump();
	}

	stats(): SinkStats {
		const oldest = this.queue.length
			? Math.min(...this.queue.map((b) => b.enqueuedAt))
			: null;
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
			lastFailureMessage: this.lastFailureMessage,
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

	/** Oldest-first eviction: the freshest signals matter most to grouping,
	 * and older ranges are the ones an operator replays anyway. */
	private enforceBounds(): void {
		const maxBytes = this.config.sinkMaxBufferedMb * 1024 * 1024;
		while (
			this.queue.length > this.config.sinkMaxBufferedBatches ||
			(this.queuedBytes > maxBytes && this.queue.length > 1)
		) {
			const dropped = this.queue.shift();
			if (!dropped) break;
			this.queuedBytes -= dropped.bytes;
			this.droppedOverflow += 1;
			console.warn(
				`sink buffer overflow: dropped batch ${dropped.batchId} ` +
					`(signals ${dropped.signalsFrom ?? "?"} .. ${dropped.signalsTo ?? "?"}) — ` +
					`replay this range from ClickHouse`,
			);
		}
	}

	private pump(): void {
		if (this.stopped || !this.config.sinkUrl) return;
		const limit = this.consecutiveFailures > 0 ? 1 : HEALTHY_CONCURRENCY;
		const now = Date.now();
		while (this.inFlight < limit) {
			const index = this.queue.findIndex((b) => b.nextAttemptAt <= now);
			if (index === -1) break;
			const [batch] = this.queue.splice(index, 1);
			if (!batch) break;
			this.queuedBytes -= batch.bytes;
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
		let failure: string | null = null;
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
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			// Drain the body so keep-alive sockets are reusable.
			await res.text().catch(() => {});
			if (res.ok) {
				this.delivered += 1;
				this.consecutiveFailures = 0;
				return;
			}
			failure = `sink responded ${res.status}`;
			// 4xx (except timeout/rate-limit) means the consumer rejected the
			// batch — retrying the same body cannot succeed.
			permanent = res.status < 500 && res.status !== 408 && res.status !== 429;
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		}

		this.consecutiveFailures += 1;
		this.lastFailureAt = new Date().toISOString();
		this.lastFailureMessage = failure;

		if (permanent || batch.attempts >= this.config.sinkMaxAttempts) {
			this.droppedPermanent += 1;
			console.error(
				`sink delivery gave up after ${batch.attempts} attempt(s) ` +
					`(${failure}): batch ${batch.batchId} ` +
					`(signals ${batch.signalsFrom ?? "?"} .. ${batch.signalsTo ?? "?"}) — ` +
					`replay this range from ClickHouse`,
			);
			return;
		}

		this.retried += 1;
		// Full jitter avoids retry stampedes when the consumer comes back.
		const backoff = Math.min(
			RETRY_CAP_MS,
			RETRY_BASE_MS * 2 ** (batch.attempts - 1),
		);
		batch.nextAttemptAt = Date.now() + backoff / 2 + Math.random() * (backoff / 2);
		this.queue.push(batch);
		this.queuedBytes += batch.bytes;
		if (batch.attempts === 1 || batch.attempts % 5 === 0) {
			console.warn(
				`sink delivery failed (attempt ${batch.attempts}/${this.config.sinkMaxAttempts}, ` +
					`will retry): ${failure}`,
			);
		}
		this.enforceBounds();
		this.scheduleWake();
	}
}
