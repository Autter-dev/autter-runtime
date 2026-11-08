// Child fixture: an Express app (minimal setup: initAutterServer +
// autterRequests, no error handler) whose promises reject outside the
// request's error path. Prints "PORT <n>" once listening.
//
//   EXPRESS=express|express5   which Express major to load
//   APP_LISTENER=log           the app's own unhandledRejection listener
//                              (the process survives; else it crashes)
//
//   GET /orders/:id   answers 200, then a floating promise started in the
//                     handler rejects after the response
//   GET /carts/:id    async handler that throws after an await (Express 4
//                     ignores the promise: an unhandled rejection; Express 5
//                     answers 500)
import http from "node:http";

const env = process.env;
const { initAutterServer, autterRequests } = await import("../../dist/index.js");
const autter = initAutterServer({
	apiKey: "test-key",
	service: env.SERVICE ?? "express-late",
	endpoint: `http://127.0.0.1:${env.COLLECTOR_PORT}`,
	memoryMetrics: false,
	compatCheck: false,
	metricIntervalMs: 3_600_000,
	logging: { console: false },
});

if (env.APP_LISTENER === "log")
	process.on("unhandledRejection", (reason) => {
		process.stdout.write(`app listener: ${reason instanceof Error ? reason.message : String(reason)}\n`);
	});

const { default: express } = await import(env.EXPRESS ?? "express");
const app = express();
app.use(autterRequests());
app.get("/orders/:id", function lateRejectionHandler(req, res) {
	res.json({ ok: true });
	// Not awaited: rejects after the response has finished.
	void (async function auditOrder() {
		await new Promise((resolve) => setTimeout(resolve, 50));
		throw new TypeError(`audit failed for order ${req.params.id}`);
	})();
});
app.get("/carts/:id", async function asyncThrowHandler() {
	await new Promise((resolve) => setTimeout(resolve, 5));
	throw new RangeError("cart lookup failed");
});

const server = http.createServer(app);
server.listen(0, "127.0.0.1", () => {
	process.stdout.write(`PORT ${server.address().port}\n`);
});

// Survivors flush and exit; a crash ends the process before this.
setTimeout(async () => {
	server.close();
	server.closeAllConnections?.();
	await autter.shutdown();
	process.stdout.write("survived\n");
	process.exit(0);
}, Number(env.LIFETIME_MS ?? 800)).unref?.();
