import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
	initAutterServer,
	withRuntimeOperation,
	runtimeContext,
	runInBackground,
	withLlmCall,
	trackLlmCall,
	captureException,
	defineRuntimeErrors,
	RuntimeError,
	flushRuntimeLogs,
} from "../dist/index.js";
import { captureRuntime, expectOperation, memorySink } from "../dist/testing.js";

const inventory = defineRuntimeErrors("inventory", {
	reservation_timeout: { status: 503, message: "Reservation timed out", why: "Warehouse API slow", fix: "Retry later" },
});

async function collector() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			requests.push({ path: req.url, body: body ? JSON.parse(body) : null });
			res.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		requests,
		endpoint: `http://127.0.0.1:${server.address().port}`,
		spans: () =>
			requests
				.filter((r) => r.path === "/v1/traces")
				.flatMap((r) => r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))),
		close: () =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	};
}
const attrs = (list = []) =>
	Object.fromEntries(
		list.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue]),
	);

test("fork captures the parent at call time, even after the parent sealed; runInBackground swallows errors", async () => {
	const runtime = captureRuntime();
	let late;
	let parentId;
	let background;
	await withRuntimeOperation("parent", async () => {
		parentId = runtimeContext.id;
		late = new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
			runtimeContext.fork("late-child", async () => "done"),
		);
		background = runInBackground("background", async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			throw new Error("background failure");
		});
	});
	assert.equal(await late, "done");
	assert.equal(await background, undefined);
	expectOperation(runtime, "late-child").toHaveContext({ "autter.operation.parent_id": parentId });
	expectOperation(runtime, "background")
		.toHaveOutcome("failed")
		.toHaveContext({ "autter.operation.parent_id": parentId });
	// A plain withRuntimeOperation after seal keeps 1.4.0 semantics (no link).
	runtime.stop();
});

test("carrier round trip links parent, request id and the producer trace", async () => {
	const c = await collector();
	const sdk = initAutterServer({
		service: "queue",
		apiKey: "k",
		endpoint: c.endpoint,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		logging: { console: false },
	});
	const runtime = captureRuntime();
	try {
		let carrier;
		let producerId;
		let producerTrace;
		await withRuntimeOperation("enqueue", async () => {
			producerId = runtimeContext.id;
			carrier = JSON.stringify(runtimeContext.carrier());
		});
		producerTrace = JSON.parse(carrier).traceparent.split("-")[1];
		assert.equal(JSON.parse(carrier).v, 1);
		await withRuntimeOperation("consume", async () => {}, {}, { from: carrier });
		expectOperation(runtime, "consume").toHaveContext({
			"autter.operation.parent_id": producerId,
			"autter.parent_trace_id": producerTrace,
		});
		await sdk.shutdown();
		const consume = c.spans().find((s) => s.name === "consume");
		assert.ok(consume, "consumer span exported");
		assert.equal(consume.links[0].traceId, producerTrace);
		assert.notEqual(consume.traceId, producerTrace);
	} finally {
		runtime.stop();
		await c.close();
	}
});

