import type { Attributes } from "@opentelemetry/api";

/**
 * Cache-aware LLM token usage: one normalised shape for every provider, and
 * the span attributes Autter emits for it.
 *
 * The convention ("total") every Autter LLM span follows:
 *
 * - `gen_ai.usage.input_tokens`: ALL prompt tokens, cache reads and cache
 *   writes included. Anthropic and Bedrock report the uncached part only
 *   (`input_tokens`/`inputTokens` exclude `cache_*`), so their counts are
 *   added up here; OpenAI (Chat and Responses), OpenRouter and Gemini
 *   already report the total.
 * - `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`:
 *   subsets of input.
 * - `autter.llm.cache_creation.long_ttl_tokens`: the part of the cache writes
 *   at the long TTL (Anthropic 1 h, OpenAI 12 h), when the provider says.
 * - `gen_ai.usage.output_tokens`: ALL output, reasoning included. Gemini
 *   reports thoughts separately from candidates, so they are added here.
 * - `gen_ai.usage.reasoning.output_tokens`: subset of output.
 * - `autter.llm.usage_convention = "total"`: marks the span as following this
 *   convention, so the ingester never adds the cache counts twice.
 * - `autter.llm.cost_usd`: provider-reported cost in USD, when there is one.
 */

export const USAGE_CONVENTION_ATTR = "autter.llm.usage_convention";
export const USAGE_CONVENTION = "total";
/** Compat-manifest feature id for the cache-aware usage attributes. */
export const LLM_CACHE_TOKENS_FEATURE = "llm_cache_tokens";

/** Normalised usage of one call ("total" convention, see above). */
export interface NormalizedUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cacheWriteLongTtlTokens?: number;
	reasoningTokens?: number;
	costUsd?: number;
}

/**
 * Raw per-provider counts, before normalisation. Streams merge these
 * field by field (a later chunk overwrites what it reports), then
 * `finalizeUsage` derives the totals, so a cumulative counter that a later
 * event leaves out (Anthropic's message_delta without cache fields) keeps
 * the earlier value.
 */
