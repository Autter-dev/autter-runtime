import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	configureLlmPricing,
	estimateLlmCost,
	loadLlmPriceOverrides,
	lookupLlmPrice,
	normalizeModelId,
	parseLlmPriceOverrides,
} from "./llm-pricing.js";
import { BUILTIN_LLM_PRICES, LLM_PRICES_AS_OF } from "./llm-prices.js";

const NOV = new Date("2026-11-14T12:00:00Z");
const usd = (estimate: { costUsd: number } | null) => estimate?.costUsd ?? null;
/** USD for token counts at per-1M rates. */
const at = (...pairs: Array<[tokens: number, perMTok: number]>) =>
	Math.round(pairs.reduce((sum, [t, r]) => sum + (t * r) / 1e6, 0) * 1e9) / 1e9;

test("no cache tokens: input and output at their rates, stamped with the table's as-of day", () => {
	const estimate = estimateLlmCost("gpt-4o", { inputTokens: 10_000, outputTokens: 500 }, NOV);
	assert.deepEqual(estimate, { costUsd: at([10_000, 2.5], [500, 10]), pricingVersion: LLM_PRICES_AS_OF });
});

test("cache reads are priced at the cache-read rate, not the input rate (OpenAI gpt-5: 0.1x)", () => {
	// 10,000 prompt tokens of which 9,000 were cache hits.
	const cost = usd(estimateLlmCost("gpt-5", { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 9_000 }, NOV));
	assert.equal(cost, at([1_000, 1.25], [9_000, 0.125], [500, 10]));
	// Per-model ratios: gpt-4o 0.5x, gpt-4.1 0.25x, gpt-6.1-sol 0.05x.
	assert.equal(usd(estimateLlmCost("gpt-4o", { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6 }, NOV)), 1.25);
	assert.equal(usd(estimateLlmCost("gpt-4.1", { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6 }, NOV)), 0.5);
	assert.equal(usd(estimateLlmCost("gpt-6.1-sol", { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6 }, NOV)), 0.1);
});

test("Anthropic: 5-minute writes at 1.25x, 1-hour writes at 2x, reads at the model's own multiplier", () => {
	const usage = { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 3_000, cacheWriteTokens: 6_000, cacheWriteLongTokens: 2_000 };
	// Sonnet 4.6: $3 in, $15 out, $0.30 read, $3.75 5m write, $6 1h write.
	assert.equal(
		usd(estimateLlmCost("claude-sonnet-4-6", usage, NOV)),
		at([1_000, 3], [3_000, 0.3], [4_000, 3.75], [2_000, 6], [500, 15]),
	);
	// Opus 5.5 reads at 0.05x ($0.20 on $4), Fable 5.2 at 0.025x ($0.20 on $8).
	assert.equal(usd(estimateLlmCost("claude-opus-5-5", { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6 }, NOV)), 0.2);
	assert.equal(usd(estimateLlmCost("claude-fable-5-2", { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6 }, NOV)), 0.2);
	assert.equal(usd(estimateLlmCost("claude-sonnet-5-5", { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 1e6 }, NOV)), 0.1);
	assert.equal(usd(estimateLlmCost("claude-haiku-5-5", { inputTokens: 1e6, outputTokens: 0, cacheWriteTokens: 1e6, cacheWriteLongTokens: 1e6 }, NOV)), 0.2);
});

test("OpenAI GPT-5.6+: 30-minute writes at 1.25x and 12-hour writes at 2.5x; earlier models charge no write premium", () => {
	const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheWriteLongTokens: 400_000 };
	assert.equal(usd(estimateLlmCost("gpt-6.1-sol", usage, NOV)), at([600_000, 2.5], [400_000, 5]));
	// gpt-5.5 lists no write rate: written tokens cost the input rate.
	assert.equal(usd(estimateLlmCost("gpt-5.5", usage, NOV)), 5);
});

test("missing rates fall back: read and write to the input rate, long writes to the short write rate", () => {
	configureLlmPricing({
		llmPriceOverrides: {
			asOf: "2026-11-20",
			models: [
				{ match: "acme-none", inputPerMTok: 2, outputPerMTok: 4 },
				{ match: "acme-short", inputPerMTok: 2, outputPerMTok: 4, cacheWritePerMTok: 3 },
			],
		},
	});
	try {
		const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 250_000, cacheWriteTokens: 500_000, cacheWriteLongTokens: 200_000 };
		assert.equal(usd(estimateLlmCost("acme-none", usage, NOV)), 2);
		assert.equal(usd(estimateLlmCost("acme-short", usage, NOV)), at([250_000, 2], [250_000, 2], [300_000, 3], [200_000, 3]));
	} finally {
		configureLlmPricing({});
	}
});

