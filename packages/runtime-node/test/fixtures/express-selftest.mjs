// Child fixture: the reported crash. An Express 4 route awaits
// emitLlmSelftestTrace() with no try/catch while every export fails (a
// refused key, a 5xx, an unreachable ingester). Express 4 does not catch a
// rejected async handler, so before the fix the rejection was unhandled and
// Node 22 exited with code 1. With no `unhandledRejection` listener and the
// default `--unhandled-rejections=throw`, the process must survive: the
// route answers with `{ ok: false, errors }`, shutdown resolves, and the
// failure is printed (stderr) instead.
//
//   INGESTER   base URL of the (failing) ingester
import express from "express";
import { initAutterServer, emitLlmSelftestTrace } from "../../dist/index.js";

const runtime = initAutterServer({
	apiKey: "autter_rt_wrong",
	service: "express-selftest",
	endpoint: process.env.INGESTER,
	memoryMetrics: false,
	compatCheck: false,
	metricIntervalMs: 3_600_000,
	logging: { console: false },
});

const app = express();
// Deliberately the unsafe Express 4 pattern from the bug report.
app.get("/api/llm-selftest", async (_req, res) => {
	res.json(await emitLlmSelftestTrace());
});

const server = app.listen(0, "127.0.0.1", async () => {
	const response = await fetch(`http://127.0.0.1:${server.address().port}/api/llm-selftest`);
	const body = await response.json();
	process.stdout.write(
		`${JSON.stringify({
			status: response.status,
			ok: body.ok,
			traceId: body.traceId,
			kinds: body.errors.map((error) => error.kind),
			statuses: body.errors.map((error) => error.status ?? null),
		})}\n`,
	);
	server.close();
	await runtime.shutdown();
	process.stdout.write("survived\n");
});
