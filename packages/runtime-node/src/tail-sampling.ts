import { SpanStatusCode, type Attributes } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Tail-sampling decisions that must not depend on head sampling: which
 * unsampled request traces are slow enough to keep, and which LLM spans
 * keep their prompt and completion content.
 *
 * Both compare a duration with a per-key latency baseline (about the 95th
 * percentile of that route's or model's durations, frozen while the key is
 * regressed so a sustained slowdown keeps counting as slow) and an absolute
 * floor, and both are rate limited, so a slow incident keeps a steady,
 * bounded number of examples per minute instead of flooding export.
 */

/** Why a span was exported, on every span the SDK's request pipeline
 * exports: `head` (the head sampler picked its trace), `error` (tail
 * retention: the trace contained an error) or `slow` (tail retention: its
 * request took longer than the route's recent p95 and the floor). */
export const RETENTION_REASON_ATTR = "autter.retention_reason";
export type RetentionReason = "head" | "error" | "slow";

/** Requests and LLM calls under this are never "slow", whatever the route's
 * p95. Matches the regression detector's "+500 ms" rule: anything faster
 * cannot be the evidence for a regression it would report. */
export const SLOW_FLOOR_MS = 500;
/** Default budget of slow traces kept per process. */
export const DEFAULT_SLOW_TRACES_PER_MINUTE = 60;

const GROWTH = 1.25;
const LOG_GROWTH = Math.log(GROWTH);
/** 1.25^63 ≈ 1.3 M ms: everything above lands in the last bucket. */
const BUCKETS = 64;
const QUANTILE = 0.95;
/** The baseline's older observations count half every 15 minutes, so it
 * follows a route whose normal latency drifts. */
const BASELINE_HALF_LIFE_MS = 15 * 60_000;
const DECAY_EVERY_MS = 10_000;
/** Below this (decayed) count the baseline is not used: only the cold
 * threshold (the floor for requests). */
const MIN_SAMPLES = 20;
/**
 * Regression guard. The baseline p95 includes its own slowest 5%, so a
 * route that becomes and stays slow would pull its p95 up to the new
 * latency within minutes and stop counting as slow after a handful of
 * traces. Each request is also compared with the baseline threshold in a
 * short window (half-life 1 minute), where normally at most ~5% are at or
 * above it. From a tenth, requests at or above it no longer feed the
 * baseline (a regression starting); from a fifth the route is regressed
 * and its baseline is frozen (neither fed nor decayed), so the slow
 * requests keep counting as slow, within the per-route budget. After an
 * hour regressed the baseline is fed again and adopts the new latency.
 */
const RECENT_HALF_LIFE_MS = 60_000;
const SUSPECT_SHARE = 0.1;
const REGRESSED_SHARE = 0.2;
/** Recent (decayed) requests needed before the guard can trip. */
const MIN_RECENT = 5;
const REBASELINE_AFTER_MS = 60 * 60_000;
/** Routes tracked one by one; the rest share one estimate. */
const MAX_KEYS = 1_000;
const OVERFLOW_KEY = "\u0000other";

function bucketOf(ms: number): number {
	if (!(ms > 1)) return 0;
	return Math.min(BUCKETS - 1, Math.ceil(Math.log(ms) / LOG_GROWTH));
}

class TokenBucket {
	private tokens: number;
	private at: number;
	private readonly capacity: number;
	private readonly perMs: number;

	constructor(capacity: number, perMs: number, now: number) {
		this.capacity = capacity;
		this.perMs = perMs;
		this.tokens = capacity;
		this.at = now;
	}

	available(now: number): boolean {
		this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.at) * this.perMs);
		this.at = now;
		return this.tokens >= 1;
	}

	take(): void {
		this.tokens -= 1;
	}
}

interface KeyState {
	/** Baseline histogram (decayed counts) and its decayed total. */
	counts: Float64Array;
	total: number;
	decayedAt: number;
	/** Recent requests, and those at or above the baseline threshold. */
	recentTotal: number;
	recentAbove: number;
	recentAt: number;
	/** Since when the route has been regressed (baseline frozen), or null. */
	regressedSince: number | null;
	limit: TokenBucket;
}

export interface SlowPolicyOptions {
	/** A fixed threshold instead of the per-key estimate. */
	fixedThresholdMs?: number | null;
	floorMs?: number;
	/** Until a key's baseline holds `minSamples` (decayed) observations, a
	 * duration is slow only above this (and the floor). Default: the floor. */
	coldThresholdMs?: number;
	minSamples?: number;
	/** Kept per process per minute (each key gets a sixth of it). */
	perMinute?: number;
}

