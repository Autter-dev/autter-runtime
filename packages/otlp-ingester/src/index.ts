import { loadConfig } from "./config.js";
import { createIngesterApp } from "./server.js";

const config = loadConfig();
const { app, store } = createIngesterApp(config);

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
	server.close(() => {
		void store.close().finally(() => process.exit(0));
	});
	setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { createIngesterApp } from "./server.js";
export { loadConfig } from "./config.js";
export * from "./types.js";
