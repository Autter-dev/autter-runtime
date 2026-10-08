import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import {
	autterRequests,
	autterErrorResponse,
	autterFastify,
	defineRuntimeErrors,
	runtimeContext,
	withRuntimeOperation,
	withRuntimeRequest,
	enrichUserAgent,
	toClientError,
} from "../dist/index.js";
import { captureRuntime, expectOperation } from "../dist/testing.js";

const billing = defineRuntimeErrors("billing", {
	declined: {
		status: 402,
		message: "Payment declined",
		expected: true,
		why: "The card issuer rejected the charge",
		fix: "Ask the customer for another card",
	},
	limit: ({ plan }) => ({ status: 429, message: `Plan ${plan} limit reached` }),
});

async function listen(app) {
	const server = createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		close: () =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	};
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("express requests: route summary, request id round trip, inline logs, children, CORS expose", async () => {
	const runtime = captureRuntime();
	const app = express();
	app.use(autterRequests({ ignore: ["/healthz"] }));
	app.use(express.json());
	app.get("/healthz", (_req, res) => res.send("ok"));
	app.post("/api/users/:id", async (req, res) => {
		runtimeContext.set({ user: { plan: "pro" }, password: "hunter2" });
		runtimeContext.info("loaded user", { items: req.body.items });
		runtimeContext.debug("cache miss");
		await withRuntimeOperation("load-cart", async (op) => {
			await op.step("db", async () => 1);
			runtimeContext.info("cart loaded");
		});
		res.setHeader("access-control-allow-origin", "https://app.example.com");
		res.json({ requestId: runtimeContext.requestId });
	});
	const server = await listen(app);
	try {
		const honoured = await fetch(`${server.url}/api/users/42`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-request-id": "req-abc-12345" },
			body: JSON.stringify({ items: 3 }),
		});
		assert.equal(honoured.headers.get("x-request-id"), "req-abc-12345");
		assert.match(honoured.headers.get("access-control-expose-headers"), /x-request-id/);
		assert.deepEqual(await honoured.json(), { requestId: "req-abc-12345" });

		const generated = await fetch(`${server.url}/api/users/7`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-request-id": "bad id" },
			body: "{}",
		});
		const generatedId = generated.headers.get("x-request-id");
		assert.match(generatedId, /^[0-9a-f-]{36}$/);
		await (await fetch(`${server.url}/healthz`)).text();
		await settle();

		const request = expectOperation(runtime, "POST /api/users/:id")
			.toHaveKind("request")
			.toHaveOutcome("succeeded")
			.toHaveContext({
				"http.route": "/api/users/:id",
				"http.response.status_code": 200,
				"http.request.method": "POST",
				"autter.request.aborted": false,
			});
		assert.equal(runtime.operations.filter((e) => e.attributes["autter.operation.kind"] === "request").length, 2);
		const first = runtime.byRequestId("req-abc-12345");
		const summary = first.find((e) => e.attributes["autter.operation.kind"] === "request");
		assert.ok(summary);
		assert.deepEqual(summary.attributes.user, { plan: "pro" });
		assert.equal(summary.attributes.password, "[redacted]");
		assert.deepEqual(
			summary.attributes["autter.operation.logs"].map((l) => [l.level, l.message]),
			[["info", "loaded user"], ["debug", "cache miss"]],
		);
		assert.equal(summary.attributes["autter.operation.level"], "info");
		const child = first.find((e) => e.attributes["autter.operation.name"] === "load-cart");
		assert.equal(child.attributes["autter.operation.parent_id"], summary.attributes["autter.operation.id"]);
		assert.equal(child.attributes["autter.request.id"], "req-abc-12345");
		assert.equal(child.attributes["autter.operation.kind"], "operation");
		assert.equal(child.attributes["autter.operation.logs"][0].message, "cart loaded");
		// debug/info folded: no standalone records
		assert.equal(runtime.logs.length, 0);
		assert.ok(runtime.byRequestId(generatedId).length >= 2);
		// health checks are ignored
		assert.equal(runtime.operations.some((e) => String(e.attributes["autter.operation.name"]).includes("healthz")), false);
		assert.ok(request.event.attributes["autter.operation.duration_ms"] >= 0);
	} finally {
		runtime.stop();
		await server.close();
	}
});

test("coded errors: expected → degraded with a client-safe body; unexpected → failed and generic", async () => {
	const runtime = captureRuntime();
	const app = express();
	app.use(autterRequests());
	app.post("/checkout", (_req, _res, next) => {
		runtimeContext.warn("charging card", { attempt: 1 });
		next(billing.declined({ internal: { issuerResponse: "do_not_honor-SECRET" } }));
	});
	app.get("/boom", () => {
		throw new Error("SELECT * FROM users WHERE email='person@example.com' failed");
	});
	app.use(autterErrorResponse());
	const server = await listen(app);
	try {
		const declined = await fetch(`${server.url}/checkout`, {
			method: "POST",
			headers: { "x-request-id": "req-decline-1" },
		});
		assert.equal(declined.status, 402);
		const body = await declined.json();
		assert.deepEqual(body, {
			error: {
				message: "Payment declined",
				code: "billing.declined",
				why: "The card issuer rejected the charge",
				fix: "Ask the customer for another card",
				requestId: "req-decline-1",
			},
		});
		const boom = await fetch(`${server.url}/boom`);
		assert.equal(boom.status, 500);
		const boomBody = await boom.json();
		assert.equal(boomBody.error.message, "Internal Server Error");
		assert.equal(JSON.stringify(boomBody).includes("person@example.com"), false);
		await settle();

		expectOperation(runtime, "POST /checkout")
			.toHaveOutcome("degraded")
			.toHaveErrorCode("billing.declined")
			.toHaveLog("charging card", "warning")
			.toHaveContext({ "autter.error.expected": true, "autter.error.status": 402 });
		expectOperation(runtime, "GET /boom").toHaveOutcome("failed");
		const everything = JSON.stringify(runtime.events);
		assert.equal(everything.includes("do_not_honor-SECRET"), false, "internal never reaches records");
		// warn is folded AND emitted
		assert.ok(runtime.logs.some((e) => e.level === "warning" && e.message === "charging card"));
		// coded and 5xx errors are reported as exceptions, with the request id
		assert.equal(runtime.exceptions.length, 2);
		assert.ok(runtime.exceptions.every((e) => typeof e.requestId === "string"));
		assert.equal(
			runtime.exceptions.find((e) => e.requestId === "req-decline-1").attributes["autter.error.code"],
			"billing.declined",
		);
		assert.equal(JSON.stringify(toClientError(billing.limit({ plan: "free" }))).includes("internal"), false);
	} finally {
		runtime.stop();
		await server.close();
	}
});