/**
 * Per-key latency baseline (decayed log-scale histogram: buckets 25% wide,
 * so "p95" is the upper bound of the bucket holding it), a regression
 * guard that freezes the baseline while a key stays slower than it, and
 * the keep budget: a process-wide token bucket and one per key, so one
 * slow route cannot use up what another needs.
 */
export class SlowPolicy {
	private readonly keys = new Map<string, KeyState>();
	private readonly fixed: number | null;
	private readonly floor: number;
	private readonly cold: number;
	private readonly minSamples: number;
	private readonly perMinute: number;
	private readonly global: TokenBucket;

	constructor(options: SlowPolicyOptions = {}, now = Date.now()) {
		this.fixed = options.fixedThresholdMs && options.fixedThresholdMs > 0 ? options.fixedThresholdMs : null;
		this.floor = Math.max(0, options.floorMs ?? SLOW_FLOOR_MS);
		this.cold = Math.max(this.floor, options.coldThresholdMs ?? this.floor);
		this.minSamples = Math.max(1, options.minSamples ?? MIN_SAMPLES);
		this.perMinute = Math.max(0, options.perMinute ?? DEFAULT_SLOW_TRACES_PER_MINUTE);
		this.global = new TokenBucket(Math.max(1, Math.min(this.perMinute, 20)), this.perMinute / 60_000, now);
	}

	/** The duration a request on this key must reach to count as slow. */
	thresholdMs(key: string, now = Date.now()): number {
		return this.threshold(this.state(key, now));
	}

	/** Whether the key is regressed: its baseline is frozen. */
	regressed(key: string, now = Date.now()): boolean {
		return this.state(key, now).regressedSince !== null;
	}

	/**
	 * Observe one duration for `key` (every request, kept or not, so the
	 * estimate reflects all traffic) and say whether it is slow AND within
	 * budget. Only a `wanted` decision spends budget: a head-sampled or
	 * already retained trace is exported anyway.
	 */
	consider(key: string, durationMs: number, wanted: boolean, now = Date.now()): boolean {
		if (!Number.isFinite(durationMs) || durationMs < 0) return false;
		const state = this.state(key, now);
		const threshold = this.threshold(state);
		this.observe(state, durationMs, threshold, now);
		if (!wanted || durationMs < threshold || this.perMinute <= 0) return false;
		if (!state.limit.available(now) || !this.global.available(now)) return false;
		state.limit.take();
		this.global.take();
		return true;
	}

	private observe(state: KeyState, durationMs: number, threshold: number, now: number): void {
		const warm = this.fixed === null && state.total >= this.minSamples;
		let suspect = false;
		if (warm) {
			const elapsed = now - state.recentAt;
			if (elapsed > 0) {
				const factor = 0.5 ** (elapsed / RECENT_HALF_LIFE_MS);
				state.recentTotal *= factor;
				state.recentAbove *= factor;
				state.recentAt = now;
			}
			state.recentTotal += 1;
			if (durationMs >= threshold) state.recentAbove += 1;
			const enough = state.recentTotal >= MIN_RECENT;
			const regressed = enough && state.recentAbove >= REGRESSED_SHARE * state.recentTotal;
			if (!regressed) state.regressedSince = null;
			else state.regressedSince ??= now;
			suspect = enough && durationMs >= threshold && state.recentAbove >= SUSPECT_SHARE * state.recentTotal;
		} else {
			state.regressedSince = null;
		}
		const rebaselining = state.regressedSince !== null && now - state.regressedSince >= REBASELINE_AFTER_MS;
		const frozen = !rebaselining && (state.regressedSince !== null || suspect);
		if (frozen) {
			// Paused, not aged: the baseline is the route's last healthy one.
			state.decayedAt = now;
			return;
		}
		const elapsed = now - state.decayedAt;
		if (elapsed >= DECAY_EVERY_MS) {
			const factor = 0.5 ** (elapsed / BASELINE_HALF_LIFE_MS);
			for (let i = 0; i < BUCKETS; i++) state.counts[i]! *= factor;
			state.total *= factor;
			state.decayedAt = now;
		}
		state.counts[bucketOf(durationMs)]! += 1;
		state.total += 1;
	}

