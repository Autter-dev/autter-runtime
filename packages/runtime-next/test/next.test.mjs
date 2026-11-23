import assert from "node:assert/strict";
import { test } from "node:test";
import * as root from "../dist/index.js";
import * as server from "../dist/server.js";
import * as edge from "../dist/edge.js";

test("server entry re-exports the 1.5.0 runtime-node APIs (root too)", () => {
	for (const name of [
		"withRuntimeRequest",
		"runtimeContext",
		"runInBackground",
		"autterRequests",
		"autterErrorResponse",
		"autterErrorHandler",
		"autterFastifyErrors",
		"autterKoa",
		"captureRequestError",
		"RuntimeError",
		"defineRuntimeErrors",
		"isRuntimeErrorLike",
		"toClientError",
		"initAutterLogging",
		"enrichUserAgent",
		"otlpSink",
		"consoleSink",
		"fileSink",
		"registerAutter",
		"createAutterRelayRoute",
		"withRuntimeOperation",
	]) {
		assert.equal(typeof server[name] === "function" || typeof server[name] === "object", true, name);
		assert.equal(root[name], server[name], name);
	}
});

test("edge entry re-exports @autter/runtime-edge", () => {
	assert.equal(typeof edge.withAutter, "function");
	assert.equal(typeof edge.defineRuntimeErrors, "function");
	assert.equal(typeof edge.toClientError, "function");
});

test("Next withRuntimeRequest works without next installed (after() fails soft)", async () => {
	const handler = server.withRuntimeRequest(
		async () => {
			server.runtimeContext.set({ ok: true });
			return new Response("ok");
		},
		{ name: "ping" },
	);
	const original = console.log;
	console.log = () => {};
	try {
		const response = await handler(new Request("https://app.test/api/ping", { headers: { "x-request-id": "next-req-0001" } }));
		assert.equal(response.headers.get("x-request-id"), "next-req-0001");
		assert.equal(await response.text(), "ok");
	} finally {
		console.log = original;
	}
	// an explicit waitUntil still wins
	const waited = [];
	const explicit = server.withRuntimeRequest(async () => new Response("ok"), { waitUntil: (p) => waited.push(p) });
	console.log = () => {};
	try {
		await explicit(new Request("https://app.test/x"));
	} finally {
		console.log = original;
	}
	assert.equal(waited.length, 1);
});

test("createAutterRelayRoute hands the forward to Next's request-context waitUntil, and an explicit waitUntil wins", async () => {
	const originalFetch = globalThis.fetch;
	let answer;
	globalThis.fetch = () => new Promise((resolve) => (answer = resolve));
	const key = Symbol.for("@next/request-context");
	const fromContext = [];
	globalThis[key] = { get: () => ({ waitUntil: (promise) => fromContext.push(promise) }) };
	const body = () => JSON.stringify({ version: 1, service: "web", environment: "test", events: [{ type: "message", timestamp: new Date().toISOString(), message: "hi" }] });
	try {
		const { POST } = server.createAutterRelayRoute({ apiKey: "autter_rt_test", endpoint: "https://ingest.example.test", perIpRateLimit: false, compatCheck: false });
		const response = await POST(new Request("https://app.test/api/autter-runtime", { method: "POST", body: body() }));
		assert.equal(response.status, 202);
		assert.equal(fromContext.length, 1, "the forward promise was handed over");
		let settled = false;
		void fromContext[0].then(() => (settled = true));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "it settles only when the forward is done");
		answer(new Response(null, { status: 202 }));
		await fromContext[0];
		assert.equal(settled, true);

		const explicit = [];
		const route = server.createAutterRelayRoute({ apiKey: "autter_rt_test", endpoint: "https://ingest.example.test", perIpRateLimit: false, compatCheck: false, waitUntil: (p) => explicit.push(p) });
		await route.POST(new Request("https://app.test/api/autter-runtime", { method: "POST", body: body() }));
		answer(new Response(null, { status: 202 }));
		assert.equal(explicit.length, 1);
		assert.equal(fromContext.length, 1);
		await explicit[0];
	} finally {
		globalThis.fetch = originalFetch;
		delete globalThis[key];
	}
});
