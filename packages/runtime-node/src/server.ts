import { errorMonitor } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ServerResponse, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
	context,
	trace,
	SpanKind,
	SpanStatusCode,
	TraceFlags,
	type Attributes,
	type Context,
	type Link,
	type Span,
	type Tracer,
} from "@opentelemetry/api";
import { getRPCMetadata, RPCType } from "@opentelemetry/core";
import {
	AggregationTemporalityPreference,
	OTLPMetricExporter,
} from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { ExplicitBucketHistogramAggregation, PeriodicExportingMetricReader, View } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	BatchSpanProcessor,
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
	AlwaysOnSampler,
	BasicTracerProvider,
	SamplingDecision,
	type ReadableSpan,
	type Sampler,
	type SamplingResult,
	type Span as SdkSpan,
	type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
	CountingExporter,
	installAutterAutoFlush,
	isDebugEnabled,
	debugLog,
	registerFlushTarget,
	telemetryStats,
	unregisterFlushTargets,
	type AutoFlushHandle,
	setDebugMode,
	type FlushTarget,
} from "./lifecycle.js";
import {
	makeRedactor,
	redactAttributes,
	type RedactOptions,
	type Redactor,
} from "./redact.js";
import { RedactingMetricExporter, RedactingSpanExporter } from "./redact-exporter.js";
import { makeUrlQueryPolicy } from "./url-query.js";
import { startMemoryMetrics } from "./memory.js";
import {
	configureRuntimeLogger,
	currentOperation,
	flushRuntimeLogs,
	noteOperationError,
	notifyException,
	recordOperationAiUsage,
	shutdownRuntimeLogger,
	type RuntimeLoggingOptions,
} from "./logger.js";
import {
	expressRouteOf,
	markCaptured,
	setRequestExceptionCapturer,
	setRequestSpanAnnotator,
	startHookRequest,
} from "./requests.js";
import { errorAttributes, errorInternal, fingerprintEventAttributes, isError, splitFingerprint } from "@autter/runtime-core";
import { configureCompatCheck, noteCompatFeature, SDK_IDENTITY } from "./compat.js";
import {
	installUnhandledRejectionCapture,
	recordedAsRejection,
} from "./unhandled-rejections.js";
import { breadcrumbEventAttributes } from "./breadcrumbs.js";
import { sharedSlot } from "./shared.js";
import { RouteLabelSampler } from "./route-label.js";

/**
 * The started tracker, shared by every copy of this package in the process
 * (see shared.ts), so `captureException`, `withLlmCall`, … in a copy that was
 * never initialised (a Next.js route bundle) report through the copy that
 * was (`instrumentation.ts`).
 */
interface ServerSlot {
	/** The initAutterServer handle while it runs. */
	active: AutterServer | null;
	/** Always-on provider shared by error, LLM, and process spans — set while
	 * a server is active so withLlmCall/withProcessSpan bypass head sampling. */
	alwaysOnProvider: Pick<BasicTracerProvider, "getTracer" | "forceFlush"> | null;
	/** Compiled attribute redactor — defaults until initAutterServer applies
	 * its own configuration. Used by every capture path including LLM
	 * attributes. */
	redactor: Redactor;
	/** Set by initAutterLogging: exception capture without NodeSDK. */
	loggerOnlyCapture: ((error: unknown, attributes?: Attributes) => void) | null;
	/** `logging.requests: true` — zero-code request summaries (experimental). */
	hookRequests: boolean;
}
const S = sharedSlot<ServerSlot>("server", () => ({
	active: null,
	alwaysOnProvider: null,
	redactor: makeRedactor(true),
	loggerOnlyCapture: null,
	hookRequests: false,
}));

/**
 * Curated OpenTelemetry setup for Autter Runtime — deliberately NOT the
 * auto-instrumentation metapackage. Default data-volume policy:
 *
 *   errors / captured exceptions : 100%  (dedicated always-on error tracer)
 *   traces containing an error   : 100%  (tail retention — the full trace is
 *                                         exported when any of its spans
 *                                         errors, so a retained error keeps
 *                                         the trace that explains it)
 *   named process spans          : 100%  (withProcessSpan, always-on tracer)
 *   LLM / GenAI call spans       : 100%  (withLlmCall/trackLlmCall/
 *                                         instrumentLlmClient + an LLM-aware
 *                                         sampler that keeps GenAI/Vercel-AI
 *                                         spans — cost tracking needs every
 *                                         call)
 *   successful traces            : 1%    (head sampling, configurable)
 *   request metrics              : aggregated every 60 s, keyed by route
 *                                  template (Express and Next.js routes
 *                                  detected out of the box — see
 *                                  captureRequestRoute, route-label.ts)
 *   operation / request summaries: 100%  (withRuntimeOperation,
 *                                         autterRequests, … — one wide
 *                                         record per unit of work, never
 *                                         sampled)
 *   logs                         : runtimeLogger / runtimeContext records
 *                                  (debug/info folded into the current
 *                                  operation's summary; minLevel applies)
 *
 * Exports OTLP/HTTP JSON to the Autter ingester (`/v1/traces`,
 * `/v1/metrics`, `/v1/logs`) with the ingest key as a bearer header.
 */

