import { ServerResponse, type IncomingMessage } from "node:http";
import {
	context,
	trace,
	SpanKind,
	SpanStatusCode,
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
 *   named process spans          : 100%  (withProcessSpan, always-on tracer)
 *   LLM / GenAI call spans       : 100%  (withLlmCall/trackLlmCall/
 *                                         instrumentLlmClient + an LLM-aware
 *                                         sampler that keeps GenAI/Vercel-AI
 *                                         spans — cost tracking needs every
 *                                         call)
 *   successful traces            : 1%    (head sampling, configurable)
 *   request metrics              : aggregated every 60 s, keyed by route
 *                                  template (Express routes detected
 *                                  out of the box — see captureExpressRoute)
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

/** Token usage (and optionally exact cost) of one LLM call. */
export interface LlmUsage {
	inputTokens?: number;
	outputTokens?: number;
	/**
	 * Exact cost in USD, if the provider reports it. Overrides Autter's
	 * built-in per-model price estimate.
	 */
	costUsd?: number;
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
		...info.attributes,
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
	const setResponseModel = (model: string) =>
		span.setAttribute("gen_ai.response.model", model);
	const handle: LlmCallHandle = {
		setUsage: (usage) => span.setAttributes(usageAttributes(usage)),
		setCost: (usd) => span.setAttribute("autter.llm.cost_usd", usd),
		setResponseModel,
		setModel: setResponseModel,
		setAttributes: (attributes) => span.setAttributes(attributes),
	};
	try {
		const result = await context.with(
			trace.setSpan(context.active(), span),
			() => fn(handle),
		);
		span.setStatus({ code: SpanStatusCode.OK });
		return result;
	} catch (err) {
		if (err instanceof Error) {
			span.recordException(err);
			span.setAttribute("error.type", err.name);
		}
		span.setStatus({
			code: SpanStatusCode.ERROR,
			message: err instanceof Error ? err.message : String(err),
		});
		throw err;
	} finally {
		span.end();
	}
}

function recordLlmCall(tracer: Tracer, call: TrackedLlmCall): void {
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
		if (call.error instanceof Error) {
			span.recordException(call.error);
			span.setAttribute("error.type", call.error.name);
		}
		span.setStatus({
			code: SpanStatusCode.ERROR,
			message:
				call.error instanceof Error ? call.error.message : String(call.error),
		});
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
): Promise<T> {
	const span = tracer.startSpan(name, { attributes });
	try {
		const result = await context.with(
			trace.setSpan(context.active(), span),
			fn,
		);
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

/** Express (4/5) assigns routing state onto the core request object; a
 * matched handler leaves the route template on `req.route.path` and the
 * mount prefix on `req.baseUrl`. */
interface ExpressRequestProps {
	baseUrl?: unknown;
	route?: { path?: unknown };
}

/**
 * Route template of a finished Express request ("/api/users/:id"), or null
 * when no route matched (404s, static files) or the server isn't Express.
 * Only meaningful at response end — Express fills `req.route` during routing.
 */
function expressRouteOf(req: unknown): string | null {
	const props = req as ExpressRequestProps | null | undefined;
	const path = props?.route?.path;
	if (typeof path !== "string" || path === "") return null;
	const base = typeof props?.baseUrl === "string" ? props.baseUrl : "";
	const route = base + path;
	return route.startsWith("/") ? route : null;
}

/**
 * HttpInstrumentation responseHook: copy the Express route template into
 * `rpcMetadata.route` before the instrumentation snapshots attributes at
 * response close. That is the only channel through which `http.route`
 * reaches BOTH the server span and the `http.server.duration` histogram —
 * metric data points never carry raw URL paths (cardinality), so without a
 * route here every per-route rollup row lands on the empty route. A router
 * instrumentation supplied via `options.instrumentations` (e.g.
 * ExpressInstrumentation) wins when it has already set the route.
 */
function captureExpressRoute(
	_span: Span,
	response: IncomingMessage | ServerResponse,
): void {
	// The hook also fires for outgoing client responses (IncomingMessage).
	if (!(response instanceof ServerResponse)) return;
	const rpcMetadata = getRPCMetadata(context.active());
	if (rpcMetadata?.type !== RPCType.HTTP) return;
	const setRoute = () => {
		if (rpcMetadata.route) return;
		const route = expressRouteOf(response.req);
		if (route) rpcMetadata.route = route;
	};
	// prependListener: must run before the instrumentation's own 'close'
	// handler reads rpcMetadata. 'finish' covers completed responses,
	// 'close' covers aborted ones; setRoute is idempotent.
	response.prependListener("finish", setRoute);
	response.prependListener("close", setRoute);
}

let active: AutterServer | null = null;
/** Always-on provider shared by error, LLM, and process spans — set while a
 * server is active so withLlmCall/withProcessSpan bypass head sampling. */
let activeAlwaysOnProvider: BasicTracerProvider | null = null;

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
		// Tells the ingester request metrics arrive on the metrics pipe, so
		// it must not also fold our server spans into usage rollups (that
		// would double-count every sampled request).
		"autter.metrics_wired": true,
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
				// Deltas, not lifetime totals: the ingester SUMs data points
				// into runtime_metrics_1m, and the default (cumulative)
				// temporality would re-count every past request on each
				// 60 s export.
				temporalityPreference: AggregationTemporalityPreference.DELTA,
			}),
			exportIntervalMillis: options.metricIntervalMs ?? 60_000,
		}),
		instrumentations: [
			new HttpInstrumentation({ responseHook: captureExpressRoute }),
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
	// Process spans share the always-on provider (same OTLP pipe, no extra
	// exporter) under their own scope name.
	const processTracer = alwaysOnProvider.getTracer("autter-processes");
	// LLM calls likewise ride the always-on pipe — usage/cost accounting
	// cannot tolerate head sampling.
	const llmTracer = alwaysOnProvider.getTracer("autter-llm");

	function captureException(error: unknown, attributes?: Attributes): void {
		const isError = error instanceof Error;
		const message = isError ? error.message : String(error);
		const span = errorTracer.startSpan(isError ? error.name : "Error", {
			attributes: { "autter.severity": "error", ...attributes },
		});
		if (isError && error.stack) {
			span.recordException(error);
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
				"exception.type": isError ? error.name : "Error",
				"exception.message": message,
				...(stack ? { "exception.stacktrace": stack } : {}),
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
		// The async twin of an uncaught exception: a rejected promise with no
		// `.catch`. Registering this listener also stops Node's default
		// `throw` mode from crashing the process, so — unlike the monitor
		// above — execution continues and the batch exporter flushes on its
		// normal schedule.
		process.on("unhandledRejection", (reason: unknown) => {
			// A non-Error reason has no stack and no real type — usually
			// injected junk rather than an app fault. Report it as a warning so
			// it does not open a first-class issue. Mirrors the browser SDK's
			// `unhandledrejection` handling.
			captureException(reason, {
				"autter.unhandled": true,
				...(reason instanceof Error ? {} : { "autter.severity": "warning" }),
			});
		});
	}

	const server: AutterServer = {
		captureException,
		captureMessage,
		withProcessSpan: (name, fn, attributes) =>
			runWithSpan(processTracer, name, fn, attributes),
		withLlmCall: (info, fn) => runLlmSpan(llmTracer, info, fn),
		trackLlmCall: (call) => recordLlmCall(llmTracer, call),
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
	if (active) return active.withProcessSpan(name, fn, attributes);
	return runWithSpan(trace.getTracer("autter-processes"), name, fn, attributes);
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
	if (active) return active.withLlmCall(info, fn);
	return runLlmSpan(trace.getTracer("autter-llm"), info, fn);
}

/** Module-level convenience — see AutterServer.trackLlmCall. */
export function trackLlmCall(call: TrackedLlmCall): void {
	if (active) {
		active.trackLlmCall(call);
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