export interface RawUsage {
	/** Prompt tokens as reported. */
	input?: number;
	/** true: `input` already includes cache reads/writes (OpenAI, Gemini). */
	inputIncludesCache?: boolean;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWriteLongTtl?: number;
	/** Output tokens as reported. */
	output?: number;
	reasoning?: number;
	/** true: `reasoning` is NOT part of `output` (Gemini thoughts). */
	reasoningSeparate?: boolean;
	costUsd?: number;
	responseModel?: string;
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | undefined {
	return value !== null && typeof value === "object" ? (value as Obj) : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function sum(...values: (number | undefined)[]): number | undefined {
	let total: number | undefined;
	for (const value of values) {
		if (value !== undefined) total = (total ?? 0) + value;
	}
	return total;
}

function defined<T extends object>(value: T): T {
	for (const key of Object.keys(value) as (keyof T)[]) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}

/** Gemini `usageMetadata` (Google GenAI, Vertex). */
function fromGemini(meta: Obj): RawUsage {
	const prompt = num(meta.promptTokenCount);
	const toolUse = num(meta.toolUsePromptTokenCount);
	return defined({
		// promptTokenCount already counts cachedContentTokenCount; tool-use
		// prompt tokens are billed as input but reported apart.
		input: prompt === undefined && toolUse === undefined ? undefined : sum(prompt, toolUse),
		inputIncludesCache: prompt !== undefined || toolUse !== undefined ? true : undefined,
		cacheRead: num(meta.cachedContentTokenCount),
		output: num(meta.candidatesTokenCount),
		reasoning: num(meta.thoughtsTokenCount),
		reasoningSeparate: num(meta.thoughtsTokenCount) !== undefined ? true : undefined,
	});
}

/** Bedrock Converse `TokenUsage` (camelCase; inputTokens excludes cache). */
function fromBedrock(usage: Obj): RawUsage {
	const details = Array.isArray(usage.cacheDetails) ? usage.cacheDetails : undefined;
	let longTtl: number | undefined;
	if (details) {
		for (const detail of details) {
			const d = obj(detail);
			if (d && d.ttl === "1h") longTtl = sum(longTtl, num(d.inputTokens)) ?? longTtl;
		}
		longTtl ??= 0;
	}
	const input = num(usage.inputTokens);
	return defined({
		input,
		inputIncludesCache: input !== undefined ? false : undefined,
		cacheRead: num(usage.cacheReadInputTokens),
		cacheWrite: num(usage.cacheWriteInputTokens),
		cacheWriteLongTtl: longTtl,
		output: num(usage.outputTokens),
	});
}

/** OpenAI Chat Completions shape (also OpenRouter, Groq, Mistral, DeepSeek…). */
function fromOpenAiChat(usage: Obj, provider: string): RawUsage {
	const prompt = obj(usage.prompt_tokens_details);
	const completion = obj(usage.completion_tokens_details);
	const writeDetails = obj(prompt?.cache_write_tokens_details);
	const input = num(usage.prompt_tokens);
	return defined({
		input,
		inputIncludesCache: input !== undefined ? true : undefined,
		// DeepSeek reports prompt_cache_hit_tokens (a subset of prompt_tokens).
		cacheRead: num(prompt?.cached_tokens) ?? num(usage.prompt_cache_hit_tokens),
		cacheWrite: num(prompt?.cache_write_tokens),
		cacheWriteLongTtl: num(writeDetails?.ttl_12h_tokens),
		output: num(usage.completion_tokens),
		reasoning: num(completion?.reasoning_tokens),
		costUsd: reportedCost(usage, provider),
	});
}

/**
 * `input_tokens` shape: OpenAI Responses (has `input_tokens_details`, input
 * includes cache) or Anthropic (no details object, input excludes cache).
 */
function fromInputTokens(usage: Obj, provider: string): RawUsage {
	const inputDetails = obj(usage.input_tokens_details);
	const input = num(usage.input_tokens);
	if (inputDetails) {
		const outputDetails = obj(usage.output_tokens_details);
		const writeDetails = obj(inputDetails.cache_write_tokens_details);
		return defined({
			input,
			inputIncludesCache: input !== undefined ? true : undefined,
			cacheRead: num(inputDetails.cached_tokens),
			cacheWrite: num(inputDetails.cache_write_tokens),
			cacheWriteLongTtl: num(writeDetails?.ttl_12h_tokens),
			output: num(usage.output_tokens),
			reasoning: num(outputDetails?.reasoning_tokens),
			costUsd: reportedCost(usage, provider),
		});
	}
	// Anthropic: total = input_tokens + cache_read + cache_creation.
	const cacheCreation = obj(usage.cache_creation);
	const outputDetails = obj(usage.output_tokens_details);
	const hasCacheCounters =
		num(usage.cache_read_input_tokens) !== undefined ||
		num(usage.cache_creation_input_tokens) !== undefined;
	return defined({
		input,
		inputIncludesCache: input !== undefined || hasCacheCounters ? false : undefined,
		cacheRead: num(usage.cache_read_input_tokens),
		cacheWrite: num(usage.cache_creation_input_tokens),
		cacheWriteLongTtl: num(cacheCreation?.ephemeral_1h_input_tokens),
		output: num(usage.output_tokens),
		reasoning: num(outputDetails?.thinking_tokens),
	});
}

/**
 * OpenRouter's `usage.cost`. OpenRouter bills in credits whose base currency
 * is the US dollar ("OpenRouter uses a credit system where the base currency
 * is US dollars", https://openrouter.ai/docs/faq), so `cost` is USD. For a
 * BYOK request `cost` is only OpenRouter's fee and the provider's charge is
 * `cost_details.upstream_inference_cost`
 * (https://openrouter.ai/docs/use-cases/usage-accounting): both are added.
 * Other OpenAI-compatible gateways' `cost` fields are not trusted (unknown
 * unit), so this applies to the openrouter provider only.
 */
function reportedCost(usage: Obj, provider: string): number | undefined {
	if (provider !== "openrouter") return undefined;
	const cost = num(usage.cost);
	if (cost === undefined) return undefined;
	const upstream = num(obj(usage.cost_details)?.upstream_inference_cost);
	return usage.is_byok === true && upstream !== undefined ? cost + upstream : cost;
}

/** Usage object of any known provider shape, or undefined. */
function fromUsageObject(usage: Obj, provider: string): RawUsage | undefined {
	if ("prompt_tokens" in usage || "completion_tokens" in usage) {
		return fromOpenAiChat(usage, provider);
	}
	if ("input_tokens" in usage || "output_tokens" in usage || "cache_read_input_tokens" in usage) {
		return fromInputTokens(usage, provider);
	}
	if ("inputTokens" in usage || "outputTokens" in usage || "cacheReadInputTokens" in usage) {
		return fromBedrock(usage);
	}
	return undefined;
}

/**
 * Probe a response, stream chunk or stream event for usage and the served
 * model. Shapes: OpenAI Chat (and chunks), OpenAI Responses (and the
 * `response.*` stream events, usage on `response.completed`), Anthropic
 * messages (and `message_start` / `message_delta` events), Gemini
 * `usageMetadata`, Bedrock Converse (and the ConverseStream `metadata`
 * event), OpenRouter.
 */
export function extractRawUsage(result: unknown, provider: string): RawUsage {
	const r = obj(result);
	if (!r) return {};
	// OpenAI Responses stream events carry the response object.
	const nestedResponse = obj(r.response);
	if (nestedResponse && typeof r.type === "string" && r.type.startsWith("response.")) {
		return extractRawUsage(nestedResponse, provider);
	}
	// Anthropic message_start carries the message (model + initial usage).
	const message = obj(r.message);
	let raw: RawUsage | undefined;
	const meta = obj(r.usageMetadata);
	if (meta) raw = fromGemini(meta);
	const usage = obj(r.usage) ?? obj(message?.usage) ?? obj(obj(r.metadata)?.usage);
	if (!raw && usage) raw = fromUsageObject(usage, provider);
	raw ??= {};
	const model = str(r.model) ?? str(r.modelVersion) ?? str(message?.model);
	if (model) raw.responseModel = model;
	return raw;
}

/** Fold a later chunk's counts into the stream's (present fields win). */
export function mergeRawUsage(into: RawUsage, next: RawUsage): void {
	for (const [key, value] of Object.entries(next)) {
		if (value !== undefined) (into as Record<string, unknown>)[key] = value;
	}
}

/** Derive the "total" convention from raw counts. */
export function finalizeUsage(raw: RawUsage): NormalizedUsage {
	let input = raw.input;
	if (input !== undefined && raw.inputIncludesCache === false) {
		input += (raw.cacheRead ?? 0) + (raw.cacheWrite ?? 0);
	} else if (input === undefined && raw.inputIncludesCache === false) {
		input = sum(raw.cacheRead, raw.cacheWrite);
	}
	let output = raw.output;
	if (raw.reasoningSeparate && raw.reasoning !== undefined) {
		output = (output ?? 0) + raw.reasoning;
	}
	return defined({
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: raw.cacheRead,
		cacheWriteTokens: raw.cacheWrite,
		cacheWriteLongTtlTokens: raw.cacheWriteLongTtl,
		reasoningTokens: raw.reasoning,
		costUsd: raw.costUsd,
	});
}

function count(value: number | undefined): number | undefined {
	return value === undefined || !Number.isFinite(value)
		? undefined
		: Math.max(0, Math.round(value));
}

/** The contract attributes for one call's usage (only fields that are set). */
export function usageContractAttributes(usage: NormalizedUsage): Attributes {
	const attrs: Attributes = {};
	const set = (key: string, value: number | undefined) => {
		const c = count(value);
		if (c !== undefined) attrs[key] = c;
	};
	set("gen_ai.usage.input_tokens", usage.inputTokens);
	set("gen_ai.usage.output_tokens", usage.outputTokens);
	set("gen_ai.usage.cache_read.input_tokens", usage.cacheReadTokens);
	set("gen_ai.usage.cache_creation.input_tokens", usage.cacheWriteTokens);
	set("autter.llm.cache_creation.long_ttl_tokens", usage.cacheWriteLongTtlTokens);
	set("gen_ai.usage.reasoning.output_tokens", usage.reasoningTokens);
	if (
		typeof usage.costUsd === "number" &&
		Number.isFinite(usage.costUsd) &&
		usage.costUsd >= 0
	) {
		attrs["autter.llm.cost_usd"] = usage.costUsd;
	}
	return attrs;
}

/** True when the usage carries any of the cache/reasoning counts. */
export function hasCacheOrReasoning(usage: NormalizedUsage): boolean {
	return (
		usage.cacheReadTokens !== undefined ||
		usage.cacheWriteTokens !== undefined ||
		usage.cacheWriteLongTtlTokens !== undefined ||
		usage.reasoningTokens !== undefined
	);
}
