// RF-04 (Next.js): withAutter wraps a route handler as a request summary and
// answers a thrown error with its own status (so a thrown 4xx keeps its stack
// and stays a 4xx), while Next's control-flow signals (redirect / notFound)
// pass through untouched and are never reported.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { registerAutter, withAutter, RuntimeError } from "../dist/server.js";
import { captureRuntime } from "@autter/runtime-node/testing";

let collector;
let sdk;
let runtime;

before(async () => {
	collector = createServer((_req, res) => res.end("{}"));
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	sdk = registerAutter({
		apiKey: "test-key",
		service: "next-app",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		metricIntervalMs: 3_600_000,
		logging: { console: false },
	});
	runtime = captureRuntime();
});

after(async () => {
	runtime.stop();
	await sdk.shutdown();
	await new Promise((resolve) => collector.close(resolve));
});

test("a thrown coded 4xx is answered as a 4xx with its body, and recorded with its stack", async () => {
	const GET = withAutter(async () => {
		throw new RuntimeError({ status: 404, code: "orders.not_found", message: "No such order", fix: "Check the id" });
	}, { name: "order" });
	const response = await GET(new Request("https://app.test/api/orders/abc"));
	assert.equal(response.status, 404, "the 4xx status is kept, not turned into a 500");
	const body = await response.json();
	assert.equal(body.error.code, "orders.not_found");
	assert.equal(body.error.message, "No such order");
	const occ = runtime.exceptions.find((e) => e.message === "No such order");
	assert.ok(occ, "recorded as an occurrence");
	assert.ok(occ.error instanceof Error && occ.error.stack, "keeps its stack");
	assert.equal(occ.attributes["autter.error.code"], "orders.not_found");
});

test("a Next control-flow signal (redirect) is rethrown and never reported", async () => {
	const before = runtime.exceptions.length;
	const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
	const GET = withAutter(async () => {
		throw redirect;
	}, { name: "guarded" });
	await assert.rejects(GET(new Request("https://app.test/api/guarded")), (error) => error === redirect, "rethrown for Next to answer");
	assert.equal(runtime.exceptions.length, before, "a redirect is not reported as an error");
	// The request it happened in is not marked failed.
	const summary = runtime.operations.find((o) => o.attributes["autter.operation.name"] === "GET guarded");
	if (summary) assert.notEqual(summary.attributes["autter.operation.outcome"], "failed");
});

test("a successful handler is answered unchanged and its request succeeds", async () => {
	const GET = withAutter(async () => Response.json({ ok: true }), { name: "healthy" });
	const response = await GET(new Request("https://app.test/api/healthy"));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
});
