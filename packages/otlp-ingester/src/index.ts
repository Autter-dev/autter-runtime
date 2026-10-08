import { loadConfig } from "./config.js";
import { createIngesterApp } from "./server.js";
import { ingesterVersion } from "./sdk-versions.js";

const config = loadConfig();
const { app, store, sink, reportIngesterInfo } = createIngesterApp(config);

const server = app.listen(config.port, () => {
	console.log(
		`autter otlp-ingester ${ingesterVersion()} listening on :${config.port} ` +
			`(clickhouse: ${config.clickhouseUrl ? "configured" : "NOT configured"})`,
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
		void store.close().finally(() => process.exit(0));
	});
	setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { createIngesterApp } from "./server.js";
export { loadConfig } from "./config.js";
export * from "./compat.js";
export { SinkForwarder, type SinkStats, type SinkTuning } from "./sink.js";
export * from "./types.js";
