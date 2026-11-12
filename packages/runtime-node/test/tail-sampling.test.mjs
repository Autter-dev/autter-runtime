// Tail sampling (slow traces, LLM content). Head sampling keeps ~1% of
// healthy traces, so the trace behind a latency regression was almost never
// there. By default the SDK now keeps, whole, every unsampled trace whose
// request took longer than its route's rolling p95 and 500 ms (rate
// limited), marks every exported request span with why it was kept
// (`autter.retention_reason`: head / error / slow), and exports LLM spans
// with their token and cost counters always but their prompt and completion
// content only when the call failed or was slow.
//
// initAutterServer runs once per process, so each configuration runs in its
// own child process against a local collector.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeTraces } from "../../otlp-ingester/dist/normalize-otlp.js";

const here = dirname(fileURLToPath(import.meta.url));
const traces = [];
let collector;
let endpoint;

before(async () => {
	const { createServer } = await import("node:http");
	collector = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.url === "/v1/traces") traces.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	endpoint = `http://127.0.0.1:${collector.address().port}`;
});

after(async () => {
	await new Promise((resolve) => {
		collector.close(resolve);
		collector.closeAllConnections();
	});
});

const value = (v) => v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue;
const attrs = (list = []) => Object.fromEntries(list.map((a) => [a.key, value(a.value)]));

/** Every exported span of one service. */
function spansOf(service) {
	const out = [];
	for (const body of traces)
		for (const rs of body.resourceSpans ?? []) {
			if (attrs(rs.resource?.attributes)["service.name"] !== service) continue;
			for (const ss of rs.scopeSpans ?? [])
				for (const span of ss.spans ?? [])
					out.push({
						name: span.name,
						kind: span.kind,
						traceId: span.traceId,
						scope: ss.scope?.name,
						attributes: attrs(span.attributes),
						events: (span.events ?? []).map((e) => ({ name: e.name, attributes: attrs(e.attributes) })),
					});
		}
	return out;
}

function bodiesOf(service) {
	return traces
		.map((body) => ({
			resourceSpans: (body.resourceSpans ?? []).filter(
				(rs) => attrs(rs.resource?.attributes)["service.name"] === service,
			),
		}))
		.filter((body) => body.resourceSpans.length > 0);
}

const requestSpans = (service) =>
	spansOf(service).filter((s) => s.kind === 2 && s.scope === "@opentelemetry/instrumentation-http");
const byPath = (spans, path) => spans.filter((s) => s.attributes["http.target"] === path);

/**
 * Runs an Express app with the given SDK options in a child process; `body`
 * is the code that drives it (`get(path)` resolves when the response ended).
 * Routes: /fast, /slow/:ms (waits ms, opens a child span), /fail (500),
 * /wait/:id?ms (waits ms).
 */
async function runApp(service, options, body) {
	const script = `
		import { createRequire } from "node:module";
		import { trace } from "@opentelemetry/api";
		import { initAutterServer } from "./dist/index.js";
		const require = createRequire(import.meta.url);
		const sdk = initAutterServer({
			apiKey: "k", service: ${JSON.stringify(service)}, endpoint: process.env.ENDPOINT,
			captureGlobalErrors: false, autoFlush: false, memoryMetrics: false, compatCheck: false,
			metricIntervalMs: 3_600_000, logging: { console: false },
			...${JSON.stringify(options)},
		});
		const express = require("express");
		const http = require("http");
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const app = express();
		app.get("/fast", (req, res) => res.send("ok"));
		app.get("/slow/:ms", async (req, res) => {
			await trace.getTracer("app").startActiveSpan("load", async (span) => {
				await sleep(Number(req.params.ms));
				span.end();
			});
			res.send("ok");
		});
		app.get("/other/:ms", async (req, res) => {
			await sleep(Number(req.params.ms));
			res.send("ok");
		});
		app.get("/fail", (req, res) => res.status(500).send("no"));
		const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
		const base = "http://127.0.0.1:" + server.address().port;
		const get = (path) => new Promise((resolve, reject) =>
			http.get(base + path, (r) => { r.resume(); r.on("end", resolve); }).on("error", reject));
		${body}
		server.close();
		await sdk.shutdown();
	`;
	await runScript(script);
}

function runScript(script) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			cwd: join(here, ".."),
			env: { ...process.env, ENDPOINT: endpoint },
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
	});
}

