import assert from "node:assert/strict";
import { test } from "node:test";
import { withAutter, captureEdgeException, defineRuntimeErrors, RuntimeError, toClientError } from "../dist/index.js";

const billing = defineRuntimeErrors("billing", {
	declined: { status: 402, message: "Payment declined", expected: true, why: "Issuer rejected the charge" },
});

function harness() {
	const posts = [];
	const fakeFetch = async (url, init) => {
		posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
		return new Response("{}", { status: 200 });
	};
	const pending = [];
	const ctx = { waitUntil: (promise) => pending.push(promise) };
	const records = () =>
		posts.flatMap((p) => p.body.resourceLogs[0].scopeLogs[0].logRecords).map((r) => ({
			level: r.severityText,
			message: r.body.stringValue,
			attrs: Object.fromEntries(
				r.attributes.map((a) => [
					a.key,
					a.value.stringValue ?? a.value.boolValue ?? a.value.doubleValue ?? a.value.kvlistValue ?? a.value.arrayValue,
				]),
			),
		}));
	return { posts, fakeFetch, ctx, pending, records };
}

test("withAutter emits a request summary, echoes the request id and flushes via waitUntil", async () => {
	const h = harness();
	const worker = withAutter(
		(env) => ({ apiKey: env.AUTTER_RUNTIME_KEY, service: "edge-api", environment: "test", fetch: h.fakeFetch, endpoint: "https://ingest.test/" }),
		async (request, env, _ctx, rt) => {
			rt.set({ tenant: env.TENANT, password: "hunter2" });
			rt.info("routing", { region: "eu" });
			rt.warn("slow upstream", { ms: 900 });
			return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
		},
	);
	assert.equal(typeof worker.fetch, "function");
	const response = await worker.fetch(
		new Request("https://edge.test/orders/123?x=1", { headers: { "x-request-id": "edge-req-0001" } }),
		{ AUTTER_RUNTIME_KEY: "server-key", TENANT: "acme" },
		h.ctx,
	);
	assert.equal(response.headers.get("x-request-id"), "edge-req-0001");
	assert.equal(response.headers.get("access-control-expose-headers"), "x-request-id");
	assert.equal(h.pending.length, 1);
	await Promise.all(h.pending);
	assert.equal(h.posts[0].url, "https://ingest.test/v1/logs");
	assert.equal(h.posts[0].headers.authorization, "Bearer server-key");
	const records = h.records();
	const summary = records.find((r) => r.attrs["autter.event.type"] === "operation");
	assert.equal(summary.attrs["autter.operation.kind"], "request");
	assert.equal(summary.attrs["autter.operation.name"], "GET /orders/:id");
	assert.equal(summary.attrs["http.route"], "/orders/:id");
	assert.equal(summary.attrs["http.response.status_code"], 200);
	assert.equal(summary.attrs["autter.operation.outcome"], "succeeded");
	assert.equal(summary.attrs["autter.request.id"], "edge-req-0001");
	assert.equal(summary.attrs.tenant, "acme");
	assert.equal(summary.attrs.password, "[redacted]");
	assert.equal(summary.attrs["autter.operation.level"], "warning");
	// warn is folded and emitted; info only folded
	assert.equal(records.filter((r) => r.attrs["autter.event.type"] !== "operation").length, 1);
	assert.equal(records.find((r) => r.level === "WARNING").message, "slow upstream");
	const resource = Object.fromEntries(h.posts[0].body.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
	assert.deepEqual(resource, { "service.name": "edge-api", "deployment.environment.name": "test" });
});

test("thrown coded errors become promoted error records; expected ones degrade the request", async () => {
	const h = harness();
	const worker = withAutter(
		{ apiKey: "k", service: "edge-api", fetch: h.fakeFetch, errorResponse: true },
		async (request) => {
			if (request.url.endsWith("/decline")) throw billing.declined({ internal: { bin: "424242" } });
			throw new Error("lookup for person@example.com exploded");
		},
	);
	const declined = await worker(new Request("https://edge.test/decline", { method: "POST" }), {}, h.ctx);
	assert.equal(declined.status, 402);
	const body = await declined.json();
	assert.equal(body.error.code, "billing.declined");
	assert.equal(body.error.requestId, declined.headers.get("x-request-id"));
	const crashed = await worker(new Request("https://edge.test/crash"), {}, h.ctx);
	assert.equal(crashed.status, 500);
	assert.deepEqual((await crashed.json()).error.message, "Internal Server Error");
	await Promise.all(h.pending);
	const records = h.records();
	const promoted = records.filter((r) => r.attrs["autter.capture.mode"] === "log");
	assert.equal(promoted.length, 2);
	const coded = promoted.find((r) => r.attrs["autter.error.code"] === "billing.declined");
	assert.equal(coded.level, "ERROR");
	assert.equal(coded.attrs["exception.type"], "RuntimeError");
	assert.equal(coded.attrs["autter.error.expected"], true);
	assert.equal(coded.attrs["http.route"], "/decline");
	const summaries = records.filter((r) => r.attrs["autter.event.type"] === "operation");
	assert.deepEqual(summaries.map((s) => s.attrs["autter.operation.outcome"]), ["degraded", "failed"]);
	assert.equal(JSON.stringify(h.posts).includes("424242"), false, "internal never exported");
	assert.equal(JSON.stringify(h.posts).includes("person@example.com"), false, "messages are redacted");
});

test("without errorResponse the error is rethrown after recording; ignore and no-key paths", async () => {
	const h = harness();
	const worker = withAutter({ service: "edge-api", fetch: h.fakeFetch, ignore: ["/healthz"] }, async (request) => {
		if (request.url.endsWith("/healthz")) return new Response("ok");
		throw new RuntimeError({ code: "edge.bad", message: "bad" });
	});
	const warn = console.warn;
	console.warn = () => {};
	try {
		await assert.rejects(worker(new Request("https://edge.test/x"), {}, h.ctx), /bad/);
		const health = await worker(new Request("https://edge.test/healthz"), {}, h.ctx);
		assert.equal(health.headers.get("x-request-id"), null);
		await Promise.all(h.pending);
		assert.equal(h.posts.length, 0, "no apiKey → nothing exported");
	} finally {
		console.warn = warn;
	}
	assert.deepEqual(toClientError(new RuntimeError({ code: "edge.bad", message: "bad" })), { error: { message: "bad", code: "edge.bad" } });
});

test("the queue is bounded per isolate", async () => {
	let calls = 0;
	const worker = withAutter(
		{ apiKey: "k", service: "edge-api", maxQueue: 3, fetch: async () => (calls++, new Response("", { status: 503 })) },
		async (_req, _env, _ctx, rt) => {
			for (let i = 0; i < 10; i++) rt.warn(`w${i}`);
			return new Response("ok");
		},
	);
	const warn = console.warn;
	console.warn = () => {};
	try {
		const pending = [];
		await worker(new Request("https://edge.test/"), {}, { waitUntil: (p) => pending.push(p) });
		await Promise.all(pending);
		assert.equal(calls, 2, "one batch of ≤3 records, retried once on 5xx");
	} finally {
		console.warn = warn;
	}
});

test("queued records keep their own destination and are not queued without a key", async () => {
	const posts = [];
	const fakeFetch = async (url, init) => {
		// Hold delivery so both requests' records are queued before any flush.
		await new Promise((resolve) => setTimeout(resolve, 10));
		posts.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
		return new Response("{}", { status: 200 });
	};
	const worker = withAutter(
		(env) => ({ apiKey: env.KEY, service: env.SERVICE, environment: "test", fetch: fakeFetch }),
		async () => new Response("ok"),
	);
	const run = async (env) => {
		const pending = [];
		await worker.fetch(new Request("https://edge.test/a"), env, { waitUntil: (p) => pending.push(p) });
		return pending;
	};
	const pending = [
		...(await run({ SERVICE: "no-key" })),
		...(await run({ KEY: "key-a", SERVICE: "svc-a" })),
		...(await run({ KEY: "key-b", SERVICE: "svc-b" })),
	];
	await Promise.all(pending);
	await worker.flush();
	const service = (post) =>
		post.body.resourceLogs[0].resource.attributes.find((a) => a.key === "service.name").value.stringValue;
	const recordCount = (post) => post.body.resourceLogs[0].scopeLogs[0].logRecords.length;
	// One summary per request: the key-less request's record must not ride
	// along in another request's batch.
	assert.deepEqual(posts.map(recordCount), [1, 1]);
	assert.deepEqual(
		posts.map((p) => [p.auth, service(p)]).sort(),
		[
			["Bearer key-a", "svc-a"],
			["Bearer key-b", "svc-b"],
		],
	);
});

test("the request summary survives a noisy request and a full queue", async () => {
	const h = harness();
	const worker = withAutter(
		{ apiKey: "k", service: "edge-api", fetch: h.fakeFetch, endpoint: "https://ingest.test", maxQueue: 20 },
		async (_request, _env, _ctx, rt) => {
			for (let i = 0; i < 250; i++) rt.warn(`retry ${i}`);
			return new Response("ok");
		},
	);
	await worker.fetch(new Request("https://edge.test/noisy"), {}, h.ctx);
	await Promise.all(h.pending);
	const records = h.records();
	assert.ok(records.length <= 20);
	assert.equal(records.filter((r) => r.attrs["autter.event.type"] === "operation").length, 1);
});

test("hostile attributes never make rt.error or rt.captureException throw", async () => {
	const h = harness();
	const hostile = {};
	Object.defineProperty(hostile, "boom", { enumerable: true, get() { throw new Error("getter"); } });
	const worker = withAutter(
		{ apiKey: "k", service: "edge-api", fetch: h.fakeFetch, endpoint: "https://ingest.test" },
		async (_request, _env, _ctx, rt) => {
			rt.error(new Error("first"), hostile);
			rt.captureException(new Error("second"), hostile);
			return new Response("ok");
		},
	);
	const response = await worker.fetch(new Request("https://edge.test/hostile"), {}, h.ctx);
	assert.equal(response.status, 200);
	await Promise.all(h.pending);
	assert.ok(h.records().some((r) => r.message === "second"));
});

test("captureEdgeException sends one promoted error record outside withAutter", async () => {
	const h = harness();
	function edgeRenderFailure() {
		return new Error("render failed for person@example.com");
	}
	const error = edgeRenderFailure();
	await captureEdgeException(
		{ apiKey: "server-key", service: "web-edge", environment: "test", release: "abc", endpoint: "https://ingest.test/", fetch: h.fakeFetch },
		error,
		{ "next.route_path": "/blog/[slug]", "http.request.method": "GET", "autter.capture.mode": "spoofed", password: "hunter2" },
	);
	assert.equal(h.posts.length, 1);
	assert.equal(h.posts[0].url, "https://ingest.test/v1/logs");
	assert.equal(h.posts[0].headers.authorization, "Bearer server-key");
	const resource = Object.fromEntries(h.posts[0].body.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
	assert.deepEqual(resource, { "service.name": "web-edge", "deployment.environment.name": "test", "service.version": "abc" });
	const [record] = h.records();
	assert.equal(record.level, "ERROR");
	assert.equal(record.attrs["autter.capture.mode"], "log", "SDK-owned keys cannot be overridden");
	assert.equal(record.attrs["exception.type"], "Error");
	assert.match(record.attrs["exception.stacktrace"], /edgeRenderFailure/, "the error's own stack");
	assert.equal(record.attrs["next.route_path"], "/blog/[slug]");
	assert.equal(record.attrs["http.request.method"], "GET");
	assert.equal(record.attrs.password, "[redacted]");
	assert.equal(JSON.stringify(h.posts).includes("person@example.com"), false, "message and stack are redacted");

	// Coded errors keep their code; non-errors still get a stack.
	await captureEdgeException({ apiKey: "k", service: "web-edge", fetch: h.fakeFetch }, billing.declined());
	await captureEdgeException({ apiKey: "k", service: "web-edge", fetch: h.fakeFetch }, "plain failure");
	const [, coded, plain] = h.records();
	assert.equal(coded.attrs["autter.error.code"], "billing.declined");
	assert.equal(plain.attrs["exception.message"], "plain failure");
	assert.ok(plain.attrs["exception.stacktrace"].length > 0);
});

test("captureEdgeException keeps an error from another realm as an error, with its own stack", async () => {
	const h = harness();
	const { runInNewContext } = await import("node:vm");
	const foreign = runInNewContext("(function sandboxedFailure() { return new TypeError('sandboxed boom'); })()");
	assert.equal(foreign instanceof Error, false);
	await captureEdgeException({ apiKey: "k", service: "web-edge", fetch: h.fakeFetch }, foreign);
	const [record] = h.records();
	assert.equal(record.attrs["exception.type"], "TypeError");
	assert.equal(record.attrs["exception.message"], "sandboxed boom");
	assert.match(record.attrs["exception.stacktrace"], /sandboxedFailure/);
});

test("captureEdgeException never rejects: no key, failing fetch, hostile errors", async () => {
	const warn = console.warn;
	const warnings = [];
	console.warn = (message) => warnings.push(message);
	try {
		let calls = 0;
		await captureEdgeException({ service: "web-edge", fetch: async () => (calls++, new Response("{}")) }, new Error("x"));
		assert.equal(calls, 0, "no apiKey → nothing sent");
		await captureEdgeException(
			{ apiKey: "k", service: "web-edge", fetch: async () => (calls++, new Response("", { status: 503 })) },
			new Error("x"),
		);
		assert.equal(calls, 2, "retried once on 5xx");
		await captureEdgeException(
			{ apiKey: "k", service: "web-edge", fetch: async () => { throw new TypeError("network down"); } },
			new Error("x"),
		);
		const hostile = { [Symbol.toPrimitive]() { throw new Error("no string for you"); } };
		await captureEdgeException({ apiKey: "k", service: "web-edge", fetch: async () => new Response("{}") }, hostile);
		assert.ok(warnings.some((w) => /could not be delivered/.test(w)));
	} finally {
		console.warn = warn;
	}
});

test("captureEdgeException skips an error withAutter already captured", async () => {
	const h = harness();
	const thrown = new Error("middleware failed");
	const worker = withAutter({ apiKey: "k", service: "web-edge", fetch: h.fakeFetch }, async () => {
		throw thrown;
	});
	await assert.rejects(worker(new Request("https://edge.test/mw"), {}, h.ctx), /middleware failed/);
	await Promise.all(h.pending);
	const before = h.records().filter((r) => r.attrs["autter.capture.mode"] === "log").length;
	assert.equal(before, 1);
	// e.g. Next.js then calls onRequestError with the same error.
	await captureEdgeException({ apiKey: "k", service: "web-edge", fetch: h.fakeFetch }, thrown);
	await captureEdgeException({ apiKey: "k", service: "web-edge", fetch: h.fakeFetch }, thrown);
	assert.equal(h.records().filter((r) => r.attrs["autter.capture.mode"] === "log").length, 1);
});

test("every record of a request is marked counted by its summary; the summary says when an error was reported", async () => {
	const h = harness();
	const worker = withAutter(
		{ apiKey: "k", service: "edge-api", fetch: h.fakeFetch, sampleRate: 0 },
		async (request, _env, _ctx, rt) => {
			if (request.url.endsWith("/sampled-out")) rt.captureException(new Error("sampled out"));
			if (request.url.endsWith("/warn")) rt.warn("slow");
			if (request.url.endsWith("/throw")) throw new Error("boom");
			return new Response("ok");
		},
	);
	for (const path of ["/ok", "/warn", "/sampled-out"]) await worker(new Request(`https://edge.test${path}`), {}, h.ctx);
	await assert.rejects(worker(new Request("https://edge.test/throw"), {}, h.ctx), /boom/);
	await Promise.all(h.pending);
	const records = h.records();
	assert.ok(records.length >= 6);
	for (const record of records) assert.equal(record.attrs["autter.request.counted_by"], "summary", record.message);
	const summaries = Object.fromEntries(
		records.filter((r) => r.attrs["autter.event.type"] === "operation").map((r) => [r.attrs["http.route"], r.attrs]),
	);
	// A sampled-out captureException reports nothing, so it fails nothing.
	assert.equal(summaries["/sampled-out"]["autter.request.error_reported"], undefined);
	assert.equal(summaries["/ok"]["autter.request.error_reported"], undefined);
	// A thrown error is never sampled out: reported, and the request failed.
	assert.equal(summaries["/throw"]["autter.request.error_reported"], true);
	assert.equal(summaries["/throw"]["autter.operation.outcome"], "failed");
	assert.equal(records.filter((r) => r.attrs["autter.capture.mode"] === "log").length, 1);
});

test("countRequests: false leaves the request uncounted; captureEdgeException is never marked", async () => {
	const h = harness();
	const worker = withAutter(
		{ apiKey: "k", service: "web", fetch: h.fakeFetch, countRequests: false },
		async (_request, _env, _ctx, rt) => {
			rt.captureException(new Error("handled"));
			return new Response("ok");
		},
	);
	await worker(new Request("https://edge.test/mw"), {}, h.ctx);
	await Promise.all(h.pending);
	await captureEdgeException({ apiKey: "k", service: "web-edge", fetch: h.fakeFetch }, new Error("cron failed"));
	const records = h.records();
	assert.equal(records.length, 3);
	for (const record of records) {
		assert.equal(record.attrs["autter.request.counted_by"], undefined, record.message);
		assert.equal(record.attrs["autter.request.error_reported"], undefined, record.message);
	}
});

test("rt.error and console.error of an Error become caught occurrences; a deliberate fallback degrades the request", async () => {
	const h = harness();
	const worker = withAutter(
		{ apiKey: "server-key", service: "edge-api", environment: "test", fetch: h.fakeFetch, endpoint: "https://ingest.test/" },
		async (_request, _env, _ctx, rt) => {
			console.error("db lookup failed", new Error("from console"));
			rt.error(new Error("from rt.error"));
			rt.degraded(new Error("cache miss"), "served stale");
			return new Response("ok");
		},
	);
	await worker.fetch(new Request("https://edge.test/p"), {}, h.ctx);
	await new Promise((resolve) => setTimeout(resolve, 0)); // the console capture defers a tick
	await worker.flush();
	await Promise.all(h.pending);
	const records = h.records();
	const caughtConsole = records.find((r) => r.attrs["exception.message"] === "from console");
	assert.ok(caughtConsole, "console.error(Error) reported");
	assert.equal(caughtConsole.attrs["autter.handled"], true);
	assert.equal(caughtConsole.attrs["autter.handling"], "caught");
	assert.equal(caughtConsole.attrs["autter.log.source"], "console");
	const caughtRt = records.find((r) => r.attrs["exception.message"] === "from rt.error");
	assert.equal(caughtRt.attrs["autter.handling"], "caught");
	const degraded = records.find((r) => r.attrs["exception.message"] === "cache miss");
	assert.equal(degraded.level, "WARNING");
	assert.equal(degraded.attrs["autter.handling"], "deliberate");
	assert.equal(degraded.attrs["autter.degraded.reason"], "served stale");
	const summary = records.find((r) => r.attrs["autter.event.type"] === "operation");
	assert.equal(summary.attrs["autter.operation.outcome"], "degraded");
	// Handled errors don't flag the request as failed.
	assert.ok(!summary.attrs["autter.request.error_reported"], "a caught error does not fail the request");
});

test("captureLoggedErrors is per source: console off, rt.error (runtimeLogger) still a caught occurrence", async () => {
	const h = harness();
	const worker = withAutter(
		{ apiKey: "server-key", service: "edge-api", environment: "test", fetch: h.fakeFetch, endpoint: "https://ingest.test/", captureLoggedErrors: { console: false } },
		async (_request, _env, _ctx, rt) => {
			console.error(new Error("console off"));
			rt.error(new Error("rt caught"));
			return new Response("ok");
		},
	);
	await worker.fetch(new Request("https://edge.test/p"), {}, h.ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await worker.flush();
	await Promise.all(h.pending);
	const records = h.records();
	assert.ok(!records.some((r) => r.attrs["autter.handling"] === "caught" && r.attrs["exception.message"] === "console off"), "console capture off");
	const caught = records.find((r) => r.attrs["exception.message"] === "rt caught" && r.attrs["autter.handling"] === "caught");
	assert.ok(caught, "rt.error (a runtimeLogger source) is still captured");
});
