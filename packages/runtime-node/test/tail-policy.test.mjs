// Unit tests for the tail-sampling policies (src/tail-sampling.ts), loaded
// from source with tsx so time can be simulated: a sustained regression,
// low-volume LLM traffic, and LLM content gating across the GenAI,
// OpenInference and OpenLLMetry conventions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const {
	SlowPolicy,
	LlmContentPolicy,
	LlmContentExporter,
	isLlmSpan,
	isAiSpan,
	isLlmContentKey,
	LLM_COLD_SLOW_MS,
} = await tsImport("../src/tail-sampling.ts", import.meta.url);

const ROUTE = "GET /items";

for (const { label, healthy, slow } of [
	{ label: "under the floor", healthy: (i) => 80 + ((i * 37) % 140), slow: (i) => 880 + ((i * 13) % 40) },
	{ label: "above the floor", healthy: (i) => 400 + ((i * 37) % 400), slow: (i) => 1400 + ((i * 13) % 200) },
]) {
	test(`a route that becomes and stays slow keeps a steady sample of slow traces (healthy ${label})`, () => {
		const policy = new SlowPolicy({}, 0);
		let now = 0;
		// Ten healthy minutes, 2 requests a second.
		let healthyKept = 0;
		for (let i = 0; i < 1200; i++) if (policy.consider(ROUTE, healthy(i), true, (now += 500))) healthyKept++;
		assert.ok(healthyKept <= 60, `healthy traffic keeps its tail only (${healthyKept})`);
		const baseline = policy.thresholdMs(ROUTE, now);
		// Then it stays slow for ten minutes.
		const keptPerMinute = new Array(10).fill(0);
		for (let i = 0; i < 1200; i++) {
			if (policy.consider(ROUTE, slow(i), true, (now += 500))) keptPerMinute[Math.floor(i / 120)]++;
		}
		assert.equal(policy.regressed(ROUTE, now), true, "the route is regressed, its baseline frozen");
		assert.equal(policy.thresholdMs(ROUTE, now), baseline, "the threshold stays at the healthy baseline");
		// The default budget is 60 a minute per process, a sixth (10) per route.
		for (const [minute, kept] of keptPerMinute.entries()) {
			assert.ok(kept >= 8 && kept <= 16, `minute ${minute}: ${kept} slow traces kept (${keptPerMinute})`);
		}
	});
}

test("the reviewed case: 112 requests at ~900 ms after healthy traffic keep more than their onset", () => {
	const policy = new SlowPolicy({}, 0);
	let now = 0;
	for (let i = 0; i < 600; i++) policy.consider(ROUTE, 120 + (i % 60), true, (now += 1000));
	let kept = 0;
	// 112 slow requests over ~11 minutes (one every 6 s).
	for (let i = 0; i < 112; i++) if (policy.consider(ROUTE, 880 + (i % 40), true, (now += 6000))) kept++;
	assert.ok(kept >= 60, `${kept} of 112 kept`);
});

test("after an hour regressed the baseline adopts the new latency", () => {
	const policy = new SlowPolicy({}, 0);
	let now = 0;
	for (let i = 0; i < 1200; i++) policy.consider(ROUTE, 150, true, (now += 500));
	let lastKept = 0;
	for (let i = 0; i < 2 * 60 * 90; i++) {
		now += 500;
		if (policy.consider(ROUTE, 900, true, now)) lastKept = now;
	}
	assert.equal(policy.regressed(ROUTE, now), false);
	assert.ok(policy.thresholdMs(ROUTE, now) >= 900);
	assert.ok(now - lastKept > 10 * 60_000, "no longer slow once it is the route's normal");
});

test("a few slow outliers do not freeze the baseline", () => {
	const policy = new SlowPolicy({}, 0);
	let now = 0;
	for (let i = 0; i < 3000; i++) {
		policy.consider(ROUTE, i % 25 === 0 ? 2000 : 150, true, (now += 500));
		assert.equal(policy.regressed(ROUTE, now), false, `request ${i}`);
	}
});