	private threshold(state: KeyState): number {
		if (this.fixed !== null) return this.fixed;
		if (state.total < this.minSamples) return this.cold;
		const target = state.total * QUANTILE;
		let seen = 0;
		for (let i = 0; i < BUCKETS; i++) {
			seen += state.counts[i]!;
			if (seen >= target) return Math.max(this.floor, GROWTH ** i);
		}
		return Math.max(this.floor, GROWTH ** (BUCKETS - 1));
	}

	private state(requested: string, now: number): KeyState {
		let key = requested;
		let state = this.keys.get(key);
		if (!state && this.keys.size >= MAX_KEYS) {
			key = OVERFLOW_KEY;
			state = this.keys.get(key);
		}
		if (!state) {
			const perKey = this.perMinute / 6;
			state = {
				counts: new Float64Array(BUCKETS),
				total: 0,
				decayedAt: now,
				recentTotal: 0,
				recentAbove: 0,
				recentAt: now,
				regressedSince: null,
				limit: new TokenBucket(Math.max(1, Math.ceil(Math.min(this.perMinute, 20) / 4)), perKey / 60_000, now),
			};
			// The overflow estimate may exceed MAX_KEYS by one.
			this.keys.set(key, state);
		}
		return state;
	}
}

export function durationMsOf(span: ReadableSpan): number {
	return span.duration[0] * 1000 + span.duration[1] / 1e6;
}

export function spanIndicatesError(span: ReadableSpan): boolean {
	if (span.status?.code === SpanStatusCode.ERROR) return true;
	return (span.events ?? []).some((event) => EXCEPTION_EVENTS.has(event.name));
}

/** The process's first span of its trace: no parent, or one from another
 * process (an incoming `traceparent`). */
export function isLocalRoot(span: ReadableSpan): boolean {
	const parent = span.parentSpanContext;
	return parent === undefined || parent.isRemote === true;
}

/** A request's latency key: method and route template (never the raw path:
 * one estimate per URL would never warm up and would grow without bound). */
export function requestKeyOf(attributes: Attributes): string {
	const method = String(attributes["http.request.method"] ?? attributes["http.method"] ?? "");
	const route = String(attributes["http.route"] ?? "");
	return `${method} ${route}`;
}

// ── LLM spans ───────────────────────────────────────────────────────────

// Marks a span as an LLM/GenAI call, for head sampling (LLM calls are
// always recorded) and the content policy: OTel GenAI semconv attributes,
// OpenInference (`openinference.span.kind` LLM / EMBEDDING, `llm.model_name`),
// OpenLLMetry (`llm.request.type`), Autter's own helpers, or the span names
// the Vercel AI SDK and GenAI instrumentations use. Attributes must be
// present at span creation for head sampling to see them — true for the
// Vercel AI SDK, withLlmCall, the OTel GenAI instrumentations, OpenInference
// and OpenLLMetry.
const LLM_MARKER_ATTRIBUTES = [
	"gen_ai.operation.name",
	"gen_ai.system",
	"gen_ai.provider.name",
	"gen_ai.request.model",
	"autter.llm.provider",
	"llm.request.type",
	"llm.model_name",
	"llm.request.model_name",
];
const OPENINFERENCE_KIND = "openinference.span.kind";
const OPENINFERENCE_LLM_KINDS = new Set(["LLM", "EMBEDDING"]);

export function isLlmSpan(name: string, attributes: Attributes | undefined): boolean {
	if (name.startsWith("ai.") || name.startsWith("gen_ai.")) return true;
	const attrs = attributes ?? {};
	if (LLM_MARKER_ATTRIBUTES.some((key) => attrs[key] !== undefined)) return true;
	return OPENINFERENCE_LLM_KINDS.has(String(attrs[OPENINFERENCE_KIND] ?? "").toUpperCase());
}

/**
 * Spans whose content the policy governs: LLM calls, and the AI framework
 * spans around them that carry the same prompts and outputs (OpenInference
 * chains, agents, tools, retrievers; Traceloop workflows, tasks, agents and
 * tools; anything with `llm.*` or `gen_ai.*` attributes).
 */
export function isAiSpan(name: string, attributes: Attributes | undefined): boolean {
	if (isLlmSpan(name, attributes)) return true;
	const attrs = attributes ?? {};
	if (attrs[OPENINFERENCE_KIND] !== undefined || attrs["traceloop.span.kind"] !== undefined) return true;
	return Object.keys(attrs).some((key) =>
		key.startsWith("llm.") || key.startsWith("gen_ai.") || key.startsWith("traceloop.entity."));
}

