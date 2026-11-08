import { limitsWarning, loadConfig } from "./config.js";
import { createIngesterApp } from "./server.js";
import { ingesterVersion } from "./sdk-versions.js";

const config = loadConfig();
const { app, store, sink, reportIngesterInfo, drops, collapse, limits } = createIngesterApp(config);
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
	store.ensureSchema().then(reportIngesterInfo).catch((err) => {
		console.error(
			"clickhouse schema bootstrap failed (will retry on first ingest):",
			err?.message ?? err,
		);
	});
}

async function shutdown(signal: string) {
	console.log(`${signal} received, shutting down`);
	if (sink) {
		const pending = sink.pendingCount();
		sink.stop();
		if (pending > 0) {
			// The retry buffer is memory-only; everything in it is already in
			// ClickHouse, so the consumer's reconciliation replays it.
			console.warn(
				`${pending} sink batch(es) undelivered at shutdown — recoverable via ClickHouse replay`,
			);
		}
	}
	server.close(() => {
		// Store every loop-collapse window's sample (the minute in progress
		// too), so a deploy loses no folded count; the sink is stopped, so
		// the consumer picks them up from ClickHouse. Then write the
		// rejection/drop counts still buffered (best effort: a failed write
		// is logged, never retried).
		void collapse
			.stop()
			.finally(() => drops.stop())
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
export { SinkForwarder, type SinkDrop, type SinkStats, type SinkTuning } from "./sink.js";
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
export * from "./types.js";
