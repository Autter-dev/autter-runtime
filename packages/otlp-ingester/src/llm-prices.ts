/**
 * Built-in LLM price table, USD per 1M tokens, standard (synchronous) tier.
 *
 * `LLM_PRICES_AS_OF` is the day these prices were read from the providers'
 * own pricing pages; it is stored on every row the table priced
 * (`runtime_llm_calls.pricing_version`), so a later price change never
 * rewrites history and a reader can tell which table produced a cost.
 * Bump it whenever an entry changes.
 *
 * Entry fields:
 * - `match`: a normalised model id (see llm-pricing.ts normalizeModelId).
 *   It matches that id exactly, or followed only by a snapshot suffix (a
 *   date, a Bedrock `-v1:0`, a Vertex `@20251101`, `-latest`), never by
 *   another version: `gpt-5` does not price `gpt-5.5`, `gpt-5-pro` or
 *   `gpt-5-mini`. A model with no entry is left unpriced (cost 0,
 *   `cost_source = 'none'`) rather than priced like a sibling.
 * - `cacheReadPerMTok`: a cache hit. Missing: cache reads cost the full
 *   input rate.
 * - `cacheWritePerMTok`: a cache write at the provider's short TTL
 *   (Anthropic 5 minutes, OpenAI 30 minutes). Missing: writes cost the full
 *   input rate (OpenAI before GPT-5.6 and Gemini charge no write premium).
 * - `cacheWriteLongPerMTok`: a cache write at the long TTL (Anthropic 1
 *   hour, OpenAI 12 hours). Missing: the short write rate.
 * - `effectiveFrom`: the first UTC day the entry applies (a dated price
 *   change). For one `match`, a call is priced by the latest entry whose
 *   `effectiveFrom` is on or before the call's start (an entry without one
 *   applies from the beginning).
 * - `source`: where the price was read.
 *
 * Out of scope, by decision: long-context tiers (Anthropic Haiku 5.5 over
 * 100K prompt tokens, OpenAI over 272K, Gemini Pro over 200K are priced at
 * the short-context rate), batch / flex / fast / priority tiers, regional
 * and data-residency uplifts, Bedrock and Vertex partner pricing (priced at
 * the first-party rate), audio-input rates, and Gemini context-cache
 * storage (billed per hour, not per call). Self-hosted deployments can
 * correct any of these with an override file (AUTTER_LLM_PRICES_FILE).
 */

export interface LlmPriceEntry {
	/** Normalised model id; matched on a version boundary. */
	match: string;
	inputPerMTok: number;
	outputPerMTok: number;
	cacheReadPerMTok?: number;
	cacheWritePerMTok?: number;
	cacheWriteLongPerMTok?: number;
	/** YYYY-MM-DD (UTC): the first day this price applies. */
	effectiveFrom?: string;
	/** Where the price was read. */
	source?: string;
}

/** The day the built-in prices were read; stored as `pricing_version`. */
export const LLM_PRICES_AS_OF = "2026-11-14";

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const GEMINI = "https://aistudio.google.com/docs/pricing";
/**
 * Carried over from the table before 1.16.0. The model is no longer on its
 * provider's pricing page (or the provider is not one of the three above),
 * so the rate was not re-read and no cache rates are known.
 */
const LEGACY = "pre-1.16 table; not on the provider's pricing page on 2026-11-14, not re-verified";

/** Anthropic: writes 1.25x (5 min) and 2x (1 h); reads 0.1x, except where noted. */
function anthropic(
	match: string,
	input: number,
	output: number,
	read: number,
	write: number,
	writeLong: number,
): LlmPriceEntry {
	return {
		match,
		inputPerMTok: input,
		outputPerMTok: output,
		cacheReadPerMTok: read,
		cacheWritePerMTok: write,
		cacheWriteLongPerMTok: writeLong,
		source: ANTHROPIC,
	};
}

