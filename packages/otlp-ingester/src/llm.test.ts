import assert from "node:assert/strict";
import { test } from "node:test";
import { extractLlmCall, totalInputTokens, type LlmSpanFacts } from "./llm.js";

/**
 * `@autter/runtime-node` (1.12.0+) exports every LLM call but drops prompt
 * and completion content from calls that neither failed nor were slow,
 * marking them `autter.llm.content = "omitted"`. Usage and cost rows must
 * come out the same from such a span as from the full one.
 */

function facts(name: string, isError = false): LlmSpanFacts {
	return {
		name,
		traceId: "t".repeat(32),
		spanId: "s".repeat(16),
		isError,
		exceptionType: null,
		durationMs: 1200,
		startedAt: new Date("2026-11-09T10:00:00Z"),
		service: "api",
		environment: "production",
		release: "abc123",
	};
}

const counters = {
	"ai.model.id": "gpt-4o-mini",
	"ai.model.provider": "openai.chat",
	"ai.usage.promptTokens": "1000",
	"ai.usage.completionTokens": "200",
	"ai.response.finishReason": "stop",
	"ai.telemetry.metadata.userId": "user-1",
};
const content = {
	"ai.prompt.messages": '[{"role":"user","content":"summarise the invoice"}]',
	"ai.response.text": "The invoice totals 42 EUR.",
};

test("a call without its content gives the same usage and cost row as the full call", () => {
	const full = extractLlmCall(new Map(Object.entries({ ...counters, ...content })), facts("ai.generateText.doGenerate"));
	const stripped = extractLlmCall(
		new Map(Object.entries({ ...counters, "autter.llm.content": "omitted" })),
		facts("ai.generateText.doGenerate"),
	);
	assert.ok(full && stripped);
	for (const key of ["provider", "model", "operation", "inputTokens", "outputTokens", "costUsd", "costSource", "userId", "status"] as const) {
		assert.deepEqual(stripped[key], full[key], key);
	}
	assert.equal(stripped.inputTokens, 1000);
	assert.equal(stripped.costSource, "estimated");
	assert.equal(stripped.attributes?.["autter.llm.content"], "omitted");
	assert.equal(stripped.attributes?.["ai.prompt.messages"], undefined);
	assert.equal(full.attributes?.["ai.response.text"], "The invoice totals 42 EUR.");
});

test("GenAI semconv spans without messages keep tokens, reported cost and errors", () => {
	const call = extractLlmCall(
		new Map(Object.entries({
			"gen_ai.provider.name": "anthropic",
			"gen_ai.request.model": "claude-haiku-4-5",
			"gen_ai.operation.name": "chat",
			"gen_ai.usage.input_tokens": "10",
			"gen_ai.usage.output_tokens": "3",
			"autter.llm.cost_usd": "0.002",
			"error.type": "RateLimitError",
			"autter.llm.content": "error",
		})),
		facts("chat claude-haiku-4-5", true),
	);
	assert.ok(call);
	assert.deepEqual(
		[call.provider, call.model, call.inputTokens, call.outputTokens, call.costUsd, call.costSource, call.status, call.errorType],
		["anthropic", "claude-haiku-4-5", 10, 3, 0.002, "reported", "error", "RateLimitError"],
	);
	assert.equal(call.attributes?.["autter.llm.content"], "error");
});

// ── Cache-aware usage and cost (1.16.0) ────────────────────────────────────

const call = (attrs: Record<string, string>, name = "chat model", extra: Partial<LlmSpanFacts> = {}) =>
	extractLlmCall(new Map(Object.entries(attrs)), { ...facts(name), startedAt: new Date("2026-11-14T10:00:00Z"), ...extra });
/** USD for token counts at per-1M rates, rounded like the estimator. */
const usd = (...pairs: Array<[number, number]>) => Math.round(pairs.reduce((s, [t, r]) => s + (t * r) / 1e6, 0) * 1e9) / 1e9;
const cacheFields = (c: ReturnType<typeof call>) =>
	c && [c.inputTokens, c.cacheReadTokens, c.cacheWriteTokens, c.cacheWriteLongTokens, c.outputTokens, c.reasoningTokens];

test("semconv cache attributes: input is the total, reads and writes are subsets, priced per kind", () => {
	const c = call({
		"gen_ai.provider.name": "openai",
		"gen_ai.request.model": "gpt-6.1-sol",
		"gen_ai.usage.input_tokens": "10000",
		"gen_ai.usage.cache_read.input_tokens": "6000",
		"gen_ai.usage.cache_creation.input_tokens": "3000",
		"autter.llm.cache_creation.long_ttl_tokens": "1000",
		"gen_ai.usage.output_tokens": "500",
		"gen_ai.usage.reasoning.output_tokens": "200",
	});
	assert.deepEqual(cacheFields(c), [10000, 6000, 3000, 1000, 500, 200]);
	assert.equal(c?.costSource, "estimated");
	assert.equal(c?.pricingVersion, "2026-11-14");
	assert.equal(c?.costUsd, usd([1000, 2], [6000, 0.1], [2000, 2.5], [1000, 5], [500, 10]));
});

