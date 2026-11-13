import { limitsWarning, loadConfig } from "./config.js";
import { createIngesterApp } from "./server.js";
import { ingesterVersion } from "./sdk-versions.js";
import { llmPricesAsOf } from "./llm-pricing.js";

const config = loadConfig();
const { app, store, sink, reportIngesterInfo, drops, collapse, limits, archiver, archiveStatus, edgeLatency } = createIngesterApp(config);
if (config.llmPriceOverrides) {
	console.log(
		`LLM prices: built-in table as of ${llmPricesAsOf()}, ${config.llmPriceOverrides.models.length} model price(s) from AUTTER_LLM_PRICES_FILE (as of ${config.llmPriceOverrides.asOf})`,
	);
}
const sharingWarning = limitsWarning(config);
if (sharingWarning) console.warn(`WARNING: ${sharingWarning}`);

const server = app.listen(config.port, () => {
	console.log(
		`autter otlp-ingester ${ingesterVersion()} listening on :${config.port} ` +
			`(clickhouse: ${config.clickhouseUrl ? "configured" : "NOT configured"}; ` +
			`rate limits: ${limits.mode === "redis" ? "shared (redis)" : `per process, 1/${config.replicas ?? 1} each`})`,
	);
});

// Warm the schema at boot so the first ingest request doesn't pay for DDL.
if (store.configured) {
	store
		.ensureSchema()
		.then(reportIngesterInfo)
		.catch((err) => {
			console.error(
				"clickhouse schema bootstrap failed (will retry on first ingest):",
				err?.message ?? err,
			);
		})
		// Tiered retention: record that an archive is configured and warn when
		// no pass has succeeded for a while (archive.ts), then hourly.
		.finally(() => archiveStatus?.start());
}
if (config.archive && !archiver && !store.configured) {
	console.warn("ARCHIVE_S3_URL is set but CLICKHOUSE_URL is not: nothing to archive");
}
// Tiered retention (archive.ts): the first pass runs a minute after start,
// after the schema warm-up has replaced the archived tables' delete TTL.
archiver?.start();

async function shutdown(signal: string) {
	console.log(`${signal} received, shutting down`);
	server.close(() => {
		// Store every loop-collapse window's sample (the minute in progress
		// too), so a deploy loses no folded count, and queue it for the sink.
		// Then give the sink a few seconds to deliver what is queued; what is
		// left stays in the outbox for the next start (or, without one, in
		// ClickHouse for a replay). Then write the rejection/drop counts still
		// buffered (best effort: a failed write is logged, never retried).
		void collapse
			.stop()
			.then(async () => {
				if (!sink) return;
				const pending = await sink.drain(4_000);
				sink.stop();
				if (pending > 0) {
					console.warn(
						sink.durable
							? `${pending} sink batch(es) undelivered at shutdown — kept in the outbox, sent on the next start`
							: `${pending} sink batch(es) undelivered at shutdown and lost (no SINK_OUTBOX_DIR) — replay from ClickHouse`,
					);
				}
			})
			// Write the edge latency points of the minutes still open.
			.finally(() => edgeLatency.stop())
			.finally(() => drops.stop())
			.finally(() => archiveStatus?.stop())
			.finally(() => archiver?.stop())
			.finally(() => store.close())
			.finally(() => limits.close())
			.finally(() => process.exit(0));
	});
	setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { createIngesterApp } from "./server.js";
export { limitsWarning, loadConfig } from "./config.js";
export {
	addressGroup,
	LruMap,
	MemoryLimitStore,
	RateLimits,
	RedisLimitStore,
	type LimitCheck,
	type LimitDecision,
	type LimitStore,
} from "./limits.js";
export * from "./compat.js";
export { batchIdFor, SINK_BATCH_LIMITS, SinkForwarder, type SinkDrop, type SinkStats, type SinkTuning } from "./sink.js";
export { SinkOutbox, type OutboxRecord, type DeadLetterRecord } from "./sink-outbox.js";
export type { SinkDeadLetterRow } from "./sink-dead-letters.js";
export type { StorageState } from "./health.js";
export {
	collapseIdentity,
	LoopCollapser,
	type CollapsedSample,
	type CollapsePlan,
	type LoopCollapseOptions,
	type LoopCollapseStats,
} from "./loop-collapse.js";
export {
	applySuppression,
	globMatch,
	parseSuppressionRules,
	SUPPRESSION_OPERATORS,
	SUPPRESSION_PROPERTIES,
	type SuppressionAction,
	type SuppressionFilter,
	type SuppressionOperator,
	type SuppressionProperty,
	type SuppressionRule,
} from "./suppression.js";
export {
	DROP_REASONS,
	IngestDropCounter,
	type DropKind,
	type DropReason,
	type DropRoute,
	type IngestDrop,
	type IngestDropRow,
} from "./ingest-drops.js";
export {
	archiveConfigFromEnv,
	archiveObjectPath,
	ARCHIVE_TABLES,
	orgArchiveKey,
	planTableArchive,
	RuntimeArchiver,
	type ArchiveConfig,
	type ArchiveStep,
	type ArchiveTable,
} from "./archive.js";
export * from "./types.js";
