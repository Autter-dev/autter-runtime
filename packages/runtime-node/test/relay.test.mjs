import { test } from "node:test";
import assert from "node:assert/strict";
import {
	sanitizeBrowserPayload,
	createBrowserRelayFetchHandler,
	createBrowserRelayHandler,
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

test("relay: secret-bearing context keys are redacted (top level and nested)", () => {
	const ctx = sanitizeContext({
		password: "hunter2",
		token: "abc",
		authorization: "Bearer x",
		request: { headers: { cookie: "sid=1", authorization: "Bearer victim" } },
		keep: "ok",
	});
	assert.equal(ctx.password, "[redacted]");
	assert.equal(ctx.token, "[redacted]");
	assert.equal(ctx.authorization, "[redacted]");
	assert.equal(ctx.request.headers.cookie, "[redacted]");
	assert.equal(ctx.request.headers.authorization, "[redacted]");
	assert.equal(ctx.keep, "ok");
});

test("relay: secret-shaped values under benign keys are scrubbed", () => {
	// Built at runtime so no JWT-shaped literal sits in source (would trip
	// secret scanners); the parts are meaningless placeholders.
	const jwtLike = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "0".repeat(22)].join(".");
	const ctx = sanitizeContext({
		note: "Bearer supersecrettoken12345",
		jwtish: jwtLike,
		plain: "just a normal message",
	});
	assert.equal(ctx.note, "[redacted]");
	assert.equal(ctx.jwtish, "[redacted]");
	assert.equal(ctx.plain, "just a normal message");
});

test("relay: numeric usage counts under token/session keys are preserved", () => {
	const ctx = sanitizeContext({
		input_tokens: 500,
		output_tokens: 1200,
		total_tokens: 1700,
		sessions: 3,
	});
	assert.deepEqual(ctx, {
		input_tokens: 500,
		output_tokens: 1200,
		total_tokens: 1700,
		sessions: 3,
	});
});

test("relay: oversized body returns 413 even when cancel() never settles", async () => {
	const handler = createBrowserRelayFetchHandler({
		apiKey: "autter_rt_test",
		perIpRateLimit: false,
		maxBodyBytes: 10,
	});
	const big = new Uint8Array(100);
	const body = new ReadableStream({
		pull(controller) {
			controller.enqueue(big);
		},
		cancel() {
			return new Promise(() => {}); // never settles
		},
	});
	const res = await Promise.race([
		handler(
			new Request("http://localhost/relay", {
				method: "POST",
				body,
				duplex: "half",
			}),
		),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("handler hung")), 2000),
		),
	]);
	assert.equal(res.status, 413);
});

