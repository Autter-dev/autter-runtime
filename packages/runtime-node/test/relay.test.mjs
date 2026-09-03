import { test } from "node:test";
import assert from "node:assert/strict";
import {
	sanitizeBrowserPayload,
	createBrowserRelayFetchHandler,
} from "../dist/index.js";

function sanitizeContext(context) {
	const out = sanitizeBrowserPayload({
		version: 1,
		service: "svc",
		environment: "test",
		events: [{ type: "message", timestamp: "t", context }],
	});
	assert.ok(out, "payload should be valid");
	return out.events[0].context;
}

test("relay: deeply nested context is bounded, not passed through raw", () => {
	let deep = "leaf";
	for (let i = 0; i < 30; i++) deep = { n: deep };
	const ctx = sanitizeContext(deep);
	assert.equal(typeof ctx, "object");
	assert.doesNotThrow(() => JSON.stringify(ctx));
});

test("relay: context strings are length-capped", () => {
	const ctx = sanitizeContext({ big: "x".repeat(9000) });
	assert.equal(ctx.big.length, 4000);
});

test("relay: context arrays are element-capped", () => {
	const ctx = sanitizeContext({ arr: Array.from({ length: 500 }, (_, i) => i) });
	assert.equal(ctx.arr.length, 100);
});

test("relay: cyclic context does not hang or throw", () => {
	const cyclic = { a: 1 };
	cyclic.self = cyclic;
	const ctx = sanitizeContext(cyclic);
	assert.equal(ctx.a, 1);
	assert.equal(ctx.self, undefined);
});

test("relay: non-serialisable context values are dropped", () => {
	const ctx = sanitizeContext({ fn: () => 1, keep: 2 });
	assert.equal(ctx.fn, undefined);
	assert.equal(ctx.keep, 2);
});

test("relay: revoked Proxy context is dropped without throwing", () => {
	const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
	revoke();
	assert.doesNotThrow(() => sanitizeContext(proxy));
});

test("relay: hostile Proxy length trap in context does not throw", () => {
	const hostile = new Proxy([], {
		get(_t, prop) {
			if (prop === "length") throw new Error("boom");
			return undefined;
		},
	});
	assert.doesNotThrow(() => sanitizeContext(hostile));
});

test("relay: hostile Proxy element getter in context does not throw", () => {
	const hostile = new Proxy([1, 2, 3], {
		get(target, prop) {
			if (prop === "0") throw new Error("boom");
			return target[prop];
		},
	});
	assert.doesNotThrow(() => sanitizeContext(hostile));
});

test("relay: fetch size limit counts UTF-8 bytes, not code units", async () => {
	const handler = createBrowserRelayFetchHandler({
		apiKey: "autter_rt_test",
		perIpRateLimit: false,
		maxBodyBytes: 10,
	});
	const body = "அ".repeat(6);
	assert.equal(body.length, 6);
	const res = await handler(
		new Request("http://localhost/relay", { method: "POST", body }),
	);
	assert.equal(res.status, 413);
});

test("relay: fetch handler rejects an oversized body", async () => {
	const handler = createBrowserRelayFetchHandler({
		apiKey: "autter_rt_test",
		perIpRateLimit: false,
		maxBodyBytes: 100,
	});
	const res = await handler(
		new Request("http://localhost/relay", {
			method: "POST",
			body: "a".repeat(500),
		}),
	);
	assert.equal(res.status, 413);
});

test("relay: fetch size limit allows a body within the byte budget", async () => {
	const handler = createBrowserRelayFetchHandler({
		apiKey: "autter_rt_test",
		perIpRateLimit: false,
	});
	const res = await handler(
		new Request("http://localhost/relay", { method: "POST", body: "{" }),
	);
	assert.equal(res.status, 400);
});