test("coded errors on spans: autter.error.* on span and event, internal on the span only", async () => {
	const c = await collector();
	const sdk = initAutterServer({
		service: "errors",
		apiKey: "k",
		endpoint: c.endpoint,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		logging: { console: false },
	});
	const runtime = captureRuntime();
	try {
		await withRuntimeOperation("reserve", async () => {
			const error = new RuntimeError({
				code: "inventory.reservation_timeout",
				message: "Reservation timed out",
				why: "Warehouse API slow",
				internal: { sku: "SKU-1", token: "sk-abcdefghijklmnopqrstuvwxyz" },
				cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
			});
			captureException(error);
			runtimeContext.outcome("degraded", "Served cached stock");
		});
		class LegacyError extends Error {
			constructor() {
				super("legacy");
				this.code = "legacy.thing_failed";
				this.fix = "Do the thing";
			}
		}
		captureException(new LegacyError());
		await flushRuntimeLogs();
		await sdk.shutdown();
		const spans = c.spans();
		const reserve = spans.find((s) => s.events?.some((e) => e.name === "exception" && attrs(e.attributes)["exception.message"] === "Reservation timed out"));
		assert.ok(reserve);
		const spanAttrs = attrs(reserve.attributes);
		assert.equal(spanAttrs["autter.error.code"], "inventory.reservation_timeout");
		assert.equal(spanAttrs["autter.error.why"], "Warehouse API slow");
		assert.match(spanAttrs["autter.error.internal"], /SKU-1/);
		assert.equal(spanAttrs["autter.error.internal"].includes("sk-abcdefghijklmnopqrstuvwxyz"), false, "internal is redacted");
		const event = attrs(reserve.events.find((e) => e.name === "exception").attributes);
		assert.equal(event["autter.error.code"], "inventory.reservation_timeout");
		assert.equal(event["exception.cause.1.code"], "ECONNRESET");
		const legacy = spans.find((s) => attrs(s.attributes)["autter.error.code"] === "legacy.thing_failed");
		assert.equal(attrs(legacy.attributes)["autter.error.fix"], "Do the thing");
		// summaries carry the code but never the internal payload
		expectOperation(runtime, "reserve").toHaveOutcome("degraded").toHaveErrorCode("inventory.reservation_timeout");
		const logs = c.requests.filter((r) => r.path === "/v1/logs");
		assert.ok(logs.length);
		assert.equal(JSON.stringify(logs).includes("SKU-1"), false);
		assert.equal(JSON.stringify(runtime.events).includes("SKU-1"), false);
		assert.ok(inventory.reservation_timeout().status === 503);
	} finally {
		runtime.stop();
		await c.close();
	}
});

test("AI usage rolls up into the current operation", async () => {
	const runtime = captureRuntime();
	await withRuntimeOperation("summarise", async () => {
		await withLlmCall({ provider: "openai", model: "gpt-5-mini" }, async (llm) => {
			llm.setUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 });
			llm.setCost(0.0012);
		});
		trackLlmCall({ provider: "anthropic", model: "claude-sonnet-4", inputTokens: 10, outputTokens: 5, costUsd: 0.0008 });
	});
	expectOperation(runtime, "summarise").toHaveContext({
		"autter.operation.ai": {
			calls: 2,
			input_tokens: 110,
			output_tokens: 25,
			cache_read_tokens: 50,
			cost_usd: 0.002,
			models: ["gpt-5-mini", "claude-sonnet-4"],
		},
	});
	runtime.stop();
});

test("inline messages: max 50, truncation flag, opt-out and testing helpers", async () => {
	const runtime = captureRuntime();
	await withRuntimeOperation("chatty", async () => {
		for (let i = 0; i < 60; i++) runtimeContext.info(`step ${i}`);
		runtimeContext.error(new RuntimeError({ code: "chatty.failed", message: "nope" }));
	});
	const summary = expectOperation(runtime, "chatty").toHaveLog("step 0").toHaveErrorCode("chatty.failed");
	assert.equal(summary.attributes["autter.operation.logs"].length, 50);
	assert.equal(summary.attributes["autter.operation.logs_truncated"], true);
	assert.equal(summary.attributes["autter.operation.level"], "error");
	// error logged → also emitted as its own record
	assert.ok(runtime.logs.some((e) => e.level === "error" && e.attributes["autter.error.code"] === "chatty.failed"));
	assert.throws(() => expectOperation(runtime, "missing"), /no operation named missing/);
	assert.throws(() => expectOperation(runtime, "chatty").toHaveOutcome("failed"), /expected outcome failed/);
	const sink = memorySink();
	sink.write({ time: 0, level: "info", message: "x", attributes: {} });
	assert.equal(sink.events.length, 1);
	sink.clear();
	assert.equal(sink.events.length, 0);
	runtime.stop();
});