test("withRuntimeRequest wraps fetch handlers and hands the flush to waitUntil", async () => {
	const runtime = captureRuntime();
	const waited = [];
	const handler = withRuntimeRequest(
		async (request) => {
			runtimeContext.set({ cart: { items: 2 } });
			if (new URL(request.url).searchParams.has("fail")) throw billing.limit({ plan: "free" });
			return Response.json({ ok: true });
		},
		{ name: "checkout", waitUntil: (promise) => waited.push(promise) },
	);
	const ok = await handler(new Request("https://shop.test/api/checkout", { method: "POST", headers: { "x-request-id": "fetch-req-001" } }));
	assert.equal(ok.headers.get("x-request-id"), "fetch-req-001");
	await assert.rejects(handler(new Request("https://shop.test/api/checkout?fail=1", { method: "POST" })), /limit reached/);
	assert.equal(waited.length, 2);
	await Promise.all(waited);
	const summaries = runtime.operations.filter((e) => e.attributes["autter.operation.name"] === "POST checkout");
	assert.equal(summaries.length, 2);
	assert.equal(summaries[0].attributes["autter.operation.outcome"], "succeeded");
	assert.deepEqual(summaries[0].attributes.cart, { items: 2 });
	assert.equal(summaries[0].attributes["http.route"], "/api/checkout");
	assert.equal(summaries[1].attributes["autter.operation.outcome"], "failed");
	assert.equal(summaries[1].attributes["autter.error.code"], "billing.limit");
	assert.equal(summaries[1].attributes["http.response.status_code"], 500);
	assert.equal(runtime.exceptions.length, 1);
	runtime.stop();
});

test("fastify plugin (structural, no dependency) summarises requests", async () => {
	const runtime = captureRuntime();
	const hooks = {};
	const fastify = { addHook: (name, fn) => (hooks[name] = fn) };
	let registered = false;
	autterFastify(fastify, { ignore: ["/healthz"] }, () => (registered = true));
	assert.ok(registered);
	assert.equal(autterFastify[Symbol.for("skip-override")], true);
	const server = createServer((raw, rawRes) => {
		const headers = {};
		const request = { url: raw.url, method: raw.method, raw, headers: raw.headers, routeOptions: { url: "/items/:id" } };
		const reply = {
			raw: rawRes,
			get statusCode() {
				return rawRes.statusCode;
			},
			header: (k, v) => {
				headers[k] = v;
				rawRes.setHeader(k, v);
			},
			getHeader: (k) => rawRes.getHeader(k),
		};
		hooks.onRequest(request, reply, () => {
			hooks.preHandler(request, reply, () => {
				runtimeContext.set({ item: raw.url });
				if (raw.url.includes("fail")) {
					const error = billing.declined();
					hooks.onError(request, reply, error, () => {
						rawRes.statusCode = 402;
						rawRes.end("declined");
					});
					return;
				}
				rawRes.end("ok");
			});
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}`;
	try {
		const res = await fetch(`${url}/items/9`);
		assert.match(res.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
		await res.text();
		await (await fetch(`${url}/items/fail`)).text();
		await settle();
		const summaries = runtime.operations.filter((e) => e.attributes["autter.operation.name"] === "GET /items/:id");
		assert.deepEqual(summaries.map((e) => e.attributes["autter.operation.outcome"]), ["succeeded", "degraded"]);
		assert.equal(summaries[1].attributes["autter.error.code"], "billing.declined");
	} finally {
		runtime.stop();
		await new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		});
	}
});

test("enrichers add coarse attributes to request summaries", async () => {
	const { initAutterServer } = await import("../dist/index.js");
	const collector = createServer((req, res) => {
		req.resume();
		req.on("end", () => res.end("{}"));
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	const sdk = initAutterServer({
		service: "enrich",
		apiKey: "k",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		logging: { console: false, enrich: [enrichUserAgent()] },
	});
	const runtime = captureRuntime();
	const app = express();
	app.use(autterRequests());
	app.get("/ua", (_req, res) => res.send("ok"));
	const server = await listen(app);
	try {
		await (
			await fetch(`${server.url}/ua`, {
				headers: {
					"user-agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
				},
			})
		).text();
		await settle();
		expectOperation(runtime, "GET /ua").toHaveContext({
			"user_agent.browser": "Chrome 121",
			"user_agent.os": "macOS",
			"user_agent.device": "desktop",
		});
	} finally {
		runtime.stop();
		await server.close();
		await sdk.shutdown();
		await new Promise((resolve) => {
			collector.close(resolve);
			collector.closeAllConnections();
		});
	}
});
