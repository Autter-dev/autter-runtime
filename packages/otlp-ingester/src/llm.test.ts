import assert from "node:assert/strict";
import { test } from "node:test";
import { extractLlmCall, type LlmSpanFacts } from "./llm.js";

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
