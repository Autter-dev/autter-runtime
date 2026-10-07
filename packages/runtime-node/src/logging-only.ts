import {
	SpanStatusCode,
	trace,
	type Attributes,
	type Span,
} from "@opentelemetry/api";
import { errorAttributes } from "@autter/runtime-core";
import {
	captureExceptionAsLog,
	configureRuntimeLogger,
	flushRuntimeLogs,
	noteOperationError,
	notifyException,
	runtimeLogger,
	shutdownRuntimeLogger,
	type RuntimeLoggingOptions,
} from "./logger.js";
import {
	debugLog,
	installAutterAutoFlush,
	isDebugEnabled,
	registerFlushTarget,
	setDebugMode,
	unregisterFlushTargets,
	type AutoFlushHandle,
} from "./lifecycle.js";
import { makeRedactor, type RedactOptions } from "./redact.js";
import { markCaptured } from "./requests.js";
import {
	captureException as serverCaptureException,
	serverActive,
	setLoggerOnlyCapture,
	structuredErrorAttributes,
} from "./server.js";

/**
 * Logger-only mode: requests, operations, coded errors, sinks and enrichers
 * WITHOUT starting the OpenTelemetry NodeSDK. For apps that already run
 * their own OTel (a second NodeSDK would fight it) or want logs only.
 *
 *   initAutterLogging({ apiKey: process.env.AUTTER_RUNTIME_KEY, service: "api" });
 *
 * Exceptions are recorded on the app's active span when there is one
 * (`exceptions: "auto"`); otherwise — or always with `exceptions: "log"` —
 * they become error log records with `exception.*` and
 * `autter.capture.mode = "log"`, which the ingester (1.5.0+) promotes to
 * occurrences. Without an apiKey records go to the console/file sinks only.
 */
export interface AutterLoggingOptions {
	/** Private ingest key (autter_rt_…). Omit to log locally only. */
	apiKey?: string;
	/** Ingester base URL. Default: https://otlp.autter.dev */
	endpoint?: string;
	service: string;
	environment?: string;
	release?: string;
	logging?: RuntimeLoggingOptions;
	/** Same semantics as initAutterServer. Default true. */
	redactAttributes?: boolean | RedactOptions;
	/** Capture crashes via process.uncaughtExceptionMonitor. Default true. */
	captureGlobalErrors?: boolean;
	/** Flush records on beforeExit/SIGINT/SIGTERM. Default true. */
	autoFlush?: boolean;
	debug?: boolean;
	/**
	 * "auto" (default): record on the app's active recording span if any,
	 * else emit a promoted log record. "log": always emit the log record
	 * (use when the app's own spans are not exported to Autter).
	 */
	exceptions?: "auto" | "log";
}

export interface AutterLogging {
	captureException(error: unknown, attributes?: Attributes): void;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

let activeLogging: AutterLogging | null = null;

export function initAutterLogging(options: AutterLoggingOptions): AutterLogging {
	if (activeLogging) return activeLogging;
	if (serverActive()) {
		console.warn(
			"[autter-runtime] initAutterLogging() ignored: initAutterServer() is already active and includes logging",
		);
		return {
			captureException: serverCaptureException,
			flush: flushRuntimeLogs,
			shutdown: async () => {},
		};
	}
	if (isDebugEnabled() || options.debug === true) setDebugMode(true);
	const endpoint = (options.endpoint ?? "https://otlp.autter.dev").replace(/\/$/, "");
	const environment = options.environment ?? process.env.NODE_ENV ?? "production";
	const redact = makeRedactor(options.redactAttributes ?? true);
	const mode = options.exceptions ?? "auto";
	debugLog(`initialising logger-only service=${options.service} endpoint=${endpoint}`);

	function captureException(error: unknown, attributes?: Attributes): void {
		markCaptured(error);
		const redacted = redact(attributes);
		const span: Span | undefined = trace.getActiveSpan();
		if (mode === "auto" && span?.isRecording()) {
			noteOperationError(error);
			notifyException(error, redacted);
			span.setAttributes({ "autter.severity": "error", ...redacted, ...structuredErrorAttributes(error) });
			const declared = errorAttributes(error);
			if (error instanceof Error) {
				span.addEvent("exception", {
					"exception.type": error.name,
					"exception.message": error.message,
					...(error.stack ? { "exception.stacktrace": error.stack } : {}),
					...declared,
				});
			} else {
				span.addEvent("exception", {
					"exception.type": "Error",
					"exception.message": String(error),
					...declared,
				});
			}
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		notifyException(error, redacted);
		captureExceptionAsLog(error, redacted);
	}

	const captured = new WeakSet<object>();
	configureRuntimeLogger({
		endpoint,
		apiKey: options.apiKey ?? "",
		service: options.service,
		environment,
		...(options.release ? { release: options.release } : {}),
		...(options.logging ? { options: options.logging } : {}),
		redact,
		reportOutcome: (name, message, attributes) => {
			runtimeLogger.error(message, {
				...(attributes as Record<string, string>),
				"autter.outcome.name": name.slice(0, 200),
				"autter.outcome.message": message.slice(0, 1000),
			});
		},
		captureThrown: (error) => {
			// One error rethrown through nested operations is one occurrence.
			if (error && typeof error === "object") {
				if (captured.has(error)) return;
				captured.add(error);
			}
			captureException(error);
		},
	});
	setLoggerOnlyCapture(captureException);

	const onCrash = (error: unknown) =>
		captureException(error, { "autter.unhandled": true });
	if (options.captureGlobalErrors !== false)
		process.on("uncaughtExceptionMonitor", onCrash);

	registerFlushTarget("logging", { forceFlush: () => flushRuntimeLogs() });
	let autoFlushHandle: AutoFlushHandle | null =
		options.autoFlush === false ? null : installAutterAutoFlush();

	const handle: AutterLogging = {
		captureException,
		flush: flushRuntimeLogs,
		shutdown: async () => {
			process.off("uncaughtExceptionMonitor", onCrash);
			setLoggerOnlyCapture(null);
			autoFlushHandle?.dispose();
			autoFlushHandle = null;
			unregisterFlushTargets();
			activeLogging = null;
			await shutdownRuntimeLogger();
		},
	};
	activeLogging = handle;
	return handle;
}