test("by default an unsampled slow request is kept whole and marked slow; fast ones are not", async () => {
	await runApp("tail-default", { traceSampleRate: 0 }, `
		await Promise.all([get("/fast"), get("/fast"), get("/fast")]);
		await get("/slow/650");
		await get("/slow/50");
		await get("/fail");
	`);
	const spans = requestSpans("tail-default");
	assert.equal(byPath(spans, "/fast").length, 0, "fast unsampled requests are not exported");
	assert.equal(byPath(spans, "/slow/50").length, 0, "a request under the 500 ms floor is not slow");
	const [slow] = byPath(spans, "/slow/650");
	assert.ok(slow, "the slow request was retained");
	assert.equal(slow.attributes["autter.retention_reason"], "slow");
	assert.equal(slow.attributes["autter.tail_retained"], true);
	// The whole local trace, not only the request span.
	const child = spansOf("tail-default").find((s) => s.name === "load" && s.traceId === slow.traceId);
	assert.ok(child, "the slow request's child span was retained with it");
	assert.equal(child.attributes["autter.retention_reason"], "slow");
	const [failed] = byPath(spans, "/fail");
	assert.equal(failed?.attributes["autter.retention_reason"], "error");
});

test("head-sampled traces say so", async () => {
	await runApp("tail-head", { traceSampleRate: 1 }, `await get("/fast");`);
	const [span] = byPath(requestSpans("tail-head"), "/fast");
	assert.equal(span?.attributes["autter.retention_reason"], "head");
	assert.equal(span?.attributes["autter.tail_retained"], undefined);
});

test("retainTracesAboveMs: false (or 0) turns slow retention off", async () => {
	await runApp("tail-off", { traceSampleRate: 0, retainTracesAboveMs: false }, `await get("/slow/600");`);
	await runApp("tail-off-0", { traceSampleRate: 0, retainTracesAboveMs: 0 }, `await get("/slow/600");`);
	assert.equal(requestSpans("tail-off").length, 0);
	assert.equal(requestSpans("tail-off-0").length, 0);
});

test("a positive retainTracesAboveMs is a fixed threshold, below the default floor too", async () => {
	await runApp("tail-fixed", { traceSampleRate: 0, retainTracesAboveMs: 100 }, `
		await get("/slow/10");
		await get("/slow/200");
	`);
	const spans = requestSpans("tail-fixed");
	assert.equal(byPath(spans, "/slow/10").length, 0);
	assert.equal(byPath(spans, "/slow/200")[0]?.attributes["autter.retention_reason"], "slow");
});

test("slow traces are rate limited per process and per route", async () => {
	// A budget of 2 a minute: bursts of 2 per process, 1 per route.
	await runApp("tail-limit", { traceSampleRate: 0, retainSlowTracesPerMinute: 2 }, `
		await Promise.all([get("/slow/600"), get("/slow/601"), get("/slow/602"), get("/other/600"), get("/other/601")]);
	`);
	const spans = requestSpans("tail-limit");
	const route = (s) => s.attributes["http.route"];
	assert.equal(spans.filter((s) => route(s) === "/slow/:ms").length, 1, "one slow trace for /slow/:ms");
	assert.equal(spans.filter((s) => route(s) === "/other/:ms").length, 1, "the other route still gets one");
});

test("the threshold follows the route's own p95 once it has traffic", async () => {
	// 30 requests at ~700 ms make that the route's normal: the floor alone
	// would keep them all, the route's p95 keeps only clearly slower ones.
	await runApp("tail-adaptive", { traceSampleRate: 0, retainSlowTracesPerMinute: 6000 }, `
		await Promise.all(Array.from({ length: 30 }, () => get("/other/700")));
		await new Promise((resolve) => setTimeout(resolve, 400)); // refill the route's budget
		await get("/other/710");
		await get("/other/1600");
	`);
	const spans = requestSpans("tail-adaptive");
	assert.equal(byPath(spans, "/other/710").length, 0, "a normal request for this route is not slow");
	assert.equal(byPath(spans, "/other/1600")[0]?.attributes["autter.retention_reason"], "slow");
});

