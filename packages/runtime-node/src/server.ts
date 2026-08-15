import {
	trace,
	SpanKind,
	SpanStatusCode,
	type Attributes,
	type Context,
	type Link,
	type Span,
	type Tracer,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	BatchSpanProcessor,
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
	AlwaysOnSampler,
	BasicTracerProvider,
	SamplingDecision,
	type Sampler,
	type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

/**
 * Curated OpenTelemetry setup for Autter Runtime — deliberately NOT the
 * auto-instrumentation metapackage. Default data-volume policy:
 *
 *   errors / captured exceptions : 100%  (dedicated always-on error tracer)
 *   LLM / GenAI call spans       : 100%  (cost tracking needs every call)
 *   successful traces            : 1%    (head sampling, configurable)
 *   request metrics              : aggregated every 60 s
 *   logs                         : not collected
 *
 * Exports OTLP/HTTP JSON to the Autter ingester (`/v1/traces`,
 * `/v1/metrics`) with the ingest key as a bearer header.
 */

export interface AutterServerOptions {
	/** Private ingest key (autter_rt_…). */
	apiKey: string;
	/** Ingester base URL. Default: https://otlp.autter.dev */
	endpoint?: string;
	service: string;
	environment?: string;
	/** e.g. a git SHA. Maps to service.version / release. */
	release?: string;
	/** Head-sampling ratio for regular traces. Default 0.01 (1%). */
	traceSampleRate?: number;
	/** Metric export interval. Default 60_000 ms. */
	metricIntervalMs?: number;
	/** Capture crashing exceptions via process.uncaughtExceptionMonitor (default true). */
	captureGlobalErrors?: boolean;
	/**
	 * Record LLM/GenAI spans (`gen_ai.*` semconv, Vercel AI SDK `ai.*`,
	 * `withLlmCall`) at 100% regardless of `traceSampleRate`, so every model
	 * call is tracked with tokens/cost (default true).
	 */
	llmTracing?: boolean;
	/** Extra instrumentations (e.g. `new ExpressInstrumentation()`). */
	instrumentations?: unknown[];
}

export type AutterSeverity = "fatal" | "error" | "warning" | "info";

export interface AutterServer {
	/** Report a handled exception. Always recorded (never sampled out). */
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
	/** Flush and stop all exporters. Call on graceful shutdown. */
	shutdown(): Promise<void>;
}

let active: AutterServer | null = null;
/** Always-on provider shared by error, LLM, and process spans — set while a
 * server is active so withLlmCall/withProcessSpan bypass head sampling. */
let activeAlwaysOnProvider: BasicTracerProvider | null = null;

// Marks a span as an LLM/GenAI call: OTel GenAI semconv attributes, or the
// span names the Vercel AI SDK and GenAI instrumentations use. Attributes
// must be present at span creation for head sampling to see them — true for
// the Vercel AI SDK, withLlmCall, and the OTel GenAI instrumentations.
const LLM_MARKER_ATTRIBUTES = [
	"gen_ai.operation.name",
	"gen_ai.system",
	"gen_ai.provider.name",
	"gen_ai.request.model",
];

function isLlmSpan(name: string, attributes: Attributes): boolean {
	if (name.startsWith("ai.") || name.startsWith("gen_ai.")) return true;
	return LLM_MARKER_ATTRIBUTES.some((key) => attributes[key] !== undefined);
}

/** Delegates to the regular head sampler except for LLM/GenAI spans, which
 * are always recorded — 1% of model calls is useless for cost tracking. */
class LlmAwareSampler implements Sampler {
	constructor(private readonly delegate: Sampler) {}

	shouldSample(
		context: Context,
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
			context,
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

export function initAutterServer(options: AutterServerOptions): AutterServer {
	if (active) return active;

	const endpoint = (options.endpoint ?? "https://otlp.autter.dev").replace(
		/\/$/,
		"",
	);
	const headers = { authorization: `Bearer ${options.apiKey}` };
	const environment = options.environment ?? process.env.NODE_ENV ?? "production";

	const resource = new Resource({
		[ATTR_SERVICE_NAME]: options.service,
		...(options.release ? { [ATTR_SERVICE_VERSION]: options.release } : {}),
		"deployment.environment": environment,
	});

	const headSampler = new ParentBasedSampler({
		root: new TraceIdRatioBasedSampler(options.traceSampleRate ?? 0.01),
	});
	const sdk = new NodeSDK({
		resource,
		// LLM tracing is on by default: gen_ai/ai.* spans emitted through the
		// global provider (Vercel AI SDK, GenAI instrumentations) skip head
		// sampling so every model call reaches the ingester.
		sampler:
			options.llmTracing === false
				? headSampler
				: new LlmAwareSampler(headSampler),
		traceExporter: new OTLPTraceExporter({
			url: `${endpoint}/v1/traces`,
			headers,
		}),
		metricReader: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({
				url: `${endpoint}/v1/metrics`,
				headers,
			}),
			exportIntervalMillis: options.metricIntervalMs ?? 60_000,
		}),
		instrumentations: [
			new HttpInstrumentation(),
			...((options.instrumentations ?? []) as never[]),
		],
	});
	sdk.start();

	// Errors, LLM calls, and process spans must never be lost to head
	// sampling, so they go through a dedicated always-on provider with its
	// own batch processor.
	const alwaysOnProvider = new BasicTracerProvider({
		resource,
		sampler: new AlwaysOnSampler(),
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
				{ scheduledDelayMillis: 2000 },
			),
		],
	});
	const errorTracer = alwaysOnProvider.getTracer("autter-errors");

	function captureException(error: unknown, attributes?: Attributes): void {
		const isError = error instanceof Error;
		const message = isError ? error.message : String(error);
		const span = errorTracer.startSpan(isError ? error.name : "Error", {
			attributes: { "autter.severity": "error", ...attributes },
		});
		if (isError) {
			span.recordException(error);
		} else {
			span.addEvent("exception", {
				"exception.type": "Error",
				"exception.message": message,
			});
		}
		span.setStatus({ code: SpanStatusCode.ERROR, message });
		span.end();
	}

	function captureMessage(
		message: string,
		severity: AutterSeverity = "warning",
		attributes?: Attributes,
	): void {
		// Same wire shape as an exception (an event named "exception" with
		// ERROR status is what the ingester turns into an occurrence), with
		// autter.severity carrying the level. A synthetic stack (minus this
		// frame) marks the call site so warnings group by origin.
		const stack = new Error().stack
			?.split("\n")
			.filter((line, i) => i === 0 || !line.includes("captureMessage"))
			.join("\n");
		const span = errorTracer.startSpan("Message", {
			attributes: { "autter.severity": severity, ...attributes },
		});
		span.addEvent("exception", {
			"exception.type": "Message",
			"exception.message": message,
			...(stack ? { "exception.stacktrace": stack } : {}),
			"autter.severity": severity,
		});
		span.setStatus({ code: SpanStatusCode.ERROR, message });
		span.end();
	}

	if (options.captureGlobalErrors !== false) {
		// `uncaughtExceptionMonitor` observes crashes WITHOUT changing the
		// process's exit semantics (unlike an `uncaughtException` listener).
		// Best-effort: the batch may not fully flush before the process dies.
		process.on("uncaughtExceptionMonitor", (err) => {
			captureException(err, { "autter.unhandled": true });
			void alwaysOnProvider.forceFlush().catch(() => {});
		});
	}

	const server: AutterServer = {
		captureException,
		captureMessage,
		shutdown: async () => {
			active = null;
			activeAlwaysOnProvider = null;
			await Promise.allSettled([alwaysOnProvider.shutdown(), sdk.shutdown()]);
		},
	};
	active = server;
	activeAlwaysOnProvider = alwaysOnProvider;
	return server;
}

