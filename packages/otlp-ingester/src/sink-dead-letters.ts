/**
 * Dead-lettered sink batches (1.12): the batches the sink webhook gave up
 * on, one row each, with the time range of the signals inside.
 *
 * Every forwarded signal is in ClickHouse before it is queued, so a dead
 * letter loses nothing stored — but the consumer never heard of it. This
 * table says exactly which ranges to replay (`signals_from` .. `signals_to`
 * of `runtime_error_occurrences` / `runtime_metrics_1m` for the tenant), and
 * the batch itself is kept on disk under `<SINK_OUTBOX_DIR>/dead/` (`file`)
 * so it can be re-sent as is: move the file back into the outbox directory
 * and restart the ingester.
 */

export interface SinkDeadLetterRow {
	orgId: string;
	repositoryId: string;
	batchId: string;
	/** sink_overflow | sink_rejected | sink_gave_up (ingest-drops.ts). */
	reason: string;
	occurrences: number;
	metricPoints: number;
	llmCalls: number;
	/** ISO times; null when the batch carried no timestamps. */
	signalsFrom: string | null;
	signalsTo: string | null;
	attempts: number;
	enqueuedAt: string;
	droppedAt: string;
	instanceId: string;
	/** File name under the dead-letter directory; '' when not kept on disk. */
	file: string;
}

/** Migration 0023 / baseline. */
export function sinkDeadLettersTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_sink_dead_letters (
		org_id String, repository_id String,
		batch_id String,
		reason LowCardinality(String),
		occurrences UInt32, metric_points UInt32, llm_calls UInt32,
		signals_from DateTime64(3, 'UTC'), signals_to DateTime64(3, 'UTC'),
		attempts UInt32,
		enqueued_at DateTime64(3, 'UTC'),
		dropped_at DateTime64(3, 'UTC'),
		instance_id String DEFAULT '',
		file String DEFAULT ''
	) ENGINE = ReplacingMergeTree(dropped_at)
	PARTITION BY toYYYYMM(dropped_at)
	ORDER BY (org_id, repository_id, batch_id)
	TTL toDateTime(dropped_at) + INTERVAL 30 DAY`;
}