test("clamping: cache tokens above input leave no negative uncached part; long writes never exceed writes; negatives are 0", () => {
	// read + write (12,000) > input (10,000): uncached is 0, not -2,000.
	assert.equal(
		usd(estimateLlmCost("claude-sonnet-4-5", { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 8_000, cacheWriteTokens: 4_000 }, NOV)),
		at([8_000, 0.3], [4_000, 3.75]),
	);
	assert.equal(
		usd(estimateLlmCost("claude-sonnet-4-5", { inputTokens: 1_000, outputTokens: 0, cacheWriteTokens: 1_000, cacheWriteLongTokens: 5_000 }, NOV)),
		at([1_000, 6]),
	);
	assert.equal(usd(estimateLlmCost("gpt-4o", { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: -1 }, NOV)), 0);
});

test("models match on a version boundary: gpt-5 prices neither gpt-5.5 nor gpt-5-pro; snapshots still match", () => {
	assert.equal(lookupLlmPrice("gpt-5.5", NOV)?.inputPerMTok, 5);
	assert.equal(lookupLlmPrice("gpt-5-pro", NOV)?.inputPerMTok, 15);
	assert.equal(lookupLlmPrice("gpt-5-mini", NOV)?.inputPerMTok, 0.25);
	assert.equal(lookupLlmPrice("gpt-5-2025-08-07", NOV)?.match, "gpt-5");
	assert.equal(lookupLlmPrice("gpt-5.1-codex", NOV), null, "a codex variant is not gpt-5.1");
	assert.equal(lookupLlmPrice("gpt-5-chat-latest", NOV), null);
	// Anthropic 4.6 / 4.7 / 5.x no longer fall back to an older entry's price.
	assert.equal(lookupLlmPrice("claude-opus-4-6", NOV)?.inputPerMTok, 5);
	assert.equal(lookupLlmPrice("claude-opus-4-7", NOV)?.inputPerMTok, 5);
	assert.equal(lookupLlmPrice("claude-opus-4-1-20250805", NOV)?.inputPerMTok, 15);
	assert.equal(lookupLlmPrice("claude-opus-4-20250514", NOV)?.match, "claude-opus-4");
	assert.equal(lookupLlmPrice("claude-sonnet-5", NOV)?.inputPerMTok, 2);
	assert.equal(lookupLlmPrice("claude-sonnet-5-5", NOV)?.cacheReadPerMTok, 0.1);
	assert.equal(lookupLlmPrice("claude-haiku-5-5", NOV)?.inputPerMTok, 0.1);
	assert.equal(lookupLlmPrice("claude-sonnet-4-5-20250929", NOV)?.match, "claude-sonnet-4-5");
	assert.equal(lookupLlmPrice("o3-mini", NOV)?.match, "o3-mini");
	assert.equal(lookupLlmPrice("o3-pro", NOV)?.inputPerMTok, 20);
	assert.equal(lookupLlmPrice("gemini-2.5-flash-lite", NOV)?.inputPerMTok, 0.1);
	assert.equal(lookupLlmPrice("gemini-2.5-flash-preview-05-20", NOV), null);
	assert.equal(lookupLlmPrice("gemini-2.5-pro-001", NOV)?.match, "gemini-2.5-pro");
});

test("current models are priced: gpt-6.x, claude-opus-5-5, claude-fable-5-2, gemini-3.x and gemini-4", () => {
	for (const [model, input, output] of [
		["gpt-6.1-sol", 2, 10],
		["gpt-6-luna", 0.1, 0.5],
		["gpt-5.6-sol", 4, 20],
		["claude-opus-5-5", 4, 20],
		["claude-fable-5-2", 8, 40],
		["gemini-3.1-pro-preview", 2, 12],
		["gemini-3.8-flash", 0.75, 3.75],
		["gemini-4-carbon", 2, 10],
	] as const) {
		const price = lookupLlmPrice(model, NOV);
		assert.deepEqual([price?.inputPerMTok, price?.outputPerMTok], [input, output], model);
	}
});

test("router, Bedrock and Vertex prefixes are stripped, global. included; gateway dots in Claude ids become dashes", () => {
	assert.equal(normalizeModelId("global.anthropic.claude-sonnet-4-5-20250929-v1:0"), "claude-sonnet-4-5-20250929-v1:0");
	assert.equal(lookupLlmPrice("global.anthropic.claude-sonnet-4-5-20250929-v1:0", NOV)?.match, "claude-sonnet-4-5");
	assert.equal(lookupLlmPrice("us.anthropic.claude-opus-4-1-20250805-v1:0", NOV)?.match, "claude-opus-4-1");
	assert.equal(lookupLlmPrice("anthropic/claude-sonnet-4.5", NOV)?.match, "claude-sonnet-4-5");
	assert.equal(lookupLlmPrice("claude-opus-4-5@20251101", NOV)?.match, "claude-opus-4-5");
	assert.equal(lookupLlmPrice("openai/gpt-5-mini", NOV)?.match, "gpt-5-mini");
	assert.equal(lookupLlmPrice("models/gemini-2.5-pro", NOV)?.match, "gemini-2.5-pro");
});