/** A finished span as the SDK hands it to exporters. */
function span({ name = "chat", attributes = {}, events = [], links = [], status = { code: 0 }, ms = 1000, at = 0 } = {}) {
	const start = [Math.floor(at / 1000), (at % 1000) * 1e6];
	return {
		name,
		kind: 2,
		spanContext: () => ({ traceId: "0".repeat(31) + "1", spanId: "0".repeat(15) + "1", traceFlags: 1 }),
		parentSpanContext: undefined,
		startTime: start,
		endTime: [start[0] + Math.floor(ms / 1000), start[1] + (ms % 1000) * 1e6],
		duration: [Math.floor(ms / 1000), (ms % 1000) * 1e6],
		status,
		attributes,
		events,
		links,
		ended: true,
		resource: { attributes: {} },
		instrumentationScope: { name: "test" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	};
}

const vercelCall = (ms, at) => span({
	name: "ai.generateText.doGenerate",
	ms,
	at,
	attributes: { "ai.model.id": "gpt-4o-mini", "ai.prompt.messages": "[prompt]", "ai.response.text": "completion", "ai.usage.promptTokens": 10 },
});

test("at low volume an LLM call is slow only above the absolute threshold", () => {
	const policy = new LlmContentPolicy("slow-or-failed", 60, 0);
	// One call a minute, 2-8 s each: the floor alone would call them all slow.
	for (let i = 0; i < 20; i++) {
		const at = i * 60_000;
		const out = policy.apply(vercelCall(2000 + (i % 4) * 2000, at), at);
		assert.equal(out.attributes["autter.llm.content"], "omitted", `call ${i}`);
		assert.equal(out.attributes["ai.response.text"], undefined);
	}
	const at = 21 * 60_000;
	assert.equal(policy.apply(vercelCall(LLM_COLD_SLOW_MS + 5000, at), at).attributes["autter.llm.content"], "slow");
});

test("once a model has enough calls its own p95 applies", () => {
	const policy = new LlmContentPolicy("slow-or-failed", 6000, 0);
	let at = 0;
	for (let i = 0; i < 60; i++) policy.apply(vercelCall(900 + (i % 10) * 20, (at += 1000)), at);
	assert.equal(policy.apply(vercelCall(1000, (at += 1000)), at).attributes["autter.llm.content"], "omitted");
	assert.equal(policy.apply(vercelCall(3000, (at += 1000)), at).attributes["autter.llm.content"], "slow");
});

const CONTENT = "SECRET-CONTENT";

test("OpenInference spans are recognised and their content stripped; tokens, cost and model stay", () => {
	const attributes = {
		"openinference.span.kind": "LLM",
		"llm.model_name": "gpt-4o",
		"llm.provider": "openai",
		"input.value": CONTENT,
		"input.mime_type": "application/json",
		"output.value": CONTENT,
		"llm.input_messages.0.message.role": "user",
		"llm.input_messages.0.message.content": CONTENT,
		"llm.input_messages.0.message.contents.0.message_content.text": CONTENT,
		"llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments": CONTENT,
		"llm.prompt_template.template": CONTENT,
		"llm.prompt_template.variables": CONTENT,
		"llm.prompt_template.version": "v3",
		"llm.function_call": CONTENT,
		"llm.invocation_parameters": CONTENT,
		"llm.tools.0.tool.json_schema": CONTENT,
		"llm.token_count.prompt": 120,
		"llm.token_count.completion": 30,
		"llm.token_count.total": 150,
		"llm.cost.total": 0.002,
		"llm.finish_reason": "stop",
	};
	assert.equal(isLlmSpan("ChatCompletion", attributes), true, "always recorded, like other LLM calls");
	const out = new LlmContentPolicy("slow-or-failed", 60, 0).apply(span({ attributes }), 0);
	assert.equal(out.attributes["autter.llm.content"], "omitted");
	assert.ok(!JSON.stringify(out.attributes).includes(CONTENT), JSON.stringify(out.attributes));
	for (const key of ["llm.model_name", "llm.provider", "llm.token_count.prompt", "llm.token_count.completion", "llm.token_count.total",
		"llm.cost.total", "llm.finish_reason", "llm.input_messages.0.message.role", "llm.prompt_template.version", "input.mime_type"]) {
		assert.equal(out.attributes[key], attributes[key], key);
	}
});

test("OpenInference chain, tool, retriever and embedding spans lose their content too", () => {
	const policy = new LlmContentPolicy("slow-or-failed", 60, 0);
	const cases = [
		{ "openinference.span.kind": "CHAIN", "input.value": CONTENT, "output.value": CONTENT },
		{ "openinference.span.kind": "TOOL", "tool.name": "search", "tool.parameters": CONTENT, "input.value": CONTENT },
		{
			"openinference.span.kind": "RETRIEVER",
			"retrieval.documents.0.document.content": CONTENT,
			"retrieval.documents.0.document.metadata": CONTENT,
			"retrieval.documents.0.document.id": "doc-1",
			"retrieval.documents.0.document.score": 0.8,
		},
		{ "openinference.span.kind": "EMBEDDING", "embedding.model_name": "e5", "embedding.embeddings.0.embedding.text": CONTENT },
	];
	for (const attributes of cases) {
		const out = policy.apply(span({ attributes }), 0);
		assert.ok(!JSON.stringify(out.attributes).includes(CONTENT), JSON.stringify(out.attributes));
	}
	const retriever = policy.apply(span({ attributes: cases[2] }), 0);
	assert.equal(retriever.attributes["retrieval.documents.0.document.id"], "doc-1");
	assert.equal(retriever.attributes["retrieval.documents.0.document.score"], 0.8);
	assert.equal(policy.apply(span({ attributes: cases[3] }), 0).attributes["embedding.model_name"], "e5");
});

test("OpenLLMetry / Traceloop spans: content stripped, roles, finish reasons and usage stay", () => {
	const policy = new LlmContentPolicy("slow-or-failed", 60, 0);
	const chat = {
		"llm.request.type": "chat",
		"gen_ai.system": "OpenAI",
		"gen_ai.request.model": "gpt-4o",
		"gen_ai.prompt.0.role": "user",
		"gen_ai.prompt.0.content": CONTENT,
		"gen_ai.completion.0.role": "assistant",
		"gen_ai.completion.0.content": CONTENT,
		"gen_ai.completion.0.finish_reason": "stop",
		"gen_ai.completion.0.tool_calls.0.arguments": CONTENT,
		"llm.request.functions.0.name": "lookup",
		"llm.request.functions.0.parameters": CONTENT,
		"gen_ai.usage.input_tokens": 12,
		"gen_ai.usage.output_tokens": 4,
		"llm.usage.total_tokens": 16,
		"gen_ai.prompt.name": "support-v2",
	};
	assert.equal(isLlmSpan("openai.chat", { "llm.request.type": "chat" }), true);
	const out = policy.apply(span({ name: "openai.chat", attributes: chat }), 0);
	assert.ok(!JSON.stringify(out.attributes).includes(CONTENT), JSON.stringify(out.attributes));
	for (const key of ["gen_ai.prompt.0.role", "gen_ai.completion.0.role", "gen_ai.completion.0.finish_reason",
		"gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "llm.usage.total_tokens", "gen_ai.request.model", "gen_ai.prompt.name"]) {
		assert.equal(out.attributes[key], chat[key], key);
	}
	const workflow = { "traceloop.span.kind": "workflow", "traceloop.entity.name": "answer", "traceloop.entity.input": CONTENT, "traceloop.entity.output": CONTENT };
	assert.equal(isAiSpan("answer.workflow", workflow), true);
	assert.equal(isLlmSpan("answer.workflow", workflow), false, "a workflow is not an LLM call: head sampling applies");
	const wf = policy.apply(span({ name: "answer.workflow", attributes: workflow }), 0);
	assert.ok(!JSON.stringify(wf.attributes).includes(CONTENT));
	assert.equal(wf.attributes["traceloop.entity.name"], "answer");
});

test("GenAI retrieval and tool keys are content; the published lists' metadata keys are not", () => {
	for (const key of ["gen_ai.retrieval.query.text", "gen_ai.retrieval.documents", "gen_ai.tool.definitions", "gen_ai.tool.call.arguments",
		"gen_ai.tool.call.result", "gen_ai.system_instructions", "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.evaluation.explanation",
		"tool.parameters", "llm.tools.1.tool.json_schema", "reranker.query", "message.content"]) {
		assert.equal(isLlmContentKey(key), true, key);
	}
	for (const key of ["gen_ai.usage.input_tokens", "gen_ai.response.finish_reasons", "gen_ai.request.model", "gen_ai.response.model",
		"gen_ai.tool.name", "gen_ai.tool.call.id", "llm.token_count.prompt", "llm.cost.total", "llm.model_name", "gen_ai.completion.3.finish_reason",
		"ai.usage.promptTokens", "ai.response.finishReason", "ai.telemetry.metadata.userId"]) {
		assert.equal(isLlmContentKey(key), false, key);
	}
});

test('llmContent "never": a failed call loses its error text, event and link content, keeps type and frames', () => {
	const failed = span({
		name: "ai.generateText.doGenerate",
		attributes: { "ai.model.id": "m", "ai.response.text": CONTENT, "ai.usage.completionTokens": 5 },
		status: { code: 2, message: `Unexpected token in JSON: ${CONTENT}` },
		events: [
			{ name: "exception", time: [0, 0], attributes: {
				"exception.type": "SyntaxError",
				"exception.message": `Unexpected token in JSON: ${CONTENT}`,
				"exception.stacktrace": `SyntaxError: Unexpected token in JSON: ${CONTENT}\n    at JSON.parse (<anonymous>)\n    at parse (/app/llm.js:10:5)`,
			} },
			{ name: "gen_ai.client.operation.exception", time: [0, 0], attributes: { "exception.type": "SyntaxError", "exception.message": CONTENT } },
			{ name: "retry", time: [0, 0], attributes: { attempt: 2, content: CONTENT } },
			{ name: "gen_ai.custom.output", time: [0, 0], attributes: { value: CONTENT } },
		],
		links: [{ context: { traceId: "1".repeat(32), spanId: "1".repeat(16), traceFlags: 1 }, attributes: { "input.value": CONTENT, kind: "follows" } }],
	});
	const out = new LlmContentPolicy("never", 60, 0).apply(failed, 0);
	assert.ok(!JSON.stringify({ a: out.attributes, e: out.events, l: out.links, s: out.status }).includes(CONTENT));
	assert.equal(out.attributes["autter.llm.content"], "omitted");
	assert.equal(out.status.code, 2);
	const exception = out.events.find((e) => e.name === "exception");
	assert.equal(exception.attributes["exception.type"], "SyntaxError");
	assert.match(exception.attributes["exception.stacktrace"], /^SyntaxError: \[omitted\]\n {4}at JSON\.parse/);
	assert.match(exception.attributes["exception.stacktrace"], /at parse \(\/app\/llm\.js:10:5\)/);
	assert.equal(out.events.find((e) => e.name === "retry").attributes.attempt, 2);
	assert.equal(out.events.some((e) => e.name === "gen_ai.custom.output"), false);
	assert.equal(out.links[0].attributes.kind, "follows");
	assert.equal(Number(out.attributes["ai.usage.completionTokens"]), 5);
});

const deepFreeze = (value) => {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) deepFreeze(inner);
	}
	return value;
};

