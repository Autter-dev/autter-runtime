import { SpanStatusCode, type Attributes } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Tail-sampling decisions that must not depend on head sampling: which
 * unsampled request traces are slow enough to keep, and which LLM spans
 * keep their prompt and completion content.
 *
 * Both compare a duration with a rolling per-key latency estimate (about
 * the 95th percentile of recent durations for that route or model) with an
 * absolute floor, and both are rate limited, so a slow incident keeps a
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
/** Older observations count half every 5 minutes, so the estimate follows
 * a route whose latency changed within minutes. */
const HALF_LIFE_MS = 5 * 60_000;
const DECAY_EVERY_MS = 10_000;
/** Below this (decayed) count the estimate is not used: only the floor. */
const MIN_SAMPLES = 20;
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

	constructor(
		private readonly capacity: number,
		private readonly perMs: number,
		now: number,
	) {
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
	counts: Float64Array;
	total: number;
	decayedAt: number;
	limit: TokenBucket;
}

export interface SlowPolicyOptions {
	/** A fixed threshold instead of the per-key estimate. */
	fixedThresholdMs?: number | null;
	floorMs?: number;
	/** Kept per process per minute (each key gets a sixth of it). */
	perMinute?: number;
}

/**
 * Per-key rolling latency estimate (decayed log-scale histogram: buckets
 * 25% wide, so "p95" is the upper bound of the bucket holding it) plus the
 * keep budget: a process-wide token bucket and one per key, so one slow
 * route cannot use up what another needs.
 */
export class SlowPolicy {
	private readonly keys = new Map<string, KeyState>();
	private readonly fixed: number | null;
	private readonly floor: number;
	private readonly perMinute: number;
	private readonly global: TokenBucket;

	constructor(options: SlowPolicyOptions = {}, now = Date.now()) {
		this.fixed = options.fixedThresholdMs && options.fixedThresholdMs > 0 ? options.fixedThresholdMs : null;
		this.floor = Math.max(0, options.floorMs ?? SLOW_FLOOR_MS);
		this.perMinute = Math.max(0, options.perMinute ?? DEFAULT_SLOW_TRACES_PER_MINUTE);
		this.global = new TokenBucket(Math.max(1, Math.min(this.perMinute, 20)), this.perMinute / 60_000, now);
	}

	/** The duration a request on this key must reach to count as slow. */
	thresholdMs(key: string, now = Date.now()): number {
		return this.threshold(this.state(key, now));
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
		state.counts[bucketOf(durationMs)]! += 1;
		state.total += 1;
		if (!wanted || durationMs < threshold || this.perMinute <= 0) return false;
		if (!state.limit.available(now) || !this.global.available(now)) return false;
		state.limit.take();
		this.global.take();
		return true;
	}

	private threshold(state: KeyState): number {
		if (this.fixed !== null) return this.fixed;
		if (state.total < MIN_SAMPLES) return this.floor;
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
				limit: new TokenBucket(Math.max(1, Math.ceil(Math.min(this.perMinute, 20) / 4)), perKey / 60_000, now),
			};
			// The overflow estimate may exceed MAX_KEYS by one.
			this.keys.set(key, state);
			return state;
		}
		const elapsed = now - state.decayedAt;
		if (elapsed >= DECAY_EVERY_MS) {
			const factor = 0.5 ** (elapsed / HALF_LIFE_MS);
			for (let i = 0; i < BUCKETS; i++) state.counts[i]! *= factor;
			state.total *= factor;
			state.decayedAt = now;
		}
		return state;
	}
}

export function durationMsOf(span: ReadableSpan): number {
	return span.duration[0] * 1000 + span.duration[1] / 1e6;
}