/**
 * Prompt, completion and other model input/output content:
 * - Vercel AI SDK `ai.*` telemetry;
 * - OTel GenAI semantic conventions (`@opentelemetry/semantic-conventions`
 *   1.43 incubating: messages, system instructions, tool definitions and
 *   call arguments/results, retrieval query and documents, evaluation
 *   explanation; and the older `gen_ai.prompt` / `gen_ai.completion`);
 * - OpenLLMetry / Traceloop (`@traceloop/ai-semantic-conventions`: indexed
 *   `gen_ai.prompt.N.*` / `gen_ai.completion.N.*`, `llm.request.functions.*`,
 *   `traceloop.entity.input` / `output`, guardrail input/output, MCP
 *   responses, vector query result documents);
 * - OpenInference (`@arizeai/openinference-semantic-conventions`: `input.*`
 *   / `output.*` values, documents and images, `llm.input_messages.*`,
 *   `llm.output_messages.*`, `llm.prompts`, prompt template and variables,
 *   `llm.function_call`, `llm.invocation_parameters`, `llm.tools.*`, tool
 *   parameters and JSON schema, retrieval / reranker documents and query,
 *   embedding texts and vectors, message contents, tool call arguments,
 *   audio transcripts).
 * Model, provider, token usage, cost, finish reasons, roles, settings, ids,
 * document ids and scores, and telemetry metadata (`ai.telemetry.metadata.*`,
 * the user id the ingester reads) are not content and always stay.
 */
const LLM_CONTENT_KEYS = new Set([
	"ai.prompt",
	"ai.prompt.messages",
	"ai.prompt.tools",
	"ai.prompt.system",
	"ai.response.text",
	"ai.response.toolCalls",
	"ai.response.object",
	"ai.response.reasoning",
	"ai.response.reasoningDetails",
	"ai.response.files",
	"ai.response.sources",
	"ai.result.text",
	"ai.result.toolCalls",
	"ai.result.object",
	"ai.toolCall.args",
	"ai.toolCall.result",
	"ai.toolCall.input",
	"ai.toolCall.output",
	"ai.value",
	"ai.values",
	"ai.embedding",
	"ai.embeddings",
	// OTel GenAI
	"gen_ai.prompt",
	"gen_ai.completion",
	"gen_ai.input.messages",
	"gen_ai.output.messages",
	"gen_ai.system_instructions",
	"gen_ai.tool.definitions",
	"gen_ai.tool.call.arguments",
	"gen_ai.tool.call.result",
	"gen_ai.retrieval.query.text",
	"gen_ai.retrieval.documents",
	"gen_ai.evaluation.explanation",
	// OpenLLMetry / Traceloop
	"gen_ai.guardrail.input",
	"gen_ai.guardrail.output",
	"llm.request.functions",
	"traceloop.entity.input",
	"traceloop.entity.output",
	"mcp.response.value",
	"db.query.result.document",
	// OpenInference
	"input.value",
	"output.value",
	"input.images",
	"input.documents",
	"output.images",
	"output.documents",
	"llm.prompts",
	"llm.input_messages",
	"llm.output_messages",
	"llm.prompt_template.template",
	"llm.prompt_template.variables",
	"llm.function_call",
	"llm.invocation_parameters",
	"llm.tools",
	"tool.parameters",
	"tool.json_schema",
	"retrieval.documents",
	"reranker.input_documents",
	"reranker.output_documents",
	"reranker.query",
	"embedding.embeddings",
	"embedding.text",
	"embedding.vector",
	"document.content",
	"message.content",
	"message.contents",
	"message.tool_calls",
	"message.function_call_arguments_json",
	"tool_call.function.arguments",
	"message_content.text",
	"message_content.image",
	"message_content.audio",
	"message_content.video",
	"message_content.document",
	"message_content.data",
	"message_content.encrypted_content",
	"audio.transcript",
]);
/** Subtrees that are content (indexed messages, documents, tools…), except
 * the leaves `LLM_CONTENT_KEPT_LEAVES` name. */
const LLM_CONTENT_PREFIXES = [
	"gen_ai.input.messages.",
	"gen_ai.output.messages.",
	"llm.input_messages.",
	"llm.output_messages.",
	"llm.prompts.",
	"llm.prompt_template.variables.",
	"llm.function_call.",
	"llm.tools.",
	"llm.request.functions.",
	"input.documents.",
	"output.documents.",
	"input.images.",
	"output.images.",
	"retrieval.documents.",
	"reranker.input_documents.",
	"reranker.output_documents.",
	"embedding.embeddings.",
	"message.contents.",
	"message.tool_calls.",
	"db.vector.query.result.",
];
/** `gen_ai.prompt.N.*` / `gen_ai.completion.N.*` (OpenLLMetry). */
const INDEXED_PROMPT_RE = /^gen_ai\.(?:prompt|completion)\.\d+(?:\.|$)/;
/** Leaves under a content subtree that are not content. */
const LLM_CONTENT_KEPT_LEAVES = [".role", ".finish_reason", ".document.id", ".document.score", ".id", ".score", ".model_name"];