export interface AutterServerOptions {
	/** Structured logs and completed operation summaries. */
	logging?: RuntimeLoggingOptions;
	/** Private ingest key (autter_rt_…). */
	apiKey: string;
	/** Ingester base URL. Default: https://otlp.autter.dev */
	endpoint?: string;
	service: string;
	/** Stable for this process lifetime; use an ECS task/container ID or pod UID plus restart count to correlate platform events. */
	instanceId?: string;
	environment?: string;
	/** e.g. a git SHA. Maps to service.version / release. */
	release?: string;
	/** Head-sampling ratio for regular traces. Default 0.01 (1%). */
	traceSampleRate?: number;
	/**
	 * Keep the FULL trace whenever it contains an error: an ERROR-status
	 * span (e.g. a 5xx request), a recorded exception, or a
	 * `captureException` / error-severity `captureMessage` call made inside
	 * it. Head sampling still decides what is exported for healthy traffic;
	 * erroring traces are rescued from the unsampled pool by a bounded
	 * in-process buffer — without this, errors are retained at 100% while
	 * the trace explaining them survives only `traceSampleRate` of the time.
	 * Default true.
	 */
	retainTracesOnError?: boolean;
	retainTracesAboveMs?: number;
	/** Metric export interval. Default 60_000 ms. */
	metricIntervalMs?: number;
	/** Collect RSS, heap, limit, and GC signals per process instance. Default true. */
	memoryMetrics?: boolean;
	/**
	 * Capture crashing exceptions via process.uncaughtExceptionMonitor, and
	 * unhandled promise rejections (see `captureUnhandledRejections`).
	 * Default true; false turns both off.
	 */
	captureGlobalErrors?: boolean;
	/**
	 * Record unhandled promise rejections as errors (severity "error",
	 * `autter.unhandled_rejection: true`). Never changes whether the process
	 * crashes: when Node would have crashed (the default
	 * `--unhandled-rejections=throw` mode and no other `unhandledRejection`
	 * listener), the rejection is rethrown on the next tick, so the process
	 * still exits with code 1 and the crash is recorded as fatal like any
	 * other. False restores 1.5.0 behaviour: a rejection is only seen when it
	 * crashes the process. Default true.
	 */
	captureUnhandledRejections?: boolean;
	/**
	 * Flush all exporters when the process exits (`beforeExit`, SIGINT,
	 * SIGTERM) so a forgotten `shutdown()` doesn't silently drop buffered
	 * telemetry. If your code also handles the signal, Autter only flushes
	 * alongside it and never changes your exit path. Default true.
	 */
	autoFlush?: boolean;
	/**
	 * Mask secrets/PII before anything leaves the process — custom
	 * attributes, exception messages and stack traces, span status
	 * messages, URLs/query strings and attributes set by any
	 * instrumentation (scrubbed again at export), and structured logs:
	 * JWTs, bearer/basic credentials, Cookie/Authorization header text,
	 * `scheme://user:pass@` connection strings, vendor API keys (sk-, sk_live_,
	 * ghp_, xox*-, AIza, AKIA, …), PEM private keys, `password=`/`?token=`
	 * assignments, emails, card numbers, and anything whose attribute KEY
	 * looks sensitive (password/token/secret/cookie/authorization/session/…).
	 * `true`/undefined = defaults; pass a RedactOptions object to add your
	 * own key/value patterns; `false` disables (not recommended).
	 * Default true.
	 */
	redactAttributes?: boolean | RedactOptions;
	/**
	 * Query strings never leave the process with their values. Every span
	 * (any instrumentation, Next.js's own included) is exported with
	 * `http.target`, `http.url` and `url.full` cut at the `?`, `url.query`
	 * reduced to its parameter names (`email=[redacted]&page=[redacted]`,
	 * added when only the URL had the query) and the query dropped from span
	 * names. List parameters whose values are safe to keep in `url.query`,
	 * such as pagination or sorting: `keepQueryParams: ["page", "sort"]`
	 * (exact names; kept values are still scrubbed by `redactAttributes`).
	 * Applies even with `redactAttributes: false`. Default `[]`.
	 */
	keepQueryParams?: string[];
	/**
	 * Verbose lifecycle logging to stderr: "exported N spans", flushes and
	 * auto-flush activity — handy while wiring the SDK up. Also enabled by
	 * the AUTTER_DEBUG=1 environment variable. Default false.
	 */
	debug?: boolean;
	/**
	 * Record LLM/GenAI spans (`gen_ai.*` semconv, Vercel AI SDK `ai.*`,
	 * `withLlmCall`) at 100% regardless of `traceSampleRate`, so every model
	 * call is tracked with tokens/cost (default true).
	 */
	llmTracing?: boolean;
	/** Extra instrumentations (e.g. `new ExpressInstrumentation()`). */
	instrumentations?: unknown[];
	/**
	 * Check once, in the background, that the ingester supports the features
	 * in use (operation logging, memory metrics, …) and print one warning per
	 * mismatch naming both versions and the fix. Never throws or delays
	 * startup. Also disabled by AUTTER_COMPAT_CHECK=0. Default true.
	 * Run `npx @autter/runtime-node doctor` for a full report.
	 */
	compatCheck?: boolean;
	/**
	 * @internal Wrapper packages (`@autter/runtime-next`) report their own
	 * name/version as the OTLP `telemetry.distro.*` resource attributes.
	 */
	distro?: { name: string; version: string };
}

export type AutterSeverity = "fatal" | "error" | "warning" | "info";

/** Token usage (and optionally exact cost) of one LLM call. */
export interface LlmUsage {
	inputTokens?: number;
	outputTokens?: number;
	/**
	 * Exact cost in USD, if the provider reports it. Overrides Autter's
	 * built-in per-model price estimate.
	 */
	costUsd?: number;
	/** Prompt tokens served from the provider cache (rolled into `autter.operation.ai`). */
	cacheReadTokens?: number;
}

export interface LlmCallInfo {
	/** Provider system: "openai", "anthropic", "google", "mistral_ai", … */
	provider: string;
	/** Requested model id, e.g. "gpt-5-mini" or "claude-sonnet-4". */
	model: string;
	/** "chat" (default), "embeddings", "text_completion", … */
	operation?: string;
	/** Opaque end-user id for per-user cost attribution — never an email. */
	userId?: string;
	sessionId?: string;
	/** Extra span attributes (kept under the gen_ai./autter.llm. families). */
	attributes?: Attributes;
}

/** Reporting surface handed to the `withLlmCall` callback. */
export interface LlmCallHandle {
	/** Report token usage / exact cost from the provider response. */
	setUsage(usage: LlmUsage): void;
	/** Exact cost in USD; without it the ingester estimates from its price table. */
	setCost(usd: number): void;
	/** Record the model the provider actually served (gen_ai.response.model). */
	setResponseModel(model: string): void;
	/** Alias of setResponseModel. */
	setModel(model: string): void;
	/** Extra span attributes reported mid-call. */
	setAttributes(attributes: Attributes): void;
}

/** A completed LLM call reported after the fact via `trackLlmCall`. */
export interface TrackedLlmCall extends LlmCallInfo, LlmUsage {
	/** Wall-clock duration of the call, if measured. */
	durationMs?: number;
	/** Pass the thrown error to record the call as failed. */
	error?: unknown;
}

export interface AutterServer {
	/**
	 * Report a handled exception. Always recorded (never sampled out).
	 * `attributes.fingerprint` (a string or up to 10 strings) groups every
	 * error that carries it into one issue (ingester 1.6.0+); it is sent as
	 * `autter.fingerprint` on the exception event, not as a span attribute.
	 */
	captureException(error: unknown, attributes?: Attributes): void;
	/**
	 * Report a warning (or info) without an exception — deprecated code
	 * paths, recoverable failures, degraded dependencies. Stored alongside
	 * errors with a lower severity so aggregations can slice one dataset.
	 */
	captureMessage(
		message: string,
		severity?: AutterSeverity,
		attributes?: Attributes,
	): void;
	/** Report a failed result from code that returned normally. Name must be stable. */
	reportOutcome(name: string, message: string, attributes?: Attributes): void;
	/**
	 * Wrap a named unit of work — a background job, queue consumer, cron
	 * tick, or DB-heavy call — in an always-recorded span. Unlike regular
	 * traces these are never head-sampled, so Autter's slow-process monitor
	 * sees accurate run counts and durations for non-HTTP work. Nested
	 * instrumented calls run inside the span's context, so slow traces show
	 * where the time went. Rethrows whatever `fn` throws.
	 */
	withProcessSpan<T>(
		name: string,
		fn: () => T | Promise<T>,
		attributes?: Attributes,
	): Promise<T>;
	/**
	 * Wrap one LLM provider call. Always recorded (never head-sampled), so
	 * Autter's LLM usage/cost dashboards and anomaly monitor see every call.
	 * Report tokens via the handle once the response arrives; cost is
	 * estimated from the model id unless `setCost(usd)` (or
	 * `setUsage({ costUsd })`) reports the exact figure. Rethrows whatever
	 * `fn` throws (failed calls are recorded with the error attached).
	 *
	 *   const reply = await autter.withLlmCall(
	 *     { provider: "openai", model: "gpt-5-mini", userId: user.id },
	 *     async (llm) => {
	 *       const res = await openai.chat.completions.create({ ... });
	 *       llm.setUsage({
	 *         inputTokens: res.usage?.prompt_tokens,
	 *         outputTokens: res.usage?.completion_tokens,
	 *       });
	 *       return res;
	 *     },
	 *   );
	 */
	withLlmCall<T>(
		info: LlmCallInfo,
		fn: (llm: LlmCallHandle) => T | Promise<T>,
	): Promise<T>;
	/**
	 * Report an already-completed LLM call — for codepaths where wrapping is
	 * awkward (queues, callbacks, batch results). Fire-and-forget.
	 */
	trackLlmCall(call: TrackedLlmCall): void;
	/** Flush and stop all exporters. Call on graceful shutdown. */
	shutdown(): Promise<void>;
}

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

