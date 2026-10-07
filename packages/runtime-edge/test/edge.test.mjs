import assert from "node:assert/strict";
import { test } from "node:test";
import { withAutter, defineRuntimeErrors, RuntimeError, toClientError } from "../dist/index.js";

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
