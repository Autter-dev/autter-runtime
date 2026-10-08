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