function isLlmSpan(name: string, attributes: Attributes): boolean {
	if (name.startsWith("ai.") || name.startsWith("gen_ai.")) return true;
	return LLM_MARKER_ATTRIBUTES.some((key) => attributes[key] !== undefined);
}

/**
 * Delegates to the regular head sampler except for LLM/GenAI spans, which
 * are always recorded: Vercel AI SDK telemetry (`ai.*` spans) and any
 * GenAI-semconv instrumentation ride the global provider, and at a 1% ratio
 * they would effectively vanish — useless for cost tracking. LLM calls are
 * low-volume and high-value; record them all.
 */
class LlmAwareSampler implements Sampler {
	constructor(private readonly delegate: Sampler) {}

	shouldSample(
		ctx: Context,
		traceId: string,
		spanName: string,
		spanKind: SpanKind,
		attributes: Attributes,
		links: Link[],
	): SamplingResult {
		if (isLlmSpan(spanName, attributes)) {
			return { decision: SamplingDecision.RECORD_AND_SAMPLED };
		}
		return this.delegate.shouldSample(
			ctx,
			traceId,
			spanName,
			spanKind,
			attributes,
			links,
		);
	}

	toString(): string {
		return `LlmAware(${this.delegate.toString()})`;
	}
}

/**
 * Upgrades NOT_RECORD decisions to RECORD so head-unsampled traces still
 * materialise in-process: their spans reach the span processors with the
 * sampled flag off (the regular batch processor ignores them) where
 * ErrorTraceRetentionProcessor can buffer them and promote the whole trace
 * to export if an error shows up. The W3C traceparent stays unsampled
 * either way, so downstream services behave exactly as before.
 */
class RecordUnsampledSampler implements Sampler {
	constructor(private readonly delegate: Sampler) {}

	shouldSample(
		ctx: Context,
		traceId: string,
		spanName: string,
		spanKind: SpanKind,
		attributes: Attributes,
		links: Link[],
	): SamplingResult {
		const result = this.delegate.shouldSample(
			ctx,
			traceId,
			spanName,
			spanKind,
			attributes,
			links,
		);
		if (result.decision === SamplingDecision.NOT_RECORD) {
			return { ...result, decision: SamplingDecision.RECORD };
		}
		return result;
	}

	toString(): string {
		return `RecordUnsampled(${this.delegate.toString()})`;
	}
}

const RETENTION_MAX_SPANS_PER_TRACE = 256;
const RETENTION_MAX_BUFFERED_SPANS = 5_000;
const RETENTION_SWEEP_INTERVAL_MS = 10_000;
const RETENTION_TRACE_TTL_MS = 30_000;

function spanIndicatesError(span: ReadableSpan): boolean {
	if (span.status.code === SpanStatusCode.ERROR) return true;
	return span.events.some((event) => event.name === "exception");
}

/** Marks spans exported by tail retention rather than head sampling. The
 * ingester uses it to keep such spans out of span-fed usage rollups —
 * erroring requests are already counted by the metrics pipeline, and at
 * ~100% retention the span contribution would double-count them. */
const TAIL_RETAINED_ATTR = "autter.tail_retained";

/** The batch processor only exports spans with the sampled flag, so a
 * rescued span is re-wrapped with the flag set — which is also the truth:
 * the tail decision sampled it. */
function withSampledFlag(span: ReadableSpan): ReadableSpan {
	const spanContext = {
		...span.spanContext(),
		traceFlags: span.spanContext().traceFlags | TraceFlags.SAMPLED,
	};
	return {
		name: span.name,
		kind: span.kind,
		spanContext: () => spanContext,
		parentSpanId: span.parentSpanId,
		startTime: span.startTime,
		endTime: span.endTime,
		status: span.status,
		attributes: { ...span.attributes, [TAIL_RETAINED_ATTR]: true },
		links: span.links,
		events: span.events,
		duration: span.duration,
		ended: span.ended,
		resource: span.resource,
		instrumentationLibrary: span.instrumentationLibrary,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	};
}

interface RetentionEntry {
	spans: ReadableSpan[];
	retained: boolean;
	firstSeenAtMs: number;
}

/**
 * Tail retention for erroring traces. Errors export at 100% via the
 * always-on tracer while regular traces are head-sampled at ~1% — so the
 * trace that explains a retained error would almost always be gone. This
 * processor buffers the finished-but-unsampled spans of in-flight traces
 * and promotes a whole trace to export the moment it shows an error: an
 * ERROR-status span (5xx requests included), an `exception` event, or an
 * explicit captureException / captureMessage("…", "error") inside it.
 *
 * Bounded by construction: per-trace and total span caps, buffers dropped
 * as soon as the local root span ends healthy, and a TTL sweep for traces
 * whose root is never seen. On overflow it degrades to plain head sampling
 * for the evicted traces — it never blocks and never grows unbounded.
 * Errors reported after the root span has ended keep their occurrence (the
 * always-on pipe) but can no longer rescue the request trace.
 */
class ErrorTraceRetentionProcessor implements SpanProcessor {
	private readonly traces = new Map<string, RetentionEntry>();
	private bufferedSpans = 0;
	private readonly sweeper: NodeJS.Timeout;

	constructor(
		private readonly inner: SpanProcessor,
		private readonly retainErrors = true,
		private readonly slowThresholdMs = 0,
	) {
		this.sweeper = setInterval(() => this.sweep(), RETENTION_SWEEP_INTERVAL_MS);
		// Never hold the process open just to babysit the buffer.
		this.sweeper.unref?.();
	}

	onStart(_span: SdkSpan, _parentContext: Context): void {}

	onEnd(span: ReadableSpan): void {
		const ctx = span.spanContext();
		// Head-sampled spans already export through the regular processor.
		if ((ctx.traceFlags & TraceFlags.SAMPLED) !== 0) return;

		const entry = this.entryFor(ctx.traceId);
		if (entry.retained) {
			this.forward(span);
		} else if ((this.retainErrors && spanIndicatesError(span)) ||
			(this.slowThresholdMs > 0 && span.kind === SpanKind.SERVER &&
				span.duration[0] * 1000 + span.duration[1] / 1e6 >= this.slowThresholdMs)) {
			entry.retained = true;
			this.flush(entry);
			this.forward(span);
		} else if (entry.spans.length < RETENTION_MAX_SPANS_PER_TRACE) {
			entry.spans.push(span);
			this.bufferedSpans++;
			this.evictIfOverBudget();
		}

		// The local root ended: the request is over, and an error inside it
		// would have surfaced by now. Drop a healthy trace's buffer; keep
		// retained entries so late stragglers still export (sweep cleans up).
		if (span.parentSpanId === undefined && !entry.retained) {
			this.drop(ctx.traceId);
		}
	}

