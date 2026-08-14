import { estimateLlmCostUsd } from "./llm-pricing.js";
import type { RuntimeLlmCall } from "./types.js";

/**
 * LLM-call extraction from OTLP spans. Three attribute families are
 * recognised, so most stacks work with zero Autter-specific code:
 *
 * 1. OpenTelemetry GenAI semantic conventions (`gen_ai.*`) — emitted by
 *    OpenLLMetry, OpenLIT, the official OTel instrumentations, and
 *    @autter/runtime-node's own `withLlmCall`/`trackLlmCall` helpers.
 * 2. Vercel AI SDK telemetry (`ai.*` spans from `experimental_telemetry`).
 *    Only the provider-level `.doGenerate`/`.doStream`/`.doEmbed` spans
 *    become calls — the umbrella `ai.generateText` span aggregates its
 *    children's usage and would double-count.
 * 3. Autter extension attributes (`autter.llm.cost_usd`, `autter.user_id`,
 *    `autter.session_id`) for exact costs and user attribution.
 *
 * Cost precedence: reported (`autter.llm.cost_usd`/`gen_ai.usage.cost`) →
 * estimated from the built-in pricing table → 0 with costSource "none".
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
	durationMs: number;
	startedAt: Date;
	service: string;
	environment: string;
	release: string | null;
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

	const model = strAttr(
		attrs,
		"gen_ai.response.model",
		"gen_ai.request.model",
		"ai.response.model",
		"ai.model.id",
	);
	const provider = strAttr(attrs, "gen_ai.system", "ai.model.provider");
	// A call must identify at least a model or a provider system — this is
	// what keeps ordinary spans (HTTP, DB, tool calls) out of the table.
	if (!model && !provider) return null;

	const inputTokens =
		numAttr(
			attrs,
			"gen_ai.usage.input_tokens",
			"gen_ai.usage.prompt_tokens",
			"ai.usage.promptTokens",
			"ai.usage.inputTokens",
		) ?? 0;
	const outputTokens =
		numAttr(
			attrs,
			"gen_ai.usage.output_tokens",
			"gen_ai.usage.completion_tokens",
			"ai.usage.completionTokens",
			"ai.usage.outputTokens",
		) ?? 0;

	const reportedCost = numAttr(
		attrs,
		"autter.llm.cost_usd",
		"gen_ai.usage.cost",
		"ai.usage.cost",
	);
	let costUsd = 0;
	let costSource: RuntimeLlmCall["costSource"] = "none";
	if (reportedCost !== null && reportedCost >= 0) {
		costUsd = reportedCost;
		costSource = "reported";
	} else {
		const estimated = estimateLlmCostUsd(model ?? "", inputTokens, outputTokens);
		if (estimated !== null) {
			costUsd = estimated;
			costSource = "estimated";
		}
	}

	const operation =
		strAttr(attrs, "gen_ai.operation.name") ??
		(isVercelSpan ? vercelOperation(facts.name) : "");

	return {
		service: facts.service,
		environment: facts.environment,
		release: facts.release,
		traceId: facts.traceId,
		spanId: facts.spanId,
		provider: (provider ?? "").slice(0, 100),
		model: (model ?? "").slice(0, 200),
		operation: operation.slice(0, 100),
		inputTokens: Math.max(0, Math.round(inputTokens)),
		outputTokens: Math.max(0, Math.round(outputTokens)),
		costUsd,
		costSource,
		durationMs: facts.durationMs,
		status: facts.isError ? "error" : "ok",
		errorType: facts.isError
			? (strAttr(attrs, "error.type") ?? "Error").slice(0, 200)
			: "",
		userId: (
			strAttr(
				attrs,
				"autter.user_id",
				"ai.telemetry.metadata.userId",
				"ai.telemetry.metadata.user_id",
				"enduser.id",
				"user.id",
			) ?? ""
		).slice(0, 200),
		sessionId: (
			strAttr(
				attrs,
				"autter.session_id",
				"ai.telemetry.metadata.sessionId",
				"session.id",
			) ?? ""
		).slice(0, 200),
		attributes: llmAttributeSubset(attrs),
		startedAt: facts.startedAt,
	};
}

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
			!key.startsWith("autter.llm.")
		) {
			continue;
		}
		const trimmed = value.length > 500 ? `${value.slice(0, 500)}…` : value;
		size += key.length + trimmed.length;
		if (size > 4000) break;
		subset[key] = trimmed;
	}
	return Object.keys(subset).length > 0 ? subset : null;
}
