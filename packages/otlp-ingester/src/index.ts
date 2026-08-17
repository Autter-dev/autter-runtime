import { loadConfig } from "./config.js";
import { createIngesterApp } from "./server.js";

const config = loadConfig();
const { app, store, sink } = createIngesterApp(config);

const server = app.listen(config.port, () => {
	console.log(
		`autter otlp-ingester listening on :${config.port} ` +
			`(clickhouse: ${config.clickhouseUrl ? "configured" : "NOT configured"})`,
	);
});

// Warm the schema at boot so the first ingest request doesn't pay for DDL.
if (store.configured) {
	store.ensureSchema().catch((err) => {
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
				`${pending} sink batch(es) undelivered at shutdown — ` +
					`recoverable via ClickHouse replay`,
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
export { SinkForwarder, type SinkStats } from "./sink.js";
export * from "./types.js";