/** Module-level convenience — routes to the active server, or degrades to a
 * span on the global tracer so libraries can call it unconditionally. */
export function captureException(
	error: unknown,
	attributes?: Attributes,
): void {
	if (active) {
		active.captureException(error, attributes);
		return;
	}
	const span = trace
		.getTracer("autter-errors")
		.startSpan(error instanceof Error ? error.name : "Error", { attributes });
	if (error instanceof Error) span.recordException(error);
	span.setStatus({
		code: SpanStatusCode.ERROR,
		message: error instanceof Error ? error.message : String(error),
	});
	span.end();
}

/** Module-level convenience for warnings/info — see AutterServer.captureMessage. */
export function captureMessage(
	message: string,
	severity: AutterSeverity = "warning",
	attributes?: Attributes,
): void {
	if (active) {
		active.captureMessage(message, severity, attributes);
		return;
	}
	const span = trace.getTracer("autter-errors").startSpan("Message", {
		attributes: { "autter.severity": severity, ...attributes },
	});
	span.addEvent("exception", {
		"exception.type": "Message",
		"exception.message": message,
		"autter.severity": severity,
	});
	span.setStatus({ code: SpanStatusCode.ERROR, message });
	span.end();
}

/** Tracer from the always-on provider (never head-sampled), or the global
 * provider when initAutterServer hasn't run — so wrappers are safe to call
 * unconditionally from library code. */
function alwaysOnTracer(name: string): Tracer {
	return activeAlwaysOnProvider
		? activeAlwaysOnProvider.getTracer(name)
		: trace.getTracer(name);
}

