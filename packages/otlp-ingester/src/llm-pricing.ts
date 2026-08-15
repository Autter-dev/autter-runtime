/**
 * Built-in USD price estimates for common LLM models, per 1M tokens.
 *
 * Estimation happens once at ingest so cost queries never re-price history
 * (a price change should not rewrite last month's spend). The table is a
 * best-effort default: SDKs can always report the exact figure via the
 * `autter.llm.cost_usd` span attribute, which takes precedence.
 *
 * Matching is longest-prefix-wins on a normalised model id (lowercased,
 * provider/router prefixes stripped), so `claude-sonnet-4-20250514` matches
 * the `claude-sonnet-4` entry and gateway ids like `openai/gpt-5-mini`
 * match `gpt-5-mini`. Unknown models estimate to 0 with costSource "none" —
 * tokens are still tracked, and dashboards can flag unpriced volume.
 */

interface ModelPricing {
	/** Normalised model-id prefix. */
	prefix: string;
	/** USD per 1M input tokens. */
	inputPerMTok: number;
	/** USD per 1M output tokens. */
	outputPerMTok: number;
}

// Keep more-specific prefixes ABOVE their generic fallback (the list is
// scanned for the longest match, but equal-length ties resolve by order).
const MODEL_PRICING: ModelPricing[] = [
	// OpenAI
	{ prefix: "gpt-5-nano", inputPerMTok: 0.05, outputPerMTok: 0.4 },
	{ prefix: "gpt-5-mini", inputPerMTok: 0.25, outputPerMTok: 2 },
	{ prefix: "gpt-5", inputPerMTok: 1.25, outputPerMTok: 10 },
	{ prefix: "gpt-4.1-nano", inputPerMTok: 0.1, outputPerMTok: 0.4 },
	{ prefix: "gpt-4.1-mini", inputPerMTok: 0.4, outputPerMTok: 1.6 },
	{ prefix: "gpt-4.1", inputPerMTok: 2, outputPerMTok: 8 },
	{ prefix: "gpt-4o-mini", inputPerMTok: 0.15, outputPerMTok: 0.6 },
	{ prefix: "gpt-4o", inputPerMTok: 2.5, outputPerMTok: 10 },
	{ prefix: "o3-mini", inputPerMTok: 1.1, outputPerMTok: 4.4 },
	{ prefix: "o3", inputPerMTok: 2, outputPerMTok: 8 },
	{ prefix: "o4-mini", inputPerMTok: 1.1, outputPerMTok: 4.4 },
	{ prefix: "text-embedding-3-small", inputPerMTok: 0.02, outputPerMTok: 0 },
	{ prefix: "text-embedding-3-large", inputPerMTok: 0.13, outputPerMTok: 0 },
	// Anthropic
	{ prefix: "claude-opus-4-5", inputPerMTok: 5, outputPerMTok: 25 },
	{ prefix: "claude-opus-4-8", inputPerMTok: 5, outputPerMTok: 25 },
	{ prefix: "claude-opus-4", inputPerMTok: 15, outputPerMTok: 75 },
	{ prefix: "claude-sonnet-4", inputPerMTok: 3, outputPerMTok: 15 },
	{ prefix: "claude-sonnet", inputPerMTok: 3, outputPerMTok: 15 },
	{ prefix: "claude-haiku-4", inputPerMTok: 1, outputPerMTok: 5 },
	{ prefix: "claude-3-5-haiku", inputPerMTok: 0.8, outputPerMTok: 4 },
	{ prefix: "claude-haiku", inputPerMTok: 1, outputPerMTok: 5 },
	// Google
	{ prefix: "gemini-2.5-pro", inputPerMTok: 1.25, outputPerMTok: 10 },
	{ prefix: "gemini-2.5-flash-lite", inputPerMTok: 0.1, outputPerMTok: 0.4 },
	{ prefix: "gemini-2.5-flash", inputPerMTok: 0.3, outputPerMTok: 2.5 },
	{ prefix: "gemini-2.0-flash", inputPerMTok: 0.1, outputPerMTok: 0.4 },
	// DeepSeek
	{ prefix: "deepseek-chat", inputPerMTok: 0.27, outputPerMTok: 1.1 },
	{ prefix: "deepseek-reasoner", inputPerMTok: 0.55, outputPerMTok: 2.19 },
	// Mistral
	{ prefix: "mistral-large", inputPerMTok: 2, outputPerMTok: 6 },
	{ prefix: "mistral-small", inputPerMTok: 0.1, outputPerMTok: 0.3 },
	// Meta (typical hosted-inference rates)
	{ prefix: "llama-3.1-405b", inputPerMTok: 3, outputPerMTok: 3 },
	{ prefix: "llama-3.1-70b", inputPerMTok: 0.6, outputPerMTok: 0.6 },
	{ prefix: "llama-3.1-8b", inputPerMTok: 0.1, outputPerMTok: 0.1 },
	{ prefix: "llama-3.3-70b", inputPerMTok: 0.6, outputPerMTok: 0.6 },
	// xAI
	{ prefix: "grok-4", inputPerMTok: 3, outputPerMTok: 15 },
	{ prefix: "grok-3-mini", inputPerMTok: 0.3, outputPerMTok: 0.5 },
	{ prefix: "grok-3", inputPerMTok: 3, outputPerMTok: 15 },
];

// Router/provider prefixes seen in the wild ahead of the bare model id:
// gateway ids ("openai/gpt-5"), Azure deployments ("azure/gpt-4o"), Bedrock
// ("us.anthropic.claude-sonnet-4-...-v1:0"), Vertex ("models/gemini-2.5-pro").
const STRIP_PREFIXES = [
	"openai/",
	"azure/",
	"anthropic/",
	"google/",
	"vertex_ai/",
	"vertex/",
	"bedrock/",
	"groq/",
	"xai/",
	"mistral/",
	"meta/",
	"meta-llama/",
	"deepseek/",
	"models/",
	"us.",
	"eu.",
	"apac.",
	"anthropic.",
	"amazon.",
];

export function normalizeModelId(model: string): string {
	let id = model.trim().toLowerCase();
	let stripped = true;
	while (stripped) {
		stripped = false;
		for (const prefix of STRIP_PREFIXES) {
			if (id.length > prefix.length && id.startsWith(prefix)) {
				id = id.slice(prefix.length);
				stripped = true;
			}
		}
	}
	return id;
}

/**
 * Estimate the USD cost of one call, or null when the model is unknown.
 * Rates are per 1M tokens; token counts of 0 legitimately price to 0.
 */
export function estimateLlmCostUsd(
	model: string,
	inputTokens: number,
	outputTokens: number,
): number | null {
	if (!model) return null;
	const id = normalizeModelId(model);
	let best: ModelPricing | null = null;
	for (const entry of MODEL_PRICING) {
		if (!id.startsWith(entry.prefix)) continue;
		if (!best || entry.prefix.length > best.prefix.length) best = entry;
	}
	if (!best) return null;
	const cost =
		(inputTokens / 1_000_000) * best.inputPerMTok +
		(outputTokens / 1_000_000) * best.outputPerMTok;
	return Math.round(cost * 1e6) / 1e6;
}
