import { estimateLlmCost } from "./llm-pricing.js";
import { isSensitiveKey, isUsageCountKey, scrubText } from "./redact.js";
import type { RuntimeLlmCall } from "./types.js";

/**
 * LLM-call extraction from OTLP spans. Four attribute families are
 * recognised, so most stacks work with zero Autter-specific code:
 *
 * 1. OpenTelemetry GenAI semantic conventions (`gen_ai.*`) — emitted by
 *    OpenLLMetry, OpenLIT, the official OTel instrumentations, and
 *    @autter/runtime-node's own `withLlmCall`/`trackLlmCall` helpers.
 * 2. Vercel AI SDK telemetry (`ai.*` spans from `experimental_telemetry`).
 *    Only the provider-level `.doGenerate`/`.doStream`/`.doEmbed` spans
 *    become calls — the umbrella `ai.generateText` span aggregates its
 *    children's usage and would double-count.
 * 3. OpenInference (`llm.model_name`, `llm.token_count.*`, `llm.cost.total`;
 *    Arize Phoenix and its instrumentations). Only `LLM` and `EMBEDDING`
 *    spans become calls: agent, chain and tool spans wrap them.
 * 4. Autter extension attributes (`autter.llm.cost_usd`, `autter.user_id`,
 *    `autter.session_id`, `autter.llm.usage_convention`,
 *    `autter.llm.cache_creation.long_ttl_tokens`).
 *
 * Token contract (shared with the Autter SDKs): input is the TOTAL prompt,
 * cache reads and cache writes included, and cache reads / writes / long-TTL
 * writes are subsets of it; output is the total, reasoning included, and
 * reasoning is a subset. `autter.llm.usage_convention = "total"` (set by
 * Autter SDKs) says input already is the total. Without it the span is read
 * as the OTel semconv says (inclusive) unless cache read + cache write
 * exceed input, which only an exclusive count can produce (Anthropic's API
 * and instrumentations that copy it): then the total is input + read +
 * write. An exclusive count whose cache tokens do not exceed its uncached
 * input cannot be told apart and is read as inclusive (it under-counts).
 *
 * Cost precedence: reported (`autter.llm.cost_usd` → `gen_ai.usage.cost` →
 * `ai.usage.cost` → `llm.cost.total`) → estimated, cache-aware, from the
 * price table (llm-pricing.ts) → 0 with costSource "none".
 */

const VERCEL_PROVIDER_CALL = /\.do(Generate|Stream|Embed)$/;