test("relay: oversized body stays 413 even when the stream's cancel() rejects", async () => {
	const handler = createBrowserRelayFetchHandler({
		apiKey: "autter_rt_test",
		perIpRateLimit: false,
		maxBodyBytes: 10,
	});
	const big = new Uint8Array(100);
	const body = new ReadableStream({
		pull(controller) {
			controller.enqueue(big);
		},
		cancel() {
			// a hostile/broken stream whose cancel throws must not downgrade 413 to 400
			throw new Error("hostile cancel");
		},
	});
	const res = await handler(
		new Request("http://localhost/relay", {
			method: "POST",
			body,
			duplex: "half",
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

const event = {
	type: "csp_violation",
	timestamp: "2026-01-01T00:00:00.000Z",
	message: "Content Security Policy blocked script-src-elem",
};

test("the relay keeps CSP violations", () => {
	const payload = sanitizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "production",
		events: [event],
	});
	assert.equal(payload?.events[0].type, "csp_violation");
});

test("the relay still rejects an unknown event type", () => {
	assert.equal(sanitizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "production",
		events: [{ ...event, type: "dom_recording" }],
	}), null);
});

test("the relay keeps valid debug ids, query-stripped, and drops the rest", () => {
	const id = "4F3C6A1E-9B2D-4E8F-A1B2-C3D4E5F60718";
	const payload = sanitizeBrowserPayload({
		version: 1, service: "web", environment: "production",
		events: [
			{ type: "exception", timestamp: new Date().toISOString(), message: "boom",
				debugIds: { "https://app.test/assets/app.js?v=1": id, "https://app.test/x.js": "nope", "https://app.test/y.js": 7 } },
			{ type: "exception", timestamp: new Date().toISOString(), message: "boom", debugIds: ["not", "a", "map"] },
		],
	});
	assert.deepEqual(payload.events[0].debugIds, { "https://app.test/assets/app.js": id.toLowerCase() });
	assert.equal("debugIds" in payload.events[1], false);
});

// ── Rate-limit key source (trustProxy) ─────────────────────────────────────
// Each case sends two requests against a limit of 1: the second is 429 when
// both landed in the same bucket, and 400 (past the limit, then invalid JSON)
// when they were keyed apart.

const fetchReq = (xff, extra = {}) => {
	const headers = { ...(xff === undefined ? {} : { "x-forwarded-for": xff }), ...(extra.headers ?? {}) };
	const req = new Request("http://localhost/relay", { method: "POST", headers, body: "{" });
	if (extra.cf) Object.defineProperty(req, "cf", { value: extra.cf });
	return req;
};

async function fetchPair(opts, a, b) {
	const handler = createBrowserRelayFetchHandler({ apiKey: "autter_rt_test", perIpRateLimit: 1, ...opts });
	return [(await handler(a)).status, (await handler(b)).status];
}

test("relay auto: values a caller writes left of the proxy's entry cannot bypass the limit", async () => {
	// A proxy appended 203.0.113.9; the caller rotated what it put in front.
	assert.deepEqual(
		await fetchPair({}, fetchReq("1.1.1.1, 203.0.113.9"), fetchReq("2.2.2.2, 203.0.113.9")),
		[400, 429],
	);
});

test("relay auto: distinct visitors behind a platform proxy keep separate windows", async () => {
	// Vercel-style overwrite: one entry per request.
	assert.deepEqual(await fetchPair({}, fetchReq("198.51.100.1"), fetchReq("198.51.100.2")), [400, 400]);
	// Appended chain behind an internal load balancer: private hops are skipped.
	assert.deepEqual(
		await fetchPair({}, fetchReq("198.51.100.1, 10.0.0.2"), fetchReq("198.51.100.2, 10.0.0.2")),
		[400, 400],
	);
});

test("relay auto: Cloudflare Workers use CF-Connecting-IP only when the runtime set request.cf", async () => {
	const cf = { colo: "LHR" };
	assert.deepEqual(
		await fetchPair(
			{},
			fetchReq("9.9.9.9", { cf, headers: { "cf-connecting-ip": "198.51.100.1" } }),
			fetchReq("9.9.9.9", { cf, headers: { "cf-connecting-ip": "198.51.100.2" } }),
		),
		[400, 400],
	);
	// Without request.cf the header is just something a caller sent.
	assert.deepEqual(
		await fetchPair(
			{},
			fetchReq("9.9.9.9", { headers: { "cf-connecting-ip": "198.51.100.1" } }),
			fetchReq("9.9.9.9", { headers: { "cf-connecting-ip": "198.51.100.2" } }),
		),
		[400, 429],
	);
});

test("relay: trustProxy false keys one shared bucket in fetch runtimes, including the env string", async () => {
	for (const trustProxy of [false, "false", "0"]) {
		assert.deepEqual(
			await fetchPair({ trustProxy }, fetchReq("198.51.100.1"), fetchReq("198.51.100.2")),
			[400, 429],
			`trustProxy ${JSON.stringify(trustProxy)}`,
		);
	}
});

test("relay: trustProxy hop count reads the entry that many from the right", async () => {
	// Two proxies you control appended "client, edge"; the client is 2 from the right.
	assert.deepEqual(
		await fetchPair(
			{ trustProxy: 2 },
			fetchReq("6.6.6.6, 198.51.100.1, 203.0.113.50"),
			fetchReq("7.7.7.7, 198.51.100.1, 203.0.113.50"),
		),
		[400, 429],
	);
	assert.deepEqual(
		await fetchPair({ trustProxy: "2" }, fetchReq("198.51.100.1, 203.0.113.50"), fetchReq("198.51.100.2, 203.0.113.50")),
		[400, 400],
	);
});

test("relay: trustProxy true keeps the leftmost entry", async () => {
	assert.deepEqual(
		await fetchPair({ trustProxy: true }, fetchReq("198.51.100.1, 203.0.113.9"), fetchReq("198.51.100.2, 203.0.113.9")),
		[400, 400],
	);
});

test("relay: a clientIp resolver wins over the header", async () => {
	assert.deepEqual(
		await fetchPair(
			{ clientIp: (r) => r.headers.get("x-test-ip") },
			fetchReq("198.51.100.1", { headers: { "x-test-ip": "a" } }),
			fetchReq("198.51.100.2", { headers: { "x-test-ip": "a" } }),
		),
		[400, 429],
	);
});

function nodeCall(handler, { xff, peer }) {
	return new Promise((resolve) => {
		const req = {
			method: "POST",
			headers: xff ? { "x-forwarded-for": xff } : {},
			socket: { remoteAddress: peer },
			body: "{",
		};
		const res = {
			statusCode: 0,
			setHeader() {},
			end() {
				resolve(this.statusCode);
			},
		};
		handler(req, res);
	});
}

const nodeHandler = (opts = {}) =>
	createBrowserRelayHandler({ apiKey: "autter_rt_test", perIpRateLimit: 1, ...opts });

test("relay (node) auto: a public peer is the visitor, whatever header it sends", async () => {
	const handler = nodeHandler();
	assert.equal(await nodeCall(handler, { xff: "1.1.1.1", peer: "203.0.113.5" }), 400);
	assert.equal(await nodeCall(handler, { xff: "2.2.2.2", peer: "203.0.113.5" }), 429);
	assert.equal(await nodeCall(handler, { xff: "2.2.2.2", peer: "203.0.113.6" }), 400);
});

test("relay (node) auto: behind a proxy on your network, the proxy's entry keys the visitor", async () => {
	const handler = nodeHandler();
	// The load balancer (10.0.0.5) appended 198.51.100.7; the left part is the caller's.
	assert.equal(await nodeCall(handler, { xff: "1.1.1.1, 198.51.100.7", peer: "10.0.0.5" }), 400);
	assert.equal(await nodeCall(handler, { xff: "2.2.2.2, 198.51.100.7", peer: "10.0.0.5" }), 429);
	assert.equal(await nodeCall(handler, { xff: "198.51.100.8", peer: "10.0.0.5" }), 400);
	// IPv4-mapped IPv6 peers count as private too.
	assert.equal(await nodeCall(handler, { xff: "198.51.100.9", peer: "::ffff:10.0.0.5" }), 400);
});

test("relay (node): trustProxy false keys the socket peer", async () => {
	const handler = nodeHandler({ trustProxy: false });
	assert.equal(await nodeCall(handler, { xff: "198.51.100.1", peer: "10.0.0.5" }), 400);
	assert.equal(await nodeCall(handler, { xff: "198.51.100.2", peer: "10.0.0.5" }), 429);
});

test("relay (node): trustProxy 1 behind Cloudflare keys the address Cloudflare appended", async () => {
	const handler = nodeHandler({ trustProxy: 1 });
	// Peer is a Cloudflare edge (public); Cloudflare appended the visitor.
	assert.equal(await nodeCall(handler, { xff: "6.6.6.6, 198.51.100.1", peer: "172.64.0.1" }), 400);
	assert.equal(await nodeCall(handler, { xff: "7.7.7.7, 198.51.100.1", peer: "172.64.0.2" }), 429);
});
