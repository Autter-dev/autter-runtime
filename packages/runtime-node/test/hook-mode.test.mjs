import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { initAutterServer, runtimeContext } from "../dist/index.js";
import { captureRuntime, expectOperation } from "../dist/testing.js";

test("logging.requests (experimental hook mode) summarises plain node:http requests", async () => {
	const collector = createServer((req, res) => {
		req.resume();
		req.on("end", () => res.end("{}"));
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	const sdk = initAutterServer({
		service: "hook",
		apiKey: "k",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		logging: { console: false, requests: true },
	});
	const runtime = captureRuntime();
	// required after init so the HTTP instrumentation (CJS hook) patches it.
	const { createServer: create } = createRequire(import.meta.url)("http");
	const app = create((req, res) => {
		runtimeContext.set({ path: req.url });
		res.statusCode = req.url === "/fail" ? 503 : 200;
		res.end("ok");
	});
	await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
	try {
		const base = `http://127.0.0.1:${app.address().port}`;
		const ok = await fetch(`${base}/orders/123`, { headers: { "x-request-id": "hook-req-0001" } });
		assert.equal(ok.headers.get("x-request-id"), "hook-req-0001");
		await ok.text();
		await (await fetch(`${base}/fail`)).text();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expectOperation(runtime, "GET /orders/:id").toHaveKind("request").toHaveRequestId("hook-req-0001").toHaveOutcome("succeeded");
		expectOperation(runtime, "GET /fail").toHaveOutcome("failed").toHaveContext({ "http.response.status_code": 503 });
	} finally {
		runtime.stop();
		await new Promise((resolve) => {
			app.close(resolve);
			app.closeAllConnections();
		});
		await sdk.shutdown();
		await new Promise((resolve) => {
			collector.close(resolve);
			collector.closeAllConnections();
		});
	}
});