test("the policy never changes the span other processors hold", () => {
	const shared = deepFreeze(span({
		name: "ai.generateText.doGenerate",
		attributes: { "ai.model.id": "m", "ai.prompt.messages": CONTENT },
		status: { code: 2, message: CONTENT },
		events: [{ name: "exception", time: [0, 0], attributes: { "exception.type": "E", "exception.message": CONTENT } }],
		links: [{ context: { traceId: "1".repeat(32), spanId: "1".repeat(16), traceFlags: 1 }, attributes: { "input.value": CONTENT } }],
	}));
	const before = JSON.stringify(shared);
	for (const mode of ["never", "slow-or-failed"]) new LlmContentPolicy(mode, 60, 0).apply(shared, 0);
	assert.equal(JSON.stringify(shared), before);
});

test("a span without events still exports, content stripped, and the rest of the batch with it", () => {
	const exported = [];
	const inner = { export: (spans, done) => { exported.push(...spans); done({ code: 0 }); }, shutdown: async () => {} };
	const exporter = new LlmContentExporter(inner, new LlmContentPolicy("slow-or-failed", 60, 0));
	const odd = span({ name: "ai.generateText", attributes: { "ai.prompt": CONTENT, "ai.usage.promptTokens": 3 } });
	odd.events = undefined;
	odd.links = undefined;
	const plain = span({ name: "db.query", attributes: { "db.system": "postgresql" } });
	let result;
	assert.doesNotThrow(() => exporter.export([odd, plain], (r) => (result = r)));
	assert.equal(result.code, 0);
	assert.equal(exported.length, 2);
	assert.equal(exported[0].attributes["ai.prompt"], undefined);
	assert.equal(Number(exported[0].attributes["ai.usage.promptTokens"]), 3);
	assert.equal(exported[1], plain, "non-AI spans pass through untouched");
});