	/** Promote the active trace, if any — called on captured errors. */
	retainActiveTrace(): void {
		const active = trace.getActiveSpan()?.spanContext();
		// No active trace, or a head-sampled one that exports anyway.
		if (!active || (active.traceFlags & TraceFlags.SAMPLED) !== 0) return;
		const entry = this.entryFor(active.traceId);
		if (entry.retained) return;
		entry.retained = true;
		this.flush(entry);
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush();
	}

	shutdown(): Promise<void> {
		clearInterval(this.sweeper);
		this.traces.clear();
		this.bufferedSpans = 0;
		return this.inner.shutdown();
	}

	private entryFor(traceId: string): RetentionEntry {
		let entry = this.traces.get(traceId);
		if (!entry) {
			if (this.traces.size >= RETENTION_MAX_BUFFERED_SPANS) {
				const oldest = this.traces.keys().next().value;
				if (oldest) this.drop(oldest);
			}
			entry = { spans: [], retained: false, firstSeenAtMs: Date.now() };
			this.traces.set(traceId, entry);
		}
		return entry;
	}

	private forward(span: ReadableSpan): void {
		this.inner.onEnd(withSampledFlag(span));
	}

	private flush(entry: RetentionEntry): void {
		for (const span of entry.spans) this.forward(span);
		this.bufferedSpans -= entry.spans.length;
		entry.spans = [];
	}

	private drop(traceId: string): void {
		const entry = this.traces.get(traceId);
		if (!entry) return;
		this.bufferedSpans -= entry.spans.length;
		this.traces.delete(traceId);
	}

	private evictIfOverBudget(): void {
		if (this.bufferedSpans <= RETENTION_MAX_BUFFERED_SPANS) return;
		// Insertion order ≈ oldest trace first; evicting whole traces keeps
		// what survives coherent instead of leaving partial traces behind.
		// Entries without buffered spans (retained markers, drained traces)
		// don't help the budget and keep their rescue semantics.
		for (const [traceId, entry] of this.traces) {
			if (entry.spans.length === 0) continue;
			this.drop(traceId);
			if (this.bufferedSpans <= RETENTION_MAX_BUFFERED_SPANS) return;
		}
	}

	private sweep(): void {
		const cutoff = Date.now() - RETENTION_TRACE_TTL_MS;
		for (const [traceId, entry] of this.traces) {
			if (entry.firstSeenAtMs <= cutoff) this.drop(traceId);
		}
	}
}

function llmBaseAttributes(info: LlmCallInfo): Attributes {
	return {
		"gen_ai.operation.name": info.operation ?? "chat",
		// Both keys: gen_ai.system is the pre-1.37 semconv name and what
		// most tooling still matches on.
		"gen_ai.provider.name": info.provider,
		"gen_ai.system": info.provider,
		"gen_ai.request.model": info.model,
		...(info.userId ? { "autter.user_id": info.userId } : {}),
		...(info.sessionId ? { "autter.session_id": info.sessionId } : {}),
		// Caller-supplied extras go through redaction like every other
		// custom attribute family (prompts can contain emails/keys).
		...(info.attributes ? S.redactor(info.attributes) : {}),
	};
}

function usageAttributes(usage: LlmUsage): Attributes {
	const attrs: Attributes = {};
	if (usage.inputTokens !== undefined) {
		attrs["gen_ai.usage.input_tokens"] = Math.max(0, Math.round(usage.inputTokens));
	}
	if (usage.outputTokens !== undefined) {
		attrs["gen_ai.usage.output_tokens"] = Math.max(
			0,
			Math.round(usage.outputTokens),
		);
	}
	if (usage.costUsd !== undefined) {
		attrs["autter.llm.cost_usd"] = usage.costUsd;
	}
	return attrs;
}

async function runLlmSpan<T>(
	tracer: Tracer,
	info: LlmCallInfo,
	fn: (llm: LlmCallHandle) => T | Promise<T>,
): Promise<T> {
	const span = tracer.startSpan(`${info.operation ?? "chat"} ${info.model}`, {
		kind: SpanKind.CLIENT,
		attributes: llmBaseAttributes(info),
	});
	const usage: LlmUsage = {};
	let responseModel: string | undefined;
	const setResponseModel = (model: string) => {
		responseModel = model;
		span.setAttribute("gen_ai.response.model", model);
	};
	const handle: LlmCallHandle = {
		setUsage: (next) => {
			Object.assign(usage, next);
			span.setAttributes(usageAttributes(next));
		},
		setCost: (usd) => {
			usage.costUsd = usd;
			span.setAttribute("autter.llm.cost_usd", usd);
		},
		setResponseModel,
		setModel: setResponseModel,
		setAttributes: (attributes) => span.setAttributes(S.redactor(attributes)),
	};
	try {
		const result = await context.with(
			trace.setSpan(context.active(), span),
			() => fn(handle),
		);
		span.setStatus({ code: SpanStatusCode.OK });
		return result;
	} catch (err) {
		recordError(span, err);
		if (isError(err)) span.setAttribute("error.type", err.name);
		throw err;
	} finally {
		span.end();
		recordOperationAiUsage({ ...usage, model: responseModel ?? info.model });
	}
}

function recordLlmCall(tracer: Tracer, call: TrackedLlmCall): void {
	recordOperationAiUsage({ ...call, model: call.model });
	const durationMs = Math.max(0, call.durationMs ?? 0);
	const endTime = new Date();
	const startTime = new Date(endTime.getTime() - durationMs);
	const span = tracer.startSpan(
		`${call.operation ?? "chat"} ${call.model}`,
		{
			kind: SpanKind.CLIENT,
			startTime,
			attributes: { ...llmBaseAttributes(call), ...usageAttributes(call) },
		},
	);
	if (call.error !== undefined && call.error !== null) {
		recordError(span, call.error);
		if (isError(call.error)) {
			span.setAttribute("error.type", call.error.name);
		}
	} else {
		span.setStatus({ code: SpanStatusCode.OK });
	}
	span.end(endTime);
}

async function runWithSpan<T>(
	tracer: Tracer,
	name: string,
	fn: () => T | Promise<T>,
	attributes?: Attributes,
	links?: Link[],
): Promise<T> {
	const span = tracer.startSpan(name, {
		attributes,
		...(links?.length ? { links } : {}),
	});
	try {
		const result = await context.with(
			trace.setSpan(context.active(), span),
			fn,
		);
		span.setStatus({ code: SpanStatusCode.OK });
		return result;
	} catch (err) {
		recordError(span, err);
		throw err;
	} finally {
		span.end();
	}
}

/**
 * Record a thrown value on a span with its message and stack scrubbed —
 * the redacting replacement for `span.recordException(err)` + an error
 * status. Same wire shape as OTel's recordException (an "exception" event
 * with exception.type/message/stacktrace).
 * @internal
 */