/** OpenAI: cached input per model; write rates (30 min / 12 h) from GPT-5.6 on. */
function openai(
	match: string,
	input: number,
	output: number,
	read?: number,
	write?: number,
	writeLong?: number,
): LlmPriceEntry {
	return {
		match,
		inputPerMTok: input,
		outputPerMTok: output,
		...(read !== undefined ? { cacheReadPerMTok: read } : {}),
		...(write !== undefined ? { cacheWritePerMTok: write } : {}),
		...(writeLong !== undefined ? { cacheWriteLongPerMTok: writeLong } : {}),
		source: OPENAI,
	};
}

/** Gemini: per-model cached input (implicit caching); no write premium. */
function gemini(match: string, input: number, output: number, read: number, effectiveFrom?: string): LlmPriceEntry {
	return {
		match,
		inputPerMTok: input,
		outputPerMTok: output,
		cacheReadPerMTok: read,
		...(effectiveFrom ? { effectiveFrom } : {}),
		source: GEMINI,
	};
}

function legacy(match: string, input: number, output: number): LlmPriceEntry {
	return { match, inputPerMTok: input, outputPerMTok: output, source: LEGACY };
}

export const BUILTIN_LLM_PRICES: LlmPriceEntry[] = [
	// Anthropic — first-party API rates. Reads are 0.025x on Fable / Mythos
	// 5.1-5.2 and 0.05x on Opus 5.5 / Sonnet 5.5, 0.1x elsewhere.
	anthropic("claude-fable-5-2", 8, 40, 0.2, 10, 16),
	anthropic("claude-mythos-5-2", 8, 40, 0.2, 10, 16),
	anthropic("claude-fable-5-1", 10, 50, 0.25, 12.5, 20),
	anthropic("claude-mythos-5-1", 10, 50, 0.25, 12.5, 20),
	anthropic("claude-fable-5", 10, 50, 1, 12.5, 20),
	anthropic("claude-mythos-5", 10, 50, 1, 12.5, 20),
	anthropic("claude-opus-5-5", 4, 20, 0.2, 5, 8),
	anthropic("claude-opus-5", 5, 25, 0.5, 6.25, 10),
	anthropic("claude-opus-4-8", 5, 25, 0.5, 6.25, 10),
	anthropic("claude-opus-4-7", 5, 25, 0.5, 6.25, 10),
	anthropic("claude-opus-4-6", 5, 25, 0.5, 6.25, 10),
	anthropic("claude-opus-4-5", 5, 25, 0.5, 6.25, 10),
	anthropic("claude-opus-4-1", 15, 75, 1.5, 18.75, 30),
	anthropic("claude-opus-4", 15, 75, 1.5, 18.75, 30),
	anthropic("claude-sonnet-5-5", 2, 10, 0.1, 2.5, 4),
	anthropic("claude-sonnet-5", 2, 10, 0.2, 2.5, 4),
	anthropic("claude-sonnet-4-6", 3, 15, 0.3, 3.75, 6),
	anthropic("claude-sonnet-4-5", 3, 15, 0.3, 3.75, 6),
	anthropic("claude-sonnet-4", 3, 15, 0.3, 3.75, 6),
	// Prompts up to 100K tokens ($0.50 / $2.50 above: long-context, out of scope).
	anthropic("claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125, 0.2),
	anthropic("claude-haiku-4-5", 1, 5, 0.1, 1.25, 2),
	legacy("claude-3-5-haiku", 0.8, 4),

	// OpenAI — short-context (<= 272K input) rates. GPT-5.6 and GPT-6 charge
	// cache writes (1.25x for 30 minutes, 2.5x for 12 hours); earlier models
	// charge none. GPT-5.6 Sol's rates are promotional until 2026-11-30; the
	// page does not say what follows.
	openai("gpt-6-astra", 10, 50, 1, 12.5, 25),
	openai("gpt-6.1-sol", 2, 10, 0.1, 2.5, 5),
	openai("gpt-6.1-terra", 1, 5, 0.05, 1.25, 2.5),
	openai("gpt-6-sol", 2, 10, 0.2, 2.5, 5),
	openai("gpt-6-luna", 0.1, 0.5, 0.01, 0.125, 0.25),
	openai("gpt-5.6-sol", 4, 20, 0.4, 5, 10),
	openai("gpt-5.6-terra", 2, 12, 0.2, 2.5, 5),
	openai("gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25, 0.5),
	openai("gpt-5.5", 5, 30, 0.5),
	openai("gpt-5.5-pro", 30, 180),
	openai("gpt-5.4", 2.5, 15, 0.25),
	openai("gpt-5.4-pro", 30, 180),
	openai("gpt-5.4-mini", 0.75, 4.5, 0.075),
	openai("gpt-5.4-nano", 0.2, 1.25, 0.02),
	openai("gpt-5.3-codex", 1.75, 14, 0.175),
	openai("gpt-5.2", 1.75, 14, 0.175),
	openai("gpt-5.2-pro", 21, 168),
	openai("gpt-5.1", 1.25, 10, 0.125),
	openai("gpt-5", 1.25, 10, 0.125),
	openai("gpt-5-mini", 0.25, 2, 0.025),
	openai("gpt-5-nano", 0.05, 0.4, 0.005),
	openai("gpt-5-pro", 15, 120),
	openai("gpt-4.1", 2, 8, 0.5),
	openai("gpt-4.1-mini", 0.4, 1.6, 0.1),
	openai("gpt-4o", 2.5, 10, 1.25),
	openai("gpt-4o-mini", 0.15, 0.6, 0.075),
	openai("o3", 2, 8, 0.5),
	openai("o3-pro", 20, 80),
	openai("text-embedding-3-small", 0.02, 0),
	openai("text-embedding-3-large", 0.13, 0),
	openai("text-embedding-ada-002", 0.1, 0),
	legacy("gpt-4.1-nano", 0.1, 0.4),
	legacy("o3-mini", 1.1, 4.4),
	legacy("o4-mini", 1.1, 4.4),

	// Google Gemini API — paid tier, text input, prompts <= 200K tokens.
	// Dated changes: Gemini 4 Carbon / Argon double on 2026-12-01, Gemini
	// 3.6 / 3.8 Flash on 2027-01-01.
	gemini("gemini-4-carbon", 2, 10, 0.1),
	gemini("gemini-4-carbon", 4, 20, 0.2, "2026-12-01"),
	gemini("gemini-4-argon", 2, 10, 0.1),
	gemini("gemini-4-argon", 4, 20, 0.2, "2026-12-01"),
	gemini("gemini-4-hydrogen", 1.5, 7.5, 0.075),
	gemini("gemini-3.8-flash", 0.75, 3.75, 0.075),
	gemini("gemini-3.8-flash", 1.5, 7.5, 0.15, "2027-01-01"),
	gemini("gemini-3.6-flash", 0.75, 3.75, 0.075),
	gemini("gemini-3.6-flash", 1.5, 7.5, 0.15, "2027-01-01"),
	gemini("gemini-3.5-flash-lite", 0.3, 2.5, 0.03),
	gemini("gemini-3.1-pro-preview", 2, 12, 0.2),
	gemini("gemini-3.1-flash-lite", 0.25, 1.5, 0.025),
	gemini("gemini-3-flash-preview", 0.5, 3, 0.05),
	gemini("gemini-2.5-pro", 1.25, 10, 0.125),
	gemini("gemini-2.5-flash", 0.3, 2.5, 0.03),
	gemini("gemini-2.5-flash-lite", 0.1, 0.4, 0.01),
	legacy("gemini-2.0-flash", 0.1, 0.4),

	// Other providers: carried over unchanged, not re-verified.
	legacy("deepseek-chat", 0.27, 1.1),
	legacy("deepseek-reasoner", 0.55, 2.19),
	legacy("mistral-large", 2, 6),
	legacy("mistral-small", 0.1, 0.3),
	legacy("llama-3.1-405b", 3, 3),
	legacy("llama-3.1-70b", 0.6, 0.6),
	legacy("llama-3.1-8b", 0.1, 0.1),
	legacy("llama-3.3-70b", 0.6, 0.6),
	legacy("grok-4", 3, 15),
	legacy("grok-3-mini", 0.3, 0.5),
	legacy("grok-3", 3, 15),
];