/** GenAI semconv events that carry message content (dropped whole). */
const LLM_CONTENT_EVENTS = new Set([
	"gen_ai.system.message",
	"gen_ai.user.message",
	"gen_ai.assistant.message",
	"gen_ai.tool.message",
	"gen_ai.choice",
	"gen_ai.content.prompt",
	"gen_ai.content.completion",
	"gen_ai.client.inference.operation.details",
	"db.query.result",
]);
/** Events on AI spans kept (their attributes filtered): exceptions, and
 * GenAI evaluation results. Any other `gen_ai.*` event is dropped. */
const EXCEPTION_EVENTS = new Set(["exception", "gen_ai.client.operation.exception"]);
const KEPT_GEN_AI_EVENTS = new Set(["gen_ai.evaluation.result"]);
/** Generic event attribute names GenAI and framework events put content
 * under, stripped from any event on an AI span. */
const EVENT_CONTENT_KEYS = new Set([
	"content", "body", "text", "input", "output", "prompt", "completion", "arguments", "result",
	"tool_calls", "message", "messages", "gen_ai.event.content", "event.body",
]);
const OMITTED = "[omitted]";

export function isLlmContentKey(key: string): boolean {
	if (LLM_CONTENT_KEYS.has(key)) return true;
	const indexed = INDEXED_PROMPT_RE.test(key);
	if (!indexed && !LLM_CONTENT_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
	return !LLM_CONTENT_KEPT_LEAVES.some((leaf) => key.endsWith(leaf));
}

/** `autter.llm.content` on an LLM span that had prompt/completion content:
 * `omitted` (stripped before export), or why it was kept: `error`, `slow`. */
export const LLM_CONTENT_ATTR = "autter.llm.content";
export type LlmContentMode = "slow-or-failed" | "always" | "never";

type SpanEvent = ReadableSpan["events"][number];
type SpanLink = ReadableSpan["links"][number];

function hasContent(span: ReadableSpan): boolean {
	return Object.keys(span.attributes ?? {}).some(isLlmContentKey)
		|| (span.events ?? []).some((event) => LLM_CONTENT_EVENTS.has(event.name)
			|| (event.name.startsWith("gen_ai.") && !EXCEPTION_EVENTS.has(event.name) && !KEPT_GEN_AI_EVENTS.has(event.name))
			|| Object.keys(event.attributes ?? {}).some((key) => isLlmContentKey(key) || EVENT_CONTENT_KEYS.has(key)))
		|| (span.links ?? []).some((link) => Object.keys(link.attributes ?? {}).some(isLlmContentKey));
}

function withoutContentKeys(attributes: Attributes, generic = false): Attributes {
	const out: Attributes = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!isLlmContentKey(key) && !(generic && EVENT_CONTENT_KEYS.has(key))) out[key] = value;
	}
	return out;
}

/** An exception's message (and the message lines of its stack) can quote
 * the completion (a JSON parse error, a validation error): the type and the
 * frames stay, the message does not. */