test("unknown models stay unpriced, never priced from a family", () => {
	for (const model of ["my-finetune", "ft:acme-custom", "claude-sonnet", "claude-opus-9", "gpt-7", "gemini-5-pro", "openrouter/auto", ""]) {
		assert.equal(estimateLlmCost(model, { inputTokens: 1000, outputTokens: 1000 }, NOV), null, model);
	}
});

test("dated price changes apply from their effectiveFrom day (Gemini 4 Carbon doubles on 2026-12-01)", () => {
	const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 500_000 };
	assert.equal(usd(estimateLlmCost("gemini-4-carbon", usage, new Date("2026-11-30T23:59:59Z"))), at([500_000, 2], [500_000, 0.1], [1e6, 10]));
	assert.equal(usd(estimateLlmCost("gemini-4-carbon", usage, new Date("2026-12-01T00:00:00Z"))), at([500_000, 4], [500_000, 0.2], [1e6, 20]));
	assert.equal(lookupLlmPrice("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"))?.inputPerMTok, 1.5);
});

test("every built-in entry cites a source, has sane rates, and no (match, effectiveFrom) appears twice", () => {
	const seen = new Set<string>();
	for (const entry of BUILTIN_LLM_PRICES) {
		const key = `${entry.match}@${entry.effectiveFrom ?? ""}`;
		assert.ok(!seen.has(key), `duplicate ${key}`);
		seen.add(key);
		assert.ok(entry.source && entry.source.length > 0, `${entry.match}: no source`);
		assert.equal(entry.match, normalizeModelId(entry.match), `${entry.match}: not normalised`);
		for (const rate of [entry.inputPerMTok, entry.outputPerMTok, entry.cacheReadPerMTok ?? 0, entry.cacheWritePerMTok ?? 0, entry.cacheWriteLongPerMTok ?? 0]) {
			assert.ok(Number.isFinite(rate) && rate >= 0, `${entry.match}: bad rate ${rate}`);
		}
		if (entry.cacheReadPerMTok !== undefined) assert.ok(entry.cacheReadPerMTok <= entry.inputPerMTok, `${entry.match}: read above input`);
	}
	assert.match(LLM_PRICES_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
});

test("override file: replaces a built-in model (all its dated entries), adds new ones, stamps override:<asOf>", () => {
	const dir = mkdtempSync(join(tmpdir(), "llm-prices-"));
	const file = join(dir, "prices.json");
	writeFileSync(
		file,
		JSON.stringify({
			asOf: "2026-12-01",
			models: [
				{ match: "gemini-4-carbon", inputPerMTok: 3, outputPerMTok: 15 },
				{ match: "OpenAI/Acme-FT", inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, source: "contract 2026" },
			],
		}),
	);
	configureLlmPricing({ llmPriceOverrides: loadLlmPriceOverrides(file) });
	try {
		assert.deepEqual(estimateLlmCost("acme-ft", { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 }, NOV), {
			costUsd: 2.1,
			pricingVersion: "override:2026-12-01",
		});
		// The built-in 2026-12-01 Carbon entry is replaced too, not only the first one.
		assert.equal(estimateLlmCost("gemini-4-carbon", { inputTokens: 1e6, outputTokens: 0 }, new Date("2026-12-05T00:00:00Z"))?.costUsd, 3);
		assert.equal(estimateLlmCost("gpt-4o", { inputTokens: 1e6, outputTokens: 0 }, NOV)?.pricingVersion, LLM_PRICES_AS_OF);
	} finally {
		configureLlmPricing({});
	}
	assert.equal(estimateLlmCost("acme-ft", { inputTokens: 1, outputTokens: 1 }, NOV), null, "reset restores the built-in table");
});

test("override file: invalid files fail with every problem and its path", () => {
	assert.throws(() => parseLlmPriceOverrides("{ nope"), /AUTTER_LLM_PRICES_FILE: not valid JSON/);
	assert.throws(
		() =>
			parseLlmPriceOverrides(
				JSON.stringify({
					asOf: "Dec 1",
					models: [{ match: "x", inputPerMTok: -1, outputPerMTok: "2", inputPerMtok: 3 }],
				}),
			),
		(err: Error) => {
			assert.match(err.message, /asOf: must be a YYYY-MM-DD date/);
			assert.match(err.message, /models\.0\.inputPerMTok: must be 0 or more/);
			assert.match(err.message, /models\.0\.outputPerMTok: must be a number/);
			assert.match(err.message, /models\.0: .*inputPerMtok/);
			return true;
		},
	);
	assert.throws(() => parseLlmPriceOverrides(JSON.stringify({ asOf: "2026-12-01", models: [] })), /models: must list at least one model/);
	assert.throws(
		() =>
			parseLlmPriceOverrides(
				JSON.stringify({ asOf: "2026-12-01", models: [{ match: "a", inputPerMTok: 1, outputPerMTok: 1 }, { match: "A", inputPerMTok: 2, outputPerMTok: 2 }] }),
			),
		/models\.1\.match: "A" is listed twice/,
	);
	assert.throws(() => loadLlmPriceOverrides("/nonexistent/prices.json"), /cannot read \/nonexistent\/prices\.json \(ENOENT\)/);
});