function numAttr(
	attrs: Map<string, string>,
	...keys: string[]
): number | null {
	for (const key of keys) {
		const raw = attrs.get(key);
		if (raw === undefined) continue;
		const value = Number(raw);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

function strAttr(
	attrs: Map<string, string>,
	...keys: string[]
): string | null {
	for (const key of keys) {
		const raw = attrs.get(key);
		if (raw !== undefined && raw !== "") return raw;
	}
	return null;
}

/** "ai.generateText.doGenerate" → "generateText"; "ai.embed.doEmbed" → "embed". */
function vercelOperation(name: string): string {
	const parts = name.split(".");
	return parts.length >= 2 ? (parts[1] ?? "") : "";
}

export interface LlmSpanFacts {
	name: string;
	traceId: string;
	spanId: string;
	isError: boolean;
	/** exception.type from the span's exception event, if it had one. */
	exceptionType: string | null;
	durationMs: number;
	startedAt: Date;
	service: string;
	environment: string;
	release: string | null;
	/** OTLP span kind, lowercased ("internal", "client", …); absent = unknown. */
	spanKind?: string;
}

/** OpenInference span kinds that are model calls; the others (AGENT, CHAIN, TOOL, …) wrap them. */
const OPENINFERENCE_CALL_KINDS = new Set(["LLM", "EMBEDDING"]);

/**
 * GenAI semconv operations that are never a model call of their own:
 * running a tool, and creating an agent. (`invoke_*` is handled apart:
 * see isAggregateAgentSpan.)
 */
const NON_CALL_OPERATIONS = new Set(["execute_tool", "create_agent"]);

/**
 * An in-process agent, workflow or framework entrypoint (`invoke_agent`,
 * `invoke_workflow`, `invoke_<entrypoint>`, span kind INTERNAL). Its usage,
 * when present, sums the model calls it made, and those are their own
 * `chat` / `text_completion` child spans: counting both doubles the tokens
 * and the cost. A CLIENT `invoke_agent` span is a call to a remote agent
 * service, whose model calls are not in the trace, so it stays a row.
 */
function isAggregateAgentSpan(operation: string | null, spanKind: string | undefined): boolean {
	return operation !== null && operation.startsWith("invoke_") && spanKind === "internal";
}

/** A non-negative whole token count. */
function tokens(value: number | null): number {
	return value !== null && value > 0 ? Math.round(value) : 0;
}

/**
 * Returns the LLM-call row for a span, or null when the span is not an LLM
 * provider call. Never throws — attribute soup from arbitrary SDKs must not
 * take down the ingest path.
 */
export function extractLlmCall(
	attrs: Map<string, string>,
	facts: LlmSpanFacts,
): RuntimeLlmCall | null {
	const isVercelSpan = facts.name.startsWith("ai.");
	// Umbrella Vercel spans (ai.generateText, ai.streamText, ai.toolCall, …)
	// are skipped: usage lives on (and aggregates) their .do* children.
	if (isVercelSpan && !VERCEL_PROVIDER_CALL.test(facts.name)) return null;
	const openInferenceKind = strAttr(attrs, "openinference.span.kind")?.toUpperCase() ?? null;
	if (openInferenceKind !== null && !OPENINFERENCE_CALL_KINDS.has(openInferenceKind)) return null;
	const semconvOperation = strAttr(attrs, "gen_ai.operation.name");
	if (semconvOperation !== null && NON_CALL_OPERATIONS.has(semconvOperation)) return null;
	if (isAggregateAgentSpan(semconvOperation, facts.spanKind)) return null;

	const model = strAttr(
		attrs,
		"gen_ai.response.model",
		"gen_ai.request.model",
		"ai.response.model",
		"ai.model.id",
		"llm.model_name",
	);
	// gen_ai.provider.name is the current semconv key, gen_ai.system the
	// pre-1.37 one. Vercel's ai.model.provider looks like "openai.chat" —
	// keep the provider segment, the mode is already in `operation`.
	// OpenInference: llm.provider ("openai", "azure") or llm.system.
	const provider =
		strAttr(attrs, "gen_ai.provider.name", "gen_ai.system") ??
		strAttr(attrs, "ai.model.provider")?.toLowerCase().split(".")[0] ??
		strAttr(attrs, "llm.provider", "llm.system") ??
		null;
	// A call must identify at least a model or a provider system — this is
	// what keeps ordinary spans (HTTP, DB, tool calls) out of the table.
	if (!model && !provider) return null;

	const reportedInput = tokens(
		numAttr(
			attrs,
			"gen_ai.usage.input_tokens",
			"gen_ai.usage.prompt_tokens",
			"ai.usage.promptTokens",
			"ai.usage.inputTokens",
			"llm.token_count.prompt",
			// Vercel .doEmbed spans report a single total under ai.usage.tokens.
			"ai.usage.tokens",
		),
	);
	const outputTokens = tokens(
		numAttr(
			attrs,
			"gen_ai.usage.output_tokens",
			"gen_ai.usage.completion_tokens",
			"ai.usage.completionTokens",
			"ai.usage.outputTokens",
			"llm.token_count.completion",
		),
	);
	const cacheReadTokens = tokens(
		numAttr(
			attrs,
			"gen_ai.usage.cache_read.input_tokens",
			"gen_ai.usage.cache_read_input_tokens", // OpenLLMetry
			"ai.usage.cachedInputTokens", // Vercel AI SDK
			"llm.token_count.prompt_details.cache_read", // OpenInference
		),
	);
	const cacheWriteTokens = tokens(
		numAttr(
			attrs,
			"gen_ai.usage.cache_creation.input_tokens",
			"gen_ai.usage.cache_creation_input_tokens", // OpenLLMetry
			"llm.token_count.prompt_details.cache_write", // OpenInference
		),
	);
	const cacheWriteLongTokens = Math.min(
		tokens(numAttr(attrs, "autter.llm.cache_creation.long_ttl_tokens")),
		cacheWriteTokens,
	);
	const reasoningTokens = tokens(
		numAttr(
			attrs,
			"gen_ai.usage.reasoning.output_tokens",
			"gen_ai.usage.reasoning_tokens",
			"ai.usage.reasoningTokens",
			"llm.token_count.completion_details.reasoning",
		),
	);
	const inputTokens = totalInputTokens(
		reportedInput,
		cacheReadTokens,
		cacheWriteTokens,
		strAttr(attrs, "autter.llm.usage_convention"),
	);

	const reportedCost = numAttr(
		attrs,
		"autter.llm.cost_usd",
		"gen_ai.usage.cost",
		"ai.usage.cost",
		"llm.cost.total",
	);
	let costUsd = 0;
	let costSource: RuntimeLlmCall["costSource"] = "none";
	let pricingVersion = "";
	if (reportedCost !== null && reportedCost >= 0) {
		costUsd = reportedCost;
		costSource = "reported";
	} else {
		const estimated = estimateLlmCost(
			model ?? "",
			{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWriteLongTokens },
			facts.startedAt,
		);
		if (estimated !== null) {
			costUsd = estimated.costUsd;
			costSource = "estimated";
			pricingVersion = estimated.pricingVersion;
		}
	}

	const operation =
		semconvOperation ??
		(isVercelSpan ? vercelOperation(facts.name) : null) ??
		strAttr(attrs, "llm.request.type") ??
		openInferenceKind?.toLowerCase() ??
		"";

	return {
		service: facts.service,
		environment: facts.environment,
		release: facts.release,
		traceId: facts.traceId,
		spanId: facts.spanId,
		provider: (provider ?? "").slice(0, 100),
		model: (model ?? "").slice(0, 200),
		operation: operation.slice(0, 100),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		cacheWriteLongTokens,
		reasoningTokens,
		costUsd,
		costSource,
		pricingVersion,
		durationMs: facts.durationMs,
		status: facts.isError ? "error" : "ok",
		errorType: facts.isError
			? (strAttr(attrs, "error.type") ?? facts.exceptionType ?? "Error").slice(
					0,
					200,
				)
			: "",
		userId: scrubText(
			strAttr(
				attrs,
				"autter.user_id",
				"ai.telemetry.metadata.userId",
				"ai.telemetry.metadata.user_id",
				"enduser.id",
				"user.id",
			) ?? "",
		).slice(0, 200),
		sessionId: scrubText(
			strAttr(
				attrs,
				"autter.session_id",
				"ai.telemetry.metadata.sessionId",
				"session.id",
			) ?? "",
		).slice(0, 200),
		attributes: llmAttributeSubset(attrs),
		startedAt: facts.startedAt,
	};
}

/**
 * Total prompt tokens under the shared contract. `"total"` (Autter SDKs):
 * input is already the total. Otherwise inclusive (OTel semconv), unless the
 * cache counts exceed the input, which only an exclusive count (Anthropic's
 * API) produces: then input + read + write.
 */
export function totalInputTokens(
	input: number,
	cacheRead: number,
	cacheWrite: number,
	convention: string | null,
): number {
	if (convention === "total") return input;
	return cacheRead + cacheWrite > input ? input + cacheRead + cacheWrite : input;
}

/** Numeric token counters are kept even though their keys contain "token"
 * — cost tracking depends on them (redact.ts isUsageCountKey). */
function isUsageCount(key: string, value: string): boolean {
	return isUsageCountKey(key) && /^\d+(\.\d+)?$/.test(value);
}

/**
 * The OpenInference keys kept for drill-down: usage, cost, model, provider
 * and span kind. Its other `llm.*` keys carry messages and prompt templates,
 * which stay out of the table (privacy is whitelist-based).
 */
const OPENINFERENCE_USAGE_KEY =
	/^(?:llm\.token_count\.|llm\.cost\.|llm\.model_name$|llm\.provider$|llm\.system$|openinference\.span\.kind$)/;

/**
 * Drill-down context stored as JSON alongside the typed columns: only the
 * LLM-relevant attribute families, size-capped so a prompt accidentally
 * stuffed into an attribute can't bloat the row.
 */
function llmAttributeSubset(
	attrs: Map<string, string>,
): Record<string, string> | null {
	const subset: Record<string, string> = {};
	let size = 0;
	for (const [key, value] of attrs) {
		if (
			!key.startsWith("gen_ai.") &&
			!key.startsWith("ai.") &&
			!key.startsWith("autter.llm.") &&
			!OPENINFERENCE_USAGE_KEY.test(key)
		) {
			continue;
		}
		// Prompts/completions (ai.prompt, gen_ai.prompt, …) land here: scrub
		// before the size cap so a secret straddling it can't half-survive.
		const safe = isUsageCount(key, value)
			? value
			: isSensitiveKey(key)
				? "[redacted]"
				: scrubText(value);
		const trimmed = safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
		size += key.length + trimmed.length;
		if (size > 4000) break;
		subset[key] = trimmed;
	}
	return Object.keys(subset).length > 0 ? subset : null;
}