async function runInSpan<T>(span: Span, fn: () => T | Promise<T>): Promise<T> {
	try {
		const result = await fn();
		span.setStatus({ code: SpanStatusCode.OK });
		return result;
	} catch (err) {
		if (err instanceof Error) span.recordException(err);
		span.setStatus({
			code: SpanStatusCode.ERROR,
			message: err instanceof Error ? err.message : String(err),
		});
		throw err;
	} finally {
		span.end();
	}
}

export interface LlmCallOptions {
	/** Provider id — "openai", "anthropic", "google", … (gen_ai.provider.name). */
	provider: string;
	/** Requested model id, e.g. "gpt-5-mini" (gen_ai.request.model). */
	model: string;
	/** gen_ai.operation.name — "chat" (default), "embeddings", … */
	operation?: string;
	/** Opaque end-user id, never an email (autter.user_id). */
	userId?: string;
	/** Extra span attributes. */
	attributes?: Attributes;
}

export interface LlmCall {
	/** Token counts from the provider response — powers cost estimation. */
	setUsage(usage: { inputTokens?: number; outputTokens?: number }): void;
	/** Exact cost in USD; without it the ingester estimates from its price table. */
	setCost(usd: number): void;
	/** Model the provider actually served (gen_ai.response.model). */
	setResponseModel(model: string): void;
	setAttributes(attributes: Attributes): void;
}

/**
 * Wrap a call to any LLM client so it is recorded as a GenAI span — always
 * exported (never head-sampled), tracked for tokens, latency, cost, and
 * failures. Errors are rethrown after marking the span (and surface as
 * error occurrences, so failing models show up as issues too).
 *
 *   const res = await withLlmCall(
 *     { provider: "openai", model: "gpt-5-mini", userId: user.id },
 *     async (llm) => {
 *       const out = await openai.chat.completions.create({ ... });
 *       llm.setUsage({
 *         inputTokens: out.usage?.prompt_tokens,
 *         outputTokens: out.usage?.completion_tokens,
 *       });
 *       return out;
 *     },
 *   );
 *
 * Vercel AI SDK users don't need this — `experimental_telemetry:
 * { isEnabled: true }` emits gen_ai spans that are captured automatically.
 */
export async function withLlmCall<T>(
	call: LlmCallOptions,
	fn: (llm: LlmCall) => T | Promise<T>,
): Promise<T> {
	const operation = call.operation ?? "chat";
	return alwaysOnTracer("autter-llm").startActiveSpan(
		`${operation} ${call.model}`,
		{
			kind: SpanKind.CLIENT,
			attributes: {
				"gen_ai.operation.name": operation,
				// Both keys: gen_ai.system is the pre-1.37 semconv name and
				// what most tooling still matches on.
				"gen_ai.provider.name": call.provider,
				"gen_ai.system": call.provider,
				"gen_ai.request.model": call.model,
				...(call.userId ? { "autter.user_id": call.userId } : {}),
				...call.attributes,
			},
		},
		(span) =>
			runInSpan(span, () =>
				fn({
					setUsage: (usage) => {
						if (usage.inputTokens !== undefined) {
							span.setAttribute(
								"gen_ai.usage.input_tokens",
								Math.max(0, Math.round(usage.inputTokens)),
							);
						}
						if (usage.outputTokens !== undefined) {
							span.setAttribute(
								"gen_ai.usage.output_tokens",
								Math.max(0, Math.round(usage.outputTokens)),
							);
						}
					},
					setCost: (usd) => span.setAttribute("autter.llm.cost_usd", usd),
					setResponseModel: (model) =>
						span.setAttribute("gen_ai.response.model", model),
					setAttributes: (attributes) => span.setAttributes(attributes),
				}),
			),
	);
}

/**
 * Wrap a recurring unit of non-HTTP work (queue consumer, cron tick, batch
 * job) in an always-recorded span so the slow-process monitor can see it.
 * Use stable, low-cardinality names ("invoice.rebuild"); ids go in
 * attributes. Errors are rethrown after marking the span failed.
 */
export async function withProcessSpan<T>(
	name: string,
	fn: () => T | Promise<T>,
	attributes?: Attributes,
): Promise<T> {
	return alwaysOnTracer("autter-process").startActiveSpan(
		name,
		{ kind: SpanKind.INTERNAL, attributes },
		(span) => runInSpan(span, fn),
	);
}

/**
 * Emit one clearly-named fake LLM call (provider/model "autter-selftest",
 * 1 input + 1 output token, cost 0) and force-flush it, returning the
 * traceId — proves LLM traces reach the ingester without calling any real
 * model. For setup verification only; requires initAutterServer.
 */
export async function emitLlmSelftestTrace(): Promise<{ traceId: string }> {
	const provider = activeAlwaysOnProvider;
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