export function recordError(span: Span, err: unknown): void {
	const isErr = isError(err);
	const message = S.redactor.text(isErr ? err.message : String(err));
	// Like recordException, only real Errors get an exception event; other
	// thrown values keep just the (scrubbed) error status.
	if (isErr) {
		span.addEvent("exception", {
			"exception.type": err.name,
			"exception.message": message,
			...(err.stack
				? { "exception.stacktrace": S.redactor.text(err.stack) }
				: {}),
			...breadcrumbEventAttributes(S.redactor.text, err),
		});
	}
	span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** @internal Redact attributes with the active configuration. */
export function redactWithActive(attributes?: Attributes | null): Attributes {
	return S.redactor(attributes);
}

/**
 * HttpInstrumentation patches `http` and `https` when they are required after
 * `sdk.start()` (require-in-the-middle). A host that loaded them first never
 * gets request spans or `http.server.duration` until some later code happens
 * to require them: Next.js creates its server before `instrumentation.ts`
 * runs, so a Next app was instrumented only from the first request that
 * loaded its edge sandbox or a CommonJS dependency using `http`, if ever; an
 * ES module app that imports its framework before calling initAutterServer
 * is in the same place. Requiring them here applies the patch now. It wraps
 * `Server.prototype.emit`, so servers created earlier are covered too.
 */
function patchLoadedHttpModules(): void {
	try {
		const load = createRequire(join(process.cwd(), "autter-runtime-http.cjs"));
		load("http");
		load("https");
	} catch {
		/* no CommonJS loader here: nothing was loaded through it either */
	}
}

/** On an HTTP server span: this request's `http.server.duration` /
 * `http.server.request.duration` data point carries `http.route`. With the
 * resource's `autter.metrics_wired` and `autter.metrics_routes`, the ingester
 * counts such a request from the metric alone; a request without it (no
 * route known: Koa, Fastify or plain `http` without a router
 * instrumentation) is also counted from its sampled spans, which keep its
 * path. */
const METRIC_ROUTE_ATTR = "autter.metric_has_route";

/**
 * HttpInstrumentation responseHook: copy the Express route template into
 * `rpcMetadata.route` before the instrumentation snapshots attributes at
 * response close. That is the only channel through which `http.route`
 * reaches BOTH the server span and the `http.server.duration` histogram —
 * metric data points never carry raw URL paths (cardinality), so without a
 * route here every per-route rollup row lands on the empty route. A router
 * instrumentation supplied via `options.instrumentations` (e.g.
 * ExpressInstrumentation) wins when it has already set the route, and so
 * does a Next.js route template named while the request ran
 * (route-label.ts). The request span is then marked METRIC_ROUTE_ATTR when
 * its metric gets a route.
 */
function captureRequestRoute(
	span: Span,
	response: IncomingMessage | ServerResponse,
): void {
	// The hook also fires for outgoing client responses (IncomingMessage).
	if (!(response instanceof ServerResponse)) return;
	const rpcMetadata = getRPCMetadata(context.active());
	if (rpcMetadata?.type !== RPCType.HTTP) return;
	// After a response error the instrumentation records the metric from
	// the request-time attributes alone, without the route.
	let failed = false;
	response.on(errorMonitor, () => {
		failed = true;
	});
	const setRoute = () => {
		if (rpcMetadata.route) return;
		const route = expressRouteOf(response.req);
		if (route) rpcMetadata.route = route;
	};
	// prependListener: must run before the instrumentation's own 'close'
	// handler reads rpcMetadata and records the metric. 'finish' covers
	// completed responses, 'close' covers aborted ones; setRoute is
	// idempotent.
	response.prependListener("finish", setRoute);
	response.prependListener("close", () => {
		setRoute();
		if (rpcMetadata.route && !failed) span.setAttribute(METRIC_ROUTE_ATTR, true);
	});
	if (S.hookRequests) startHookRequest(response);
}

/** Span attributes for a structured error: autter.error.* (and the
 * redacted, span-only `autter.error.internal`). */
function structuredErrorAttributes(error: unknown): Attributes {
	const attrs: Attributes = { ...errorAttributes(error, { causes: false }) };
	const internal = errorInternal(error);
	if (internal) {
		try {
			attrs["autter.error.internal"] = JSON.stringify(
				S.redactor(internal as Attributes),
			).slice(0, 4000);
		} catch {
			/* unserialisable internal payload */
		}
	}
	return attrs;
}

export function initAutterServer(options: AutterServerOptions): AutterServer {
	if (S.active) return S.active;

	const endpoint = (options.endpoint ?? "https://otlp.autter.dev").replace(
		/\/$/,
		"",
	);
	const headers = { authorization: `Bearer ${options.apiKey}` };
	const redactor = makeRedactor(options.redactAttributes ?? true);
	// Every trace exporter scrubs spans on the way out, whoever created them
	// (see redact-exporter.ts): secrets and PII, and URL query values.
	const queryPolicy = makeUrlQueryPolicy(options.keepQueryParams);
	const traceExporter = () =>
		new CountingExporter(
			new RedactingSpanExporter(
				new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
				() => redactor,
				queryPolicy,
			),
		);
	const environment = options.environment ?? process.env.NODE_ENV ?? "production";

	// Debug mode: option OR AUTTER_DEBUG env (lifecycle seeds itself from the
	// env at import time — never clobber an env-enabled session here).
	if (isDebugEnabled() || options.debug === true) setDebugMode(true);
	debugLog(`initialising service=${options.service} endpoint=${endpoint}`);
	S.redactor = redactor;
	const distro = options.distro ?? SDK_IDENTITY;
	configureCompatCheck({ endpoint, enabled: options.compatCheck !== false, sdk: distro });

	const resource = new Resource({
		[ATTR_SERVICE_NAME]: options.service,
		"service.instance.id": (options.instanceId || process.env.AUTTER_RUNTIME_INSTANCE_ID || randomUUID()).slice(0, 128),
		...(options.release ? { [ATTR_SERVICE_VERSION]: options.release } : {}),
		"deployment.environment": environment,
		// OTel semconv for SDK distributions: the ingester records which
		// Autter SDK version each service runs (version compatibility checks).
		"telemetry.distro.name": distro.name,
		"telemetry.distro.version": distro.version,
		// Tells the ingester request metrics arrive on the metrics pipe, so
		// it must not also fold our server spans into usage rollups (that
		// would double-count every sampled request)...
		"autter.metrics_wired": true,
		// ...for the requests whose metric carries their route: those
		// request spans say so (`autter.metric_has_route`, see
		// captureRequestRoute). Ingesters honour metrics_wired only with
		// this, so an older SDK, whose Next.js metrics have no route, keeps
		// its span-fed per-route counts.
		"autter.metrics_routes": true,
	});

	const rootSampler = new TraceIdRatioBasedSampler(options.traceSampleRate ?? 0.01);
	const headSampler = new ParentBasedSampler({
		root: rootSampler,
		// Browsers (runtime-browser's traceparent) send unsampled parents: they
		// make no sampling decision. Apply this service's own rate to such
		// requests instead of never head-sampling them. The ratio sampler is
		// deterministic by trace id, so services sharing a rate still agree
		// with an upstream service that chose not to sample.
		remoteParentNotSampled: rootSampler,
	});
	const retainOnError = options.retainTracesOnError !== false;
	const slowThresholdMs = Number.isFinite(options.retainTracesAboveMs)
		? Math.max(0, options.retainTracesAboveMs!) : 0;
	const retainTraces = retainOnError || slowThresholdMs > 0;
	// Error-linked trace retention (default on): unsampled spans are still
	// recorded in-process and briefly buffered, so a trace can be exported in
	// full once it turns out to contain an error. Rescued spans ride their
	// own batch processor on the errors' 2 s flush cadence.
	let sampler: Sampler = retainTraces
		? new RecordUnsampledSampler(headSampler)
		: headSampler;
	// LLM tracing is on by default: gen_ai/ai.* spans emitted through the
	// global provider (Vercel AI SDK, GenAI instrumentations) skip head
	// sampling so every model call reaches the ingester.
	if (options.llmTracing !== false) sampler = new LlmAwareSampler(sampler);
	// Outermost: sees every span start, so Next.js's route templates reach
	// the request's metric whatever the sampling decision (route-label.ts).
	sampler = new RouteLabelSampler(sampler);
	const errorTraceBuffer = retainTraces
		? new ErrorTraceRetentionProcessor(
				new BatchSpanProcessor(traceExporter(), { scheduledDelayMillis: 2000 }),
				retainOnError,
				slowThresholdMs,
			)
		: null;

	const mainSpanProcessor = new BatchSpanProcessor(traceExporter());
	const metricReader = new PeriodicExportingMetricReader({
		exporter: new RedactingMetricExporter(
			new OTLPMetricExporter({
				url: `${endpoint}/v1/metrics`,
				headers,
				// Deltas, not lifetime totals: the ingester SUMs data points
				// into runtime_metrics_1m, and the default (cumulative)
				// temporality would re-count every past request on each
				// 60 s export.
				temporalityPreference: AggregationTemporalityPreference.DELTA,
			}),
			() => redactor,
		),
		exportIntervalMillis: options.metricIntervalMs ?? 60_000,
	});

	const sdk = new NodeSDK({
		resource,
		sampler,
		spanProcessors: [
			mainSpanProcessor,
			...(errorTraceBuffer ? [errorTraceBuffer] : []),
		],
		metricReader,
		views: [
			new View({ instrumentName: "http.server.duration", aggregation: new ExplicitBucketHistogramAggregation(
				[5, 10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 60000, 120000],
			) }),
			new View({ instrumentName: "http.server.request.duration", aggregation: new ExplicitBucketHistogramAggregation(
				[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 60, 120],
			) }),
		],
		instrumentations: [
			new HttpInstrumentation({ responseHook: captureRequestRoute }),
			...((options.instrumentations ?? []) as never[]),
		],
	});
	sdk.start();
	patchLoadedHttpModules();
	const stopMemoryMetrics = options.memoryMetrics === false ? null : startMemoryMetrics();
	noteCompatFeature("endpoint_latency");
	if (stopMemoryMetrics) noteCompatFeature("memory_metrics");
	if (options.llmTracing !== false) noteCompatFeature("llm_calls");

	// Errors, LLM calls, and process spans must never be lost to head
	// sampling, so they go through a dedicated always-on provider with its
	// own batch processor.
	const alwaysOnProvider = new BasicTracerProvider({
		resource,
		sampler: new AlwaysOnSampler(),
		spanProcessors: [
			new BatchSpanProcessor(traceExporter(), { scheduledDelayMillis: 2000 }),
		],
	});
	const errorTracer = alwaysOnProvider.getTracer("autter-errors");
	// Process spans share the always-on provider (same OTLP pipe, no extra
	// exporter) under their own scope name.
	const processTracer = alwaysOnProvider.getTracer("autter-processes");
	// LLM calls likewise ride the always-on pipe — usage/cost accounting
	// cannot tolerate head sampling.
	const llmTracer = alwaysOnProvider.getTracer("autter-llm");

	function captureException(error: unknown, attributes?: Attributes): void {
		// A captured error makes the surrounding trace worth keeping in full.
		errorTraceBuffer?.retainActiveTrace();
		telemetryStats.markCaptured();
		const isErr = isError(error);
		// Redaction is applied here AND at export time: secrets must not
		// leave the process even if an exporter misbehaves. Messages and
		// stacks are scrubbed too — `connect ECONNREFUSED
		// postgres://admin:hunter2@…` is the typical leak, not attributes.
		const message = redactor.text(isErr ? error.message : String(error));
		const stackText = isErr && error.stack ? redactor.text(error.stack) : "";
		// `fingerprint` groups the error (`autter.fingerprint` on the exception
		// event, so it never sticks to a reused request span).
		const split = splitFingerprint(attributes);
		const fingerprint = fingerprintEventAttributes(split.fingerprint, redactor.text);
		if (fingerprint["autter.fingerprint"]) noteCompatFeature("fingerprint_override");
		const redacted = redactor(split.attributes);

		// Prefer the live request span (the HTTP server span inside an Express
		// handler or error middleware) so the thrown exception and its failed
		// request stay one issue. Opening a separate error span here is what
		// used to split one failure into an "Error" group AND a "SpanError"
		// group: the request span carried only an error status (no exception
		// event), so the ingester synthesized a second SpanError occurrence.
		// Recording the exception onto the request span gives it a real
		// exception event (type, message, stack), so no SpanError is derived.
		// Global handlers (uncaught/unhandled) run with no active span, so we
		// still open a dedicated always-on error span for them.
		const activeSpan = trace.getActiveSpan();
		const reuseActive = activeSpan?.isRecording() === true;
		const span = reuseActive
			? (activeSpan as Span)
			: errorTracer.startSpan(isErr ? error.name : "Error");
		// Coded errors (RuntimeError, catalogs, or ANY error with
		// code/why/fix/link/status/expected): autter.error.* on the span AND
		// on the exception event (one span can carry several exceptions);
		// cause chains on the event; `internal` on the span only.
		const structured = structuredErrorAttributes(error);
		const causes = errorAttributes(error);
		const declared = {
			...Object.fromEntries(Object.entries(causes).filter(([key]) => key !== "autter.error.internal")),
			...fingerprint,
		};
		const requestId = currentOperation()?.requestId;
		span.setAttributes({
			"autter.severity": "error",
			...redacted,
			...structured,
			...(requestId ? { "autter.request.id": requestId } : {}),
		});
		markCaptured(error);
		noteOperationError(error);
		notifyException(error, { ...redacted, ...fingerprint });

		if (isErr && stackText) {
			span.addEvent("exception", {
				"exception.type": error.name,
				"exception.message": message,
				"exception.stacktrace": stackText,
				...(redacted["autter.handled"] === true
					? { "autter.handled": true, "autter.sampled": redacted["autter.sampled"] === true }
					: {}),
				...declared,
				...breadcrumbEventAttributes(redactor.text, error),
			});
		} else {
			// No usable stack — an Error thrown without one, or a non-Error
			// value. Synthesize the call site (minus this frame) so the
			// occurrence keeps a code location instead of grouping every
			// stackless error onto one exception-type + message fingerprint.
			const stack = new Error().stack
				?.split("\n")
				.filter((line, i) => i === 0 || !line.includes("captureException"))
				.join("\n");
			span.addEvent("exception", {
				"exception.type": isErr ? error.name : "Error",
				"exception.message": message,
				...(stack ? { "exception.stacktrace": redactor.text(stack) } : {}),
				...(redacted["autter.handled"] === true
					? { "autter.handled": true, "autter.sampled": redacted["autter.sampled"] === true }
					: {}),
				...declared,
				...breadcrumbEventAttributes(redactor.text, error),
			});
		}
		span.setStatus({ code: SpanStatusCode.ERROR, message });
		// Only end spans we own. The request span is owned by the HTTP
		// instrumentation, which ends it when the response completes.
		if (!reuseActive) span.end();
	}

	function captureMessage(
		message: string,
		severity: AutterSeverity = "warning",
		attributes?: Attributes,
	): void {
		// Error-severity messages rescue their trace like exceptions do;
		// warnings/info are too chatty to justify exporting whole traces.
		if (severity === "error" || severity === "fatal") {
			errorTraceBuffer?.retainActiveTrace();
		}
		telemetryStats.markCaptured();
		// Same wire shape as an exception (an event named "exception" with
		// ERROR status is what the ingester turns into an occurrence), with
		// autter.severity carrying the level. A synthetic stack (minus this
		// frame) marks the call site so warnings group by origin.
		const stack = new Error().stack
			?.split("\n")
			.filter((line, i) => i === 0 || !line.includes("captureMessage"))
			.join("\n");
		const safeMessage = redactor.text(message);
		const span = errorTracer.startSpan("Message", {
			attributes: { "autter.severity": severity, ...redactor(attributes) },
		});
		span.addEvent("exception", {
			"exception.type": "Message",
			"exception.message": safeMessage,
			...(stack ? { "exception.stacktrace": redactor.text(stack) } : {}),
			"autter.severity": severity,
			...breadcrumbEventAttributes(redactor.text),
		});
		span.setStatus({ code: SpanStatusCode.ERROR, message: safeMessage });
		span.end();
	}

	function reportOutcome(name: string, message: string, attributes?: Attributes): void {
		errorTraceBuffer?.retainActiveTrace();
		telemetryStats.markCaptured();
		const activeSpan = trace.getActiveSpan();
		const reuseActive = activeSpan?.isRecording() === true;
		const span = reuseActive ? activeSpan : errorTracer.startSpan("OutcomeFailure");
		const safeOutcome = redactor({ "autter.outcome.name": name.slice(0, 200), "autter.outcome.message": message.slice(0, 1000) });
		const safeName = String(safeOutcome["autter.outcome.name"] ?? "operation");
		const safeMessage = String(safeOutcome["autter.outcome.message"] ?? "failed");
		span.addEvent("autter.outcome", {
			...redactor(attributes),
			"autter.outcome.status": "error",
			"autter.outcome.name": safeName,
			"autter.outcome.message": safeMessage,
		});
		span.setStatus({ code: SpanStatusCode.ERROR, message: safeMessage });
		if (!reuseActive) span.end();
	}
	configureRuntimeLogger({ endpoint, apiKey: options.apiKey, service: options.service, environment, distro,
		release: options.release, options: options.logging, redact: redactor,
		run: (name, fn, attributes, links) => runWithSpan(processTracer, name, fn, redactor(attributes), links),
		reportOutcome,
	});
	S.hookRequests = options.logging?.requests === true;

	let onCrash: ((err: unknown) => void) | null = null;
	let uninstallRejections: (() => void) | null = null;
	if (options.captureGlobalErrors !== false) {
		// `uncaughtExceptionMonitor` observes crashes WITHOUT changing the
		// process's exit semantics (unlike an `uncaughtException` listener).
		// Best-effort: the batch may not fully flush before the process dies.
		onCrash = (err) => {
			// Already recorded as an unhandled rejection (an app listener
			// rethrew it): one rejection stays one occurrence.
			if (recordedAsRejection(err)) return;
			captureException(err, { "autter.unhandled": true });
			if (options.autoFlush === false) void Promise.resolve(flushTarget.forceFlush()).catch(() => {});
		};
		process.on("uncaughtExceptionMonitor", onCrash);
		// Rejections Node does not crash on are recorded as errors; the ones
		// it would crash on are rethrown so they still crash (and reach the
		// monitor above). See unhandled-rejections.ts.
		if (options.captureUnhandledRejections !== false) {
			uninstallRejections = installUnhandledRejectionCapture((reason) =>
				captureException(reason, { "autter.unhandled_rejection": true }),
			);
		}
	}

	// Everything that buffers telemetry in-process, reachable as one unit:
	// auto-flush and the crash monitor push all of these out together
	// (NodeSDK exposes no forceFlush(), but the processors we handed it do).
	const flushTarget: FlushTarget = {
		forceFlush: async () => {
			const results = await Promise.allSettled([
				flushRuntimeLogs(),
				Promise.resolve().then(() => alwaysOnProvider.forceFlush()),
				Promise.resolve().then(() => mainSpanProcessor.forceFlush()),
				...(errorTraceBuffer
					? [Promise.resolve().then(() => errorTraceBuffer.forceFlush())]
					: []),
				Promise.resolve().then(() => metricReader.forceFlush()),
			]);

			const failed = results.find(
				(result) => result.status === "rejected",
			);

			if (failed) {
				throw failed.reason;
			}
		},
	};
	registerFlushTarget("active-server", flushTarget);

	let autoFlushHandle: AutoFlushHandle | null = null;
	if (options.autoFlush !== false) {
		autoFlushHandle = installAutterAutoFlush();
	}

	const server: AutterServer = {
		captureException,
		captureMessage,
		reportOutcome,
		withProcessSpan: (name, fn, attributes) =>
			runWithSpan(processTracer, name, fn, redactor(attributes)),
		withLlmCall: (info, fn) => runLlmSpan(llmTracer, info, fn),
		trackLlmCall: (call) => recordLlmCall(llmTracer, call),
		shutdown: async () => {
			const logShutdown = await Promise.allSettled([shutdownRuntimeLogger()]);
			if (onCrash) process.off("uncaughtExceptionMonitor", onCrash);
			uninstallRejections?.();
			stopMemoryMetrics?.();
			// Clear the shared state, so every copy is back to "not started"
			// (console output, captures on the global tracer).
			if (S.active === server) {
				S.active = null;
				S.alwaysOnProvider = null;
				S.hookRequests = false;
				S.redactor = makeRedactor(true);
			}
			autoFlushHandle?.dispose();
			autoFlushHandle = null;
			unregisterFlushTargets();
			telemetryStats.markAllFlushed();
			await Promise.allSettled([alwaysOnProvider.shutdown(), sdk.shutdown()]);
			if (logShutdown[0]?.status === "rejected") throw logShutdown[0].reason;
		},
	};
	S.active = server;
	S.alwaysOnProvider = alwaysOnProvider;
	return server;
}

/** Module-level convenience — routes to the active server, or degrades to a
 * span on the global tracer so libraries can call it unconditionally. */
export function captureException(
	error: unknown,
	attributes?: Attributes,
): void {
	if (S.active) {
		S.active.captureException(error, attributes);
		return;
	}
	if (S.loggerOnlyCapture) {
		S.loggerOnlyCapture(error, attributes);
		return;
	}
	markCaptured(error);
	noteOperationError(error);
	const split = splitFingerprint(attributes);
	const fingerprint = fingerprintEventAttributes(split.fingerprint, S.redactor.text);
	notifyException(error, { ...split.attributes, ...fingerprint });
	// Before initAutterServer the span rides the host's global provider,
	// whose exporter we don't control — so scrub here, at capture time. The
	// span is this error's own, so the fingerprint can ride on it.
	const span = trace
		.getTracer("autter-errors")
		.startSpan(isError(error) ? error.name : "Error", {
			attributes: { ...S.redactor(split.attributes), ...fingerprint },
		});
	recordError(span, error);
	span.end();
}

/** @internal */
export function setLoggerOnlyCapture(
	fn: ((error: unknown, attributes?: Attributes) => void) | null,
): void {
	S.loggerOnlyCapture = fn;
}
/** @internal True while initAutterServer's NodeSDK pipeline is active (in any copy). */
export function serverActive(): boolean {
	return S.active !== null;
}
/** @internal Redacted structured-error span attributes (logger-only mode). */
export { structuredErrorAttributes };

setRequestExceptionCapturer((error, attributes) => captureException(error, attributes));
setRequestSpanAnnotator((attributes) => {
	const span = trace.getActiveSpan();
	if (span?.isRecording()) span.setAttributes(S.redactor(splitFingerprint(attributes).attributes));
});

/**
 * Module-level convenience — see AutterServer.withProcessSpan. Before
 * initAutterServer runs it degrades to the global tracer, where the span is
 * subject to that provider's own sampling instead of the always-on pipe.
 */
export function withProcessSpan<T>(
	name: string,
	fn: () => T | Promise<T>,
	attributes?: Attributes,
): Promise<T> {
	if (S.active) return S.active.withProcessSpan(name, fn, attributes);
	return runWithSpan(
		trace.getTracer("autter-processes"),
		name,
		fn,
		S.redactor(attributes),
	);
}

/**
 * Module-level convenience — see AutterServer.withLlmCall. Before
 * initAutterServer runs it degrades to the global tracer, where the span is
 * subject to that provider's own sampling instead of the always-on pipe.
 */
export function withLlmCall<T>(
	info: LlmCallInfo,
	fn: (llm: LlmCallHandle) => T | Promise<T>,
): Promise<T> {
	if (S.active) return S.active.withLlmCall(info, fn);
	return runLlmSpan(trace.getTracer("autter-llm"), info, fn);
}

/** Module-level convenience — see AutterServer.trackLlmCall. */
export function trackLlmCall(call: TrackedLlmCall): void {
	if (S.active) {
		S.active.trackLlmCall(call);
		return;
	}
	recordLlmCall(trace.getTracer("autter-llm"), call);
}

/** Module-level convenience for warnings/info — see AutterServer.captureMessage. */
export function captureMessage(
	message: string,
	severity: AutterSeverity = "warning",
	attributes?: Attributes,
): void {
	if (S.active) {
		S.active.captureMessage(message, severity, attributes);
		return;
	}
	const safeMessage = S.redactor.text(message);
	const span = trace.getTracer("autter-errors").startSpan("Message", {
		attributes: { "autter.severity": severity, ...S.redactor(attributes) },
	});
	span.addEvent("exception", {
		"exception.type": "Message",
		"exception.message": safeMessage,
		"autter.severity": severity,
		...breadcrumbEventAttributes(S.redactor.text),
	});
	span.setStatus({ code: SpanStatusCode.ERROR, message: safeMessage });
	span.end();
}

/** Portable OTLP `autter.outcome` event for failed results without exceptions. */
export function reportOutcome(name: string, message: string, attributes?: Attributes): void {
	if (S.active) return S.active.reportOutcome(name, message, attributes);
	const span = trace.getTracer("autter-outcomes").startSpan("OutcomeFailure");
	const safeOutcome = redactAttributes({ "autter.outcome.name": name.slice(0, 200), "autter.outcome.message": message.slice(0, 1000) });
	const safeName = String(safeOutcome["autter.outcome.name"] ?? "operation");
	const safeMessage = String(safeOutcome["autter.outcome.message"] ?? "failed");
	span.addEvent("autter.outcome", {
		...redactAttributes(attributes),
		"autter.outcome.status": "error",
		"autter.outcome.name": safeName,
		"autter.outcome.message": safeMessage,
	});
	span.setStatus({ code: SpanStatusCode.ERROR, message: safeMessage });
	span.end();
}

/** Capture surface with guaranteed redaction, regardless of how the host app
 * configured initAutterServer — for library authors whose calls must never
 * forward PII even when the host disabled it. Routes to the active server
 * (or degrades to the global tracer exactly like captureException). */
export interface SafeCapture {
	captureException(error: unknown, attributes?: Attributes): void;
	captureMessage(
		message: string,
		severity?: AutterSeverity,
		attributes?: Attributes,
	): void;
}

/**
 * Build a redacting capture wrapper:
 *
 *   const safe = makeSafeCapture();
 *   safe.captureException(err, { "user.email": email }); // masked before export
 *
 * The returned functions have the same signatures as their plain twins;
 * every attribute passes through redactAttributes() first. Note that when
 * the host has NOT disabled redaction this is belt-and-braces (already on by
 * default) — its value is enforcing privacy inside libraries and wrappers.
 */
export function makeSafeCapture(options?: RedactOptions): SafeCapture {
	const clean = (attributes?: Attributes): Attributes | undefined =>
		attributes ? { ...redactAttributes(attributes, options) } : undefined;
	return {
		captureException: (error, attributes) =>
			captureException(error, clean(attributes)),
		captureMessage: (message, severity, attributes) =>
			captureMessage(message, severity ?? "warning", clean(attributes)),
	};
}

/** Tracer from the always-on provider (never head-sampled), or the global
 * provider when initAutterServer hasn't run — so wrappers are safe to call
 * unconditionally from library code. */
function alwaysOnTracer(name: string): Tracer {
	return S.alwaysOnProvider
		? S.alwaysOnProvider.getTracer(name)
		: trace.getTracer(name);
}

/** @internal Tracer used by the LLM wrappers — always-on once initialised. */
export function autterLlmTracer(): Tracer {
	return alwaysOnTracer("autter-llm");
}

/**
 * Emit one clearly-named fake LLM call (provider/model "autter-selftest",
 * 1 input + 1 output token, cost 0) and force-flush it, returning the
 * traceId — proves LLM traces reach the ingester without calling any real
 * model. For setup verification only; requires initAutterServer.
 */
export async function emitLlmSelftestTrace(): Promise<{ traceId: string }> {
	const provider = S.alwaysOnProvider;
	if (!provider) {
		throw new Error(
			"emitLlmSelftestTrace() requires initAutterServer() to have been called",
		);
	}
	let traceId = "";
	await withLlmCall(
		{
			provider: "autter-selftest",
			model: "autter-selftest",
			attributes: { "autter.selftest": true },
		},
		(llm) => {
			traceId = trace.getActiveSpan()?.spanContext().traceId ?? "";
			llm.setUsage({ inputTokens: 1, outputTokens: 1 });
			llm.setCost(0);
		},
	);
	await provider.forceFlush();
	return { traceId };
}