/** LLM spans the way the Vercel AI SDK emits them, plus a GenAI event. */
const LLM_SCRIPT = `
	const tracer = trace.getTracer("ai");
	const call = (name, { ms = 5, error = false } = {}) => {
		const span = tracer.startSpan("ai.generateText.doGenerate", {
			startTime: new Date(Date.now() - ms),
			attributes: {
				"ai.model.id": "gpt-4o-mini", "ai.model.provider": "openai.chat",
				"ai.prompt.messages": JSON.stringify([{ role: "user", content: "prompt " + name }]),
				"ai.telemetry.metadata.userId": "user-1",
			},
		});
		span.setAttributes({
			"ai.response.text": "completion " + name, "ai.response.finishReason": "stop",
			"ai.usage.promptTokens": 1000, "ai.usage.completionTokens": 200, "gen_ai.request.model": "gpt-4o-mini",
		});
		span.addEvent("gen_ai.user.message", { content: "prompt " + name });
		span.setAttribute("autter.test.name", name);
		if (error) span.setStatus({ code: 2, message: "rate limited" });
		span.end();
	};
	call("fast");
	call("failed", { error: true });
	// Over the 20 s absolute threshold: a model with few calls has no p95 yet.
	call("slow", { ms: 25_000 });
	call("seconds", { ms: 4000 });
`;

async function runLlm(service, options) {
	await runScript(`
		import { trace } from "@opentelemetry/api";
		import { initAutterServer, trackLlmCall } from "./dist/index.js";
		const sdk = initAutterServer({
			apiKey: "k", service: ${JSON.stringify(service)}, endpoint: process.env.ENDPOINT,
			captureGlobalErrors: false, autoFlush: false, memoryMetrics: false, compatCheck: false,
			metricIntervalMs: 3_600_000, logging: { console: false }, traceSampleRate: 0,
			...${JSON.stringify(options)},
		});
		${LLM_SCRIPT}
		trackLlmCall({
			provider: "anthropic", model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 3, durationMs: 20,
			attributes: { "gen_ai.input.messages": "[{\\"role\\":\\"user\\"}]", "autter.test.name": "tracked" },
		});
		await sdk.shutdown();
	`);
	const spans = spansOf(service);
	const named = (name) => spans.find((s) => s.attributes["autter.test.name"] === name);
	return { spans, named };
}

test("LLM spans keep counters always and prompt/completion content only when failed or slow", async () => {
	const { named } = await runLlm("llm-default", {});
	const fast = named("fast");
	assert.ok(fast, "every LLM call is exported");
	assert.equal(fast.attributes["autter.llm.content"], "omitted");
	for (const key of ["ai.prompt.messages", "ai.response.text"]) assert.equal(fast.attributes[key], undefined, key);
	assert.deepEqual(fast.events.map((e) => e.name), [], "GenAI message events are dropped");
	// Counters, model, finish reason and telemetry metadata stay.
	assert.equal(Number(fast.attributes["ai.usage.promptTokens"]), 1000);
	assert.equal(Number(fast.attributes["ai.usage.completionTokens"]), 200);
	assert.equal(fast.attributes["ai.model.id"], "gpt-4o-mini");
	assert.equal(fast.attributes["ai.response.finishReason"], "stop");
	assert.equal(fast.attributes["ai.telemetry.metadata.userId"], "user-1");

	const failed = named("failed");
	assert.equal(failed.attributes["autter.llm.content"], "error");
	assert.match(String(failed.attributes["ai.prompt.messages"]), /prompt failed/);
	assert.equal(failed.attributes["ai.response.text"], "completion failed");
	assert.deepEqual(failed.events.map((e) => e.name), ["gen_ai.user.message"]);

	const slow = named("slow");
	assert.equal(slow.attributes["autter.llm.content"], "slow");
	assert.equal(slow.attributes["ai.response.text"], "completion slow");
	// A few seconds is a normal LLM call, not a slow one, at low volume.
	assert.equal(named("seconds").attributes["autter.llm.content"], "omitted");

	const tracked = named("tracked");
	assert.equal(tracked.attributes["gen_ai.input.messages"], undefined);
	assert.equal(tracked.attributes["autter.llm.content"], "omitted");
	assert.equal(Number(tracked.attributes["gen_ai.usage.input_tokens"]), 10);
});

test("the ingester still extracts tokens and cost from LLM spans without content", async () => {
	await runLlm("llm-ingest", {});
	const calls = bodiesOf("llm-ingest").flatMap((body) => normalizeTraces(body).llmCalls);
	const vercel = calls.filter((c) => c.provider === "openai");
	assert.equal(vercel.length, 4);
	for (const call of vercel) {
		assert.equal(call.inputTokens, 1000);
		assert.equal(call.outputTokens, 200);
		assert.equal(call.model, "gpt-4o-mini");
		assert.equal(call.userId, "user-1");
		assert.ok(call.costUsd > 0, "cost is estimated from the tokens");
	}
	const fast = vercel.find((c) => c.status === "ok" && c.attributes?.["autter.llm.content"] === "omitted");
	assert.ok(fast, "the stripped call is stored, marked omitted");
	assert.equal(fast.attributes["ai.prompt.messages"], undefined);
	assert.equal(vercel.filter((c) => c.status === "error").length, 1);
	const tracked = calls.find((c) => c.provider === "anthropic");
	assert.deepEqual([tracked?.inputTokens, tracked?.outputTokens], [10, 3]);
});