test("every alias family is read: OpenLLMetry, Vercel AI SDK, OpenInference", () => {
	const openllmetry = call({
		"gen_ai.system": "openai",
		"gen_ai.request.model": "gpt-4o",
		"gen_ai.usage.prompt_tokens": "10000",
		"gen_ai.usage.completion_tokens": "500",
		"gen_ai.usage.cache_read_input_tokens": "9000",
		"gen_ai.usage.cache_creation_input_tokens": "100",
		"gen_ai.usage.reasoning_tokens": "50",
	}, "openai.chat");
	assert.deepEqual(cacheFields(openllmetry), [10000, 9000, 100, 0, 500, 50]);
	assert.equal(openllmetry?.costUsd, usd([900, 2.5], [9000, 1.25], [100, 2.5], [500, 10]));

	const vercel = call({
		"ai.model.id": "gpt-4o",
		"ai.model.provider": "openai.chat",
		"ai.usage.inputTokens": "10000",
		"ai.usage.outputTokens": "500",
		"ai.usage.cachedInputTokens": "9000",
		"ai.usage.reasoningTokens": "120",
	}, "ai.generateText.doGenerate");
	assert.deepEqual(cacheFields(vercel), [10000, 9000, 0, 0, 500, 120]);
	assert.equal(vercel?.costUsd, usd([1000, 2.5], [9000, 1.25], [500, 10]));

	const openinference = call({
		"openinference.span.kind": "LLM",
		"llm.model_name": "claude-sonnet-4-5-20250929",
		"llm.provider": "anthropic",
		"llm.token_count.prompt": "10000",
		"llm.token_count.completion": "500",
		"llm.token_count.prompt_details.cache_read": "6000",
		"llm.token_count.prompt_details.cache_write": "2000",
		"llm.token_count.completion_details.reasoning": "40",
	}, "ChatAnthropic");
	assert.deepEqual(cacheFields(openinference), [10000, 6000, 2000, 0, 500, 40]);
	assert.deepEqual([openinference?.provider, openinference?.model, openinference?.operation], ["anthropic", "claude-sonnet-4-5-20250929", "llm"]);
	assert.equal(openinference?.costUsd, usd([2000, 3], [6000, 0.3], [2000, 3.75], [500, 15]));
});

test("convention: without the Autter marker, cache counts above input mean input was exclusive (Anthropic's API)", () => {
	// 1,000 uncached + 9,000 cache reads reported the Anthropic way.
	const read = call({
		"gen_ai.provider.name": "anthropic",
		"gen_ai.request.model": "claude-sonnet-4-5",
		"gen_ai.usage.input_tokens": "1000",
		"gen_ai.usage.cache_read_input_tokens": "9000",
		"gen_ai.usage.output_tokens": "500",
	});
	assert.equal(read?.inputTokens, 10000);
	assert.equal(read?.costUsd, usd([1000, 3], [9000, 0.3], [500, 15]));
	// A 9,000-token cache write over 1,000 uncached: also exclusive.
	const write = call({
		"gen_ai.provider.name": "anthropic",
		"gen_ai.request.model": "claude-sonnet-4-5",
		"gen_ai.usage.input_tokens": "1000",
		"gen_ai.usage.cache_creation.input_tokens": "9000",
		"gen_ai.usage.output_tokens": "500",
	});
	assert.equal(write?.inputTokens, 10000);
	assert.equal(write?.costUsd, usd([1000, 3], [9000, 3.75], [500, 15]));
	// Cache counts within input: read as inclusive (the semconv default).
	const inclusive = call({
		"gen_ai.provider.name": "openai",
		"gen_ai.request.model": "gpt-5",
		"gen_ai.usage.input_tokens": "10000",
		"gen_ai.usage.cache_read.input_tokens": "9000",
		"gen_ai.usage.output_tokens": "500",
	});
	assert.equal(inclusive?.inputTokens, 10000);
	assert.equal(inclusive?.costUsd, usd([1000, 1.25], [9000, 0.125], [500, 10]));
});

test("convention: autter.llm.usage_convention = total is trusted even when cache counts exceed input", () => {
	const c = call({
		"gen_ai.provider.name": "anthropic",
		"gen_ai.request.model": "claude-opus-5-5",
		"gen_ai.usage.input_tokens": "5000",
		"gen_ai.usage.cache_read.input_tokens": "4000",
		"gen_ai.usage.cache_creation.input_tokens": "3000",
		"gen_ai.usage.output_tokens": "100",
		"autter.llm.usage_convention": "total",
	});
	// Not re-totalled to 12,000: the SDK said 5,000 is the total; the
	// estimator clamps the uncached part at 0.
	assert.equal(c?.inputTokens, 5000);
	assert.equal(c?.costUsd, usd([4000, 0.2], [3000, 5], [100, 20]));
	assert.equal(totalInputTokens(5000, 4000, 3000, null), 12000);
	assert.equal(totalInputTokens(10000, 4000, 3000, null), 10000);
	assert.equal(totalInputTokens(5000, 4000, 3000, "total"), 5000);
});

