/**
 * Built-in LLM price table — USD per 1M tokens, `[prefix, input, output]`,
 * matched against a normalised model id (longest prefix wins). Used only
 * when a call doesn't report its exact cost via the `autter.llm.cost_usd`
 * span attribute; rows written from here are marked `cost_source =
 * 'estimated'` so consumers can tell the two apart.
 *
 * Deliberately compact: the common OpenAI / Anthropic / Google models.
 * Prices drift — PRs updating this table are welcome.
 */
const PRICES_PER_MILLION: Array<[prefix: string, input: number, output: number]> = [
	// OpenAI
	["gpt-5-nano", 0.05, 0.4],
	["gpt-5-mini", 0.25, 2],
	["gpt-5", 1.25, 10],
	["gpt-4.1-nano", 0.1, 0.4],
	["gpt-4.1-mini", 0.4, 1.6],
	["gpt-4.1", 2, 8],
	["gpt-4o-mini", 0.15, 0.6],
	["gpt-4o", 2.5, 10],
	["o3-mini", 1.1, 4.4],
	["o3", 2, 8],
	["o4-mini", 1.1, 4.4],
	["text-embedding-3-small", 0.02, 0],
	["text-embedding-3-large", 0.13, 0],
	// Anthropic
	["claude-opus-4-5", 5, 25],
	["claude-opus-4", 15, 75],
	["claude-sonnet-4", 3, 15],
	["claude-haiku-4-5", 1, 5],
	["claude-3-7-sonnet", 3, 15],
	["claude-3-5-haiku", 0.8, 4],
	["claude-3-haiku", 0.25, 1.25],
	// Google
	["gemini-2.5-flash-lite", 0.1, 0.4],
	["gemini-2.5-flash", 0.3, 2.5],
	["gemini-2.5-pro", 1.25, 10],
	["gemini-2.0-flash-lite", 0.075, 0.3],
	["gemini-2.0-flash", 0.1, 0.4],
];

// Longest prefix first so "gpt-5-mini" never falls through to "gpt-5".
const SORTED = [...PRICES_PER_MILLION].sort(
	(a, b) => b[0].length - a[0].length,
);

/**
 * Model ids arrive in provider-specific shapes: "gpt-4o-2024-08-06",
 * "models/gemini-2.5-pro", "openai/gpt-4o" (routers), "us.anthropic.claude-…"
 * (Bedrock). Lowercase and strip any path/namespace prefix; date suffixes
 * are handled by prefix matching.
 */
function normalizeModelId(model: string): string {
	let id = model.trim().toLowerCase();
	const slash = id.lastIndexOf("/");
	if (slash !== -1) id = id.slice(slash + 1);
	// Bedrock-style "us.anthropic.claude-sonnet-4-…" → "claude-sonnet-4-…"
	const match = id.match(/(?:^|\.)((?:gpt|o\d|claude|gemini|text-embedding)[^.]*)$/);
	if (match?.[1]) id = match[1];
	return id;
}

/** Estimated USD cost for a call, or null when the model isn't in the table. */
export function estimateLlmCostUsd(
	model: string,
	inputTokens: number,
	outputTokens: number,
): number | null {
	const id = normalizeModelId(model);
	for (const [prefix, input, output] of SORTED) {
		if (id.startsWith(prefix)) {
			return (inputTokens * input + outputTokens * output) / 1_000_000;
		}
	}
	return null;
}