export function spanIndicatesError(span: ReadableSpan): boolean {
	if (span.status.code === SpanStatusCode.ERROR) return true;
	return span.events.some((event) => event.name === "exception");
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

// Marks a span as an LLM/GenAI call: OTel GenAI semconv attributes, or the
// span names the Vercel AI SDK and GenAI instrumentations use. Attributes
// must be present at span creation for head sampling to see them — true for
// the Vercel AI SDK, withLlmCall, and the OTel GenAI instrumentations.
const LLM_MARKER_ATTRIBUTES = [
	"gen_ai.operation.name",
	"gen_ai.system",
	"gen_ai.provider.name",
	"gen_ai.request.model",
	"autter.llm.provider",
];

export function isLlmSpan(name: string, attributes: Attributes): boolean {
	if (name.startsWith("ai.") || name.startsWith("gen_ai.")) return true;
	return LLM_MARKER_ATTRIBUTES.some((key) => attributes[key] !== undefined);
}

/**
 * Prompt and completion content on LLM spans: the Vercel AI SDK's `ai.*`
 * telemetry, the OTel GenAI semantic conventions (current and the older
 * `gen_ai.prompt` / `gen_ai.completion`), OpenLLMetry's indexed
 * `gen_ai.prompt.N.*` / `gen_ai.completion.N.*` and OpenInference. Model,
 * provider, token usage, cost, finish reasons, settings, ids and telemetry
 * metadata (`ai.telemetry.metadata.*`, the user id the ingester reads) are
 * not content and always stay.
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
	"gen_ai.prompt",
	"gen_ai.completion",
	"gen_ai.input.messages",
	"gen_ai.output.messages",
	"gen_ai.system_instructions",
	"gen_ai.tool.definitions",
	"gen_ai.tool.call.arguments",
	"gen_ai.tool.call.result",
	"input.value",
	"output.value",
	"llm.prompts",
]);
const LLM_CONTENT_PREFIXES = [
	"gen_ai.prompt.",
	"gen_ai.completion.",
	"llm.input_messages.",
	"llm.output_messages.",
	"llm.prompts.",
];
/** GenAI semconv events that carry message content. */
const LLM_CONTENT_EVENTS = new Set([
	"gen_ai.system.message",
	"gen_ai.user.message",
	"gen_ai.assistant.message",
	"gen_ai.tool.message",
	"gen_ai.choice",
	"gen_ai.content.prompt",
	"gen_ai.content.completion",
	"gen_ai.client.inference.operation.details",
]);

export function isLlmContentKey(key: string): boolean {
	return LLM_CONTENT_KEYS.has(key) || LLM_CONTENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** `autter.llm.content` on an LLM span that had prompt/completion content:
 * `omitted` (stripped before export), or why it was kept: `error`, `slow`. */
export const LLM_CONTENT_ATTR = "autter.llm.content";
export type LlmContentMode = "slow-or-failed" | "always" | "never";

function hasContent(span: ReadableSpan): boolean {
	return Object.keys(span.attributes).some(isLlmContentKey)
		|| span.events.some((event) => LLM_CONTENT_EVENTS.has(event.name)
			|| Object.keys(event.attributes ?? {}).some(isLlmContentKey));
}

function withoutContentKeys(attributes: Attributes): Attributes {
	const out: Attributes = {};
	for (const [key, value] of Object.entries(attributes)) if (!isLlmContentKey(key)) out[key] = value;
	return out;
}

function rewrap(span: ReadableSpan, attributes: Attributes, events: ReadableSpan["events"]): ReadableSpan {
	return {
		name: span.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		status: span.status,
		attributes,
		links: span.links,
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

/** The span without prompt/completion content, marked `omitted`. */
export function stripLlmContent(span: ReadableSpan): ReadableSpan {
	const events = span.events
		.filter((event) => !LLM_CONTENT_EVENTS.has(event.name))
		.map((event) => (event.attributes ? { ...event, attributes: withoutContentKeys(event.attributes) } : event));
	return rewrap(span, { ...withoutContentKeys(span.attributes), [LLM_CONTENT_ATTR]: "omitted" }, events);
}

function llmKeyOf(span: ReadableSpan): string {
	const model = span.attributes["gen_ai.request.model"] ?? span.attributes["ai.model.id"] ?? "";
	return `${span.name} ${String(model)}`;
}

/**
 * Token and cost counters for every LLM call, full content only for calls
 * that failed or were slow (above the model's recent p95 and the floor,
 * within the slow budget). Shared by every trace exporter, so the estimate
 * sees every LLM span once (LLM spans are never head-sampled out).
 */
export class LlmContentPolicy {
	private readonly slow: SlowPolicy;

	constructor(
		private readonly mode: LlmContentMode,
		perMinute = DEFAULT_SLOW_TRACES_PER_MINUTE,
		now = Date.now(),
	) {
		this.slow = new SlowPolicy({ perMinute }, now);
	}

	apply(span: ReadableSpan, now = Date.now()): ReadableSpan {
		if (this.mode === "always" || !isLlmSpan(span.name, span.attributes)) return span;
		const content = hasContent(span);
		const failed = spanIndicatesError(span);
		const slow = this.slow.consider(llmKeyOf(span), durationMsOf(span), content && !failed && this.mode !== "never", now);
		if (!content) return span;
		if (this.mode === "never" || (!failed && !slow)) return stripLlmContent(span);
		return rewrap(span, { ...span.attributes, [LLM_CONTENT_ATTR]: failed ? "error" : "slow" }, span.events);
	}
}

export class LlmContentExporter implements SpanExporter {
	constructor(
		private readonly inner: SpanExporter,
		private readonly policy: LlmContentPolicy,
	) {}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		const out = spans.map((span) => {
			try {
				return this.policy.apply(span);
			} catch {
				// Fail closed on content: never export a prompt we meant to drop.
				return isLlmSpan(span.name, span.attributes) ? stripLlmContent(span) : span;
			}
		});
		this.inner.export(out, resultCallback);
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve();
	}
}