test("reported cost wins over the estimate even with cache tokens, in precedence order", () => {
	const base = {
		"gen_ai.provider.name": "openai",
		"gen_ai.request.model": "gpt-5",
		"gen_ai.usage.input_tokens": "10000",
		"gen_ai.usage.cache_read.input_tokens": "9000",
		"gen_ai.usage.output_tokens": "500",
	};
	const order: Array<[Record<string, string>, number]> = [
		[{ "autter.llm.cost_usd": "0.5", "gen_ai.usage.cost": "0.4", "ai.usage.cost": "0.3", "llm.cost.total": "0.2" }, 0.5],
		[{ "gen_ai.usage.cost": "0.4", "ai.usage.cost": "0.3", "llm.cost.total": "0.2" }, 0.4],
		[{ "ai.usage.cost": "0.3", "llm.cost.total": "0.2" }, 0.3],
		[{ "llm.cost.total": "0.2" }, 0.2],
	];
	for (const [costs, expected] of order) {
		const c = call({ ...base, ...costs });
		assert.deepEqual([c?.costUsd, c?.costSource, c?.pricingVersion, c?.cacheReadTokens], [expected, "reported", "", 9000]);
	}
});

test("OpenInference: LLM and EMBEDDING spans become rows with reported llm.cost.total; agent/chain/tool spans do not", () => {
	const llm = call({
		"openinference.span.kind": "LLM",
		"llm.model_name": "gpt-4o",
		"llm.provider": "openai",
		"llm.token_count.prompt": "10000",
		"llm.token_count.completion": "500",
		"llm.token_count.prompt_details.cache_read": "9000",
		"llm.cost.total": "0.0125",
		"llm.input_messages.0.message.content": "summarise the invoice",
	}, "ChatCompletion");
	assert.ok(llm);
	assert.deepEqual([llm.model, llm.inputTokens, llm.cacheReadTokens, llm.costUsd, llm.costSource], ["gpt-4o", 10000, 9000, 0.0125, "reported"]);
	assert.equal(llm.attributes?.["llm.token_count.prompt"], "10000");
	assert.equal(llm.attributes?.["llm.input_messages.0.message.content"], undefined, "message content is not kept");
	const embedding = call({ "openinference.span.kind": "EMBEDDING", "llm.model_name": "text-embedding-3-small", "llm.token_count.prompt": "1000" }, "Embeddings");
	assert.deepEqual([embedding?.operation, embedding?.costSource, embedding?.costUsd], ["embedding", "estimated", usd([1000, 0.02])]);
	for (const kind of ["AGENT", "CHAIN", "TOOL", "RETRIEVER"]) {
		assert.equal(call({ "openinference.span.kind": kind, "llm.model_name": "gpt-4o", "llm.token_count.prompt": "10000" }, kind), null, kind);
	}
});

test("an in-process invoke_agent span and its chat child are not both counted; a remote (CLIENT) agent call is", () => {
	const usage = {
		"gen_ai.provider.name": "openai",
		"gen_ai.request.model": "gpt-4o",
		"gen_ai.usage.input_tokens": "10000",
		"gen_ai.usage.output_tokens": "500",
	};
	assert.equal(call({ ...usage, "gen_ai.operation.name": "invoke_agent" }, "invoke_agent support", { spanKind: "internal" }), null);
	assert.equal(call({ ...usage, "gen_ai.operation.name": "invoke_workflow" }, "invoke_workflow triage", { spanKind: "internal" }), null);
	assert.ok(call({ ...usage, "gen_ai.operation.name": "chat" }, "chat gpt-4o", { spanKind: "client" }));
	const remote = call({ ...usage, "gen_ai.operation.name": "invoke_agent" }, "invoke_agent bedrock", { spanKind: "client" });
	assert.equal(remote?.operation, "invoke_agent");
	// Tool runs and agent creation are never model calls.
	assert.equal(call({ "gen_ai.provider.name": "openai", "gen_ai.operation.name": "execute_tool" }, "execute_tool lookup"), null);
	assert.equal(call({ "gen_ai.provider.name": "openai", "gen_ai.operation.name": "create_agent" }, "create_agent x", { spanKind: "client" }), null);
});

test("unknown models stay unpriced with cache tokens kept; no cache attributes reads as 0", () => {
	const unknown = call({
		"gen_ai.provider.name": "openai",
		"gen_ai.request.model": "ft:acme-custom",
		"gen_ai.usage.input_tokens": "10000",
		"gen_ai.usage.cache_read.input_tokens": "9000",
		"gen_ai.usage.output_tokens": "500",
	});
	assert.deepEqual([unknown?.costUsd, unknown?.costSource, unknown?.pricingVersion, unknown?.cacheReadTokens], [0, "none", "", 9000]);
	const plain = call({ "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt-4o", "gen_ai.usage.input_tokens": "10", "gen_ai.usage.output_tokens": "3" });
	assert.deepEqual(cacheFields(plain), [10, 0, 0, 0, 3, 0]);
});
