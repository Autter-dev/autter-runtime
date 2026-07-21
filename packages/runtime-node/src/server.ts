import { trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
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

	const sdk = new NodeSDK({
		resource,
		sampler: new ParentBasedSampler({
			root: new TraceIdRatioBasedSampler(options.traceSampleRate ?? 0.01),
		}),
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

	// Errors must never be lost to head sampling, so captured exceptions go
	// through a dedicated always-on provider with its own batch processor.
	const errorProvider = new BasicTracerProvider({
		resource,
		sampler: new AlwaysOnSampler(),
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
				{ scheduledDelayMillis: 2000 },
			),
		],
	});
	const errorTracer = errorProvider.getTracer("autter-errors");

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
			void errorProvider.forceFlush().catch(() => {});
		});
	}

	const server: AutterServer = {
		captureException,
		captureMessage,
		shutdown: async () => {
			active = null;
			await Promise.allSettled([errorProvider.shutdown(), sdk.shutdown()]);
		},
	};
	active = server;
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