test('llmContent: "always" keeps every call\'s content; "never" drops it, failed calls too', async () => {
	const always = await runLlm("llm-always", { llmContent: "always" });
	assert.equal(always.named("fast").attributes["ai.response.text"], "completion fast");
	assert.equal(always.named("fast").attributes["autter.llm.content"], undefined);
	assert.equal(always.named("tracked").attributes["gen_ai.input.messages"], '[{"role":"user"}]');

	const never = await runLlm("llm-never", { llmContent: "never" });
	for (const name of ["fast", "failed", "slow", "seconds", "tracked"]) {
		assert.equal(never.named(name).attributes["autter.llm.content"], "omitted", name);
	}
	assert.equal(never.named("failed").attributes["ai.response.text"], undefined);
});

test("a slow request keeps all its child spans while many concurrent requests fill the buffer", async () => {
	// One slow request starts first; while it runs, 120 concurrent requests
	// each finish 100 child spans (12,000 buffered spans: over the buffer's
	// budget) before any of them ends. The oldest in-flight trace, the one
	// most likely to end slow, must not be the one evicted.
	await runScript(`
		import { context, trace, SpanKind } from "@opentelemetry/api";
		import { initAutterServer } from "./dist/index.js";
		const sdk = initAutterServer({
			apiKey: "k", service: "tail-concurrent", endpoint: process.env.ENDPOINT,
			captureGlobalErrors: false, autoFlush: false, memoryMetrics: false, compatCheck: false,
			metricIntervalMs: 3_600_000, logging: { console: false }, traceSampleRate: 0,
		});
		const tracer = trace.getTracer("app");
		const t0 = Date.now();
		const request = (route, at) => tracer.startSpan("GET " + route, {
			kind: SpanKind.SERVER, startTime: at,
			attributes: { "http.method": "GET", "http.request.method": "GET", "http.route": route, "http.target": route },
		});
		const children = (root, n, label) => {
			const ctx = trace.setSpan(context.active(), root);
			for (let i = 0; i < n; i++) tracer.startSpan(label + " " + i, {}, ctx).end();
		};
		const slow = request("/report", t0);
		children(slow, 100, "report-step");
		const others = [];
		for (let r = 0; r < 120; r++) {
			const root = request("/items", t0 + 1 + r);
			children(root, 100, "item-step");
			others.push(root);
		}
		slow.end(t0 + 1500);
		for (const root of others) root.end(t0 + 50);
		await sdk.shutdown();
	`);
	const spans = spansOf("tail-concurrent");
	const root = spans.find((s) => s.name === "GET /report");
	assert.ok(root, "the slow request was kept");
	assert.equal(root.attributes["autter.retention_reason"], "slow");
	const kept = spans.filter((s) => s.traceId === root.traceId && s.name.startsWith("report-step"));
	assert.equal(kept.length, 100, "every child span of the slow request was kept");
	assert.equal(spans.filter((s) => s.name.startsWith("item-step")).length, 0, "fast requests are not exported");
});

test("a trace over the per-trace span cap is dropped whole, never exported in part", async () => {
	await runScript(`
		import { context, trace, SpanKind } from "@opentelemetry/api";
		import { initAutterServer } from "./dist/index.js";
		const sdk = initAutterServer({
			apiKey: "k", service: "tail-cap", endpoint: process.env.ENDPOINT,
			captureGlobalErrors: false, autoFlush: false, memoryMetrics: false, compatCheck: false,
			metricIntervalMs: 3_600_000, logging: { console: false }, traceSampleRate: 0,
		});
		const tracer = trace.getTracer("app");
		const t0 = Date.now();
		const root = tracer.startSpan("GET /huge", { kind: SpanKind.SERVER, startTime: t0,
			attributes: { "http.method": "GET", "http.route": "/huge", "http.target": "/huge" } });
		const ctx = trace.setSpan(context.active(), root);
		for (let i = 0; i < 600; i++) tracer.startSpan("huge-step " + i, {}, ctx).end();
		root.end(t0 + 1500);
		await sdk.shutdown();
	`);
	assert.equal(spansOf("tail-cap").length, 0);
});