function scrubException(event: SpanEvent): SpanEvent {
	const attributes = withoutContentKeys(event.attributes ?? {}, true);
	const type = String(attributes["exception.type"] ?? attributes["error.type"] ?? "Error");
	for (const key of ["exception.message", "error.message"]) if (key in attributes) attributes[key] = OMITTED;
	const stack = attributes["exception.stacktrace"];
	if (typeof stack === "string") {
		const frames = stack.split("\n").filter((line) => /^\s+(?:at\s|File\s")/.test(line));
		attributes["exception.stacktrace"] = [`${type}: ${OMITTED}`, ...frames].join("\n");
	}
	return { name: event.name, time: event.time, attributes, droppedAttributesCount: event.droppedAttributesCount };
}

function rewrap(
	span: ReadableSpan,
	attributes: Attributes,
	events: ReadableSpan["events"],
	links: ReadableSpan["links"] = span.links,
	status: ReadableSpan["status"] = span.status,
): ReadableSpan {
	return {
		name: span.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		status,
		attributes,
		links,
		events,
		duration: span.duration,
		ended: span.ended,
		resource: span.resource,
		instrumentationScope: span.instrumentationScope,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	};
}

/**
 * The span without prompt/completion content, marked `omitted`: content
 * attributes, content events, content keys on other events and on links,
 * and the error text of a failed call (status message, exception
 * messages). A new span object: the original, which other processors may
 * hold, is never changed.
 */
export function stripLlmContent(span: ReadableSpan): ReadableSpan {
	const events: SpanEvent[] = [];
	for (const event of span.events ?? []) {
		if (LLM_CONTENT_EVENTS.has(event.name)) continue;
		if (EXCEPTION_EVENTS.has(event.name)) {
			events.push(scrubException(event));
			continue;
		}
		if (event.name.startsWith("gen_ai.") && !KEPT_GEN_AI_EVENTS.has(event.name)) continue;
		events.push(event.attributes
			? { name: event.name, time: event.time, attributes: withoutContentKeys(event.attributes, true), droppedAttributesCount: event.droppedAttributesCount }
			: { name: event.name, time: event.time, droppedAttributesCount: event.droppedAttributesCount });
	}
	const links: SpanLink[] = (span.links ?? []).map((link) =>
		link.attributes ? { context: link.context, attributes: withoutContentKeys(link.attributes), droppedAttributesCount: link.droppedAttributesCount } : link);
	const status = span.status?.message ? { code: span.status.code, message: OMITTED } : span.status;
	return rewrap(span, { ...withoutContentKeys(span.attributes ?? {}), [LLM_CONTENT_ATTR]: "omitted" }, events, links, status);
}

function llmKeyOf(span: ReadableSpan): string {
	const attrs = span.attributes ?? {};
	const model = attrs["gen_ai.request.model"] ?? attrs["ai.model.id"] ?? attrs["llm.model_name"]
		?? attrs["llm.request.model_name"] ?? "";
	return `${span.name} ${String(model)}`;
}

/** Until a model has this many (decayed) calls, its p95 is not used… */
const LLM_MIN_SAMPLES = 50;
/** …and a call counts as slow only above this. At low volume a "p95" of a
 * handful of calls, or the 500 ms floor, would call nearly every LLM call
 * slow and keep its content. */
export const LLM_COLD_SLOW_MS = 20_000;

/**
 * Token and cost counters for every LLM call, full content only for calls
 * that failed or were slow (above the model's p95 and the floor once the
 * model has 50 recent calls, above 20 s before that; within the slow
 * budget). Shared by every trace exporter, so the estimate sees every LLM
 * span once (LLM spans are never head-sampled out).
 */
export class LlmContentPolicy {
	private readonly slow: SlowPolicy;
	private readonly mode: LlmContentMode;

	constructor(mode: LlmContentMode, perMinute = DEFAULT_SLOW_TRACES_PER_MINUTE, now = Date.now()) {
		this.mode = mode;
		this.slow = new SlowPolicy({ perMinute, minSamples: LLM_MIN_SAMPLES, coldThresholdMs: LLM_COLD_SLOW_MS }, now);
	}

	apply(span: ReadableSpan, now = Date.now()): ReadableSpan {
		if (this.mode === "always" || !isAiSpan(span.name, span.attributes)) return span;
		const content = hasContent(span);
		const failed = spanIndicatesError(span);
		const slow = this.slow.consider(llmKeyOf(span), durationMsOf(span), content && !failed && this.mode !== "never", now);
		if (this.mode === "never") return content || failed ? stripLlmContent(span) : span;
		if (!content) return span;
		if (!failed && !slow) return stripLlmContent(span);
		return rewrap(span, { ...span.attributes, [LLM_CONTENT_ATTR]: failed ? "error" : "slow" }, span.events);
	}
}

/** Never throws out of export(): a span the policy cannot handle is
 * stripped, and one that cannot even be stripped is dropped (fail closed:
 * never export a prompt we meant to drop, never lose the rest of the batch). */
export class LlmContentExporter implements SpanExporter {
	constructor(
		private readonly inner: SpanExporter,
		private readonly policy: LlmContentPolicy,
	) {}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		const out: ReadableSpan[] = [];
		for (const span of spans) {
			try {
				out.push(this.policy.apply(span));
			} catch {
				try {
					out.push(isAiSpan(span.name, span.attributes) ? stripLlmContent(span) : span);
				} catch {
					// Dropped: neither the policy nor the strip could read it.
				}
			}
		}
		this.inner.export(out, resultCallback);
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve();
	}
}
