import {
	SpanStatusCode,
	trace,
	type Attributes,
	type Span,
} from "@opentelemetry/api";
import {
	createErrorFilter,
	errorAttributes,
	fingerprintEventAttributes,
	isError,
	splitFingerprint,
	type IgnoreErrorPattern,
} from "@autter/runtime-core";
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
	installUnhandledRejectionCapture,
	recordedAsRejection,
} from "./unhandled-rejections.js";
import {
	captureException as serverCaptureException,
	serverActive,
	setLoggerOnlyCapture,
	structuredErrorAttributes,
} from "./server.js";
import { sharedSlot } from "./shared.js";

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
	/** Capture crashes via process.uncaughtExceptionMonitor, and unhandled
	 * rejections (`captureUnhandledRejections`). Default true. */
	captureGlobalErrors?: boolean;
	/** Same semantics as initAutterServer: record unhandled rejections as
	 * errors without changing whether the process crashes. Default true. */
	captureUnhandledRejections?: boolean;
	/** Flush records on beforeExit/SIGINT/SIGTERM. Default true. */
	autoFlush?: boolean;
	debug?: boolean;
	/**
	 * "auto" (default): record on the app's active recording span if any,
	 * else emit a promoted log record. "log": always emit the log record
	 * (use when the app's own spans are not exported to Autter).
	 */
	exceptions?: "auto" | "log";
	/** Same semantics as initAutterServer: share of captured errors reported (crashes never sampled). */
	sampleRate?: number;
	/** Same semantics as initAutterServer: errors never reported (type or message). */
	ignoreErrors?: IgnoreErrorPattern[];
}

export interface AutterLogging {
	captureException(error: unknown, attributes?: Attributes): void;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

/** The running initAutterLogging handle, shared by every copy of this
 * package in the process (see shared.ts). */
const L = sharedSlot<{ active: AutterLogging | null }>("logging", () => ({ active: null }));

export function initAutterLogging(options: AutterLoggingOptions): AutterLogging {
	if (L.active) return L.active;
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

	const errorFilter = createErrorFilter({ ignoreErrors: options.ignoreErrors, sampleRate: options.sampleRate });

	function captureException(error: unknown, attributes?: Attributes): void {
		markCaptured(error);
		const isErrValue = isError(error);
		const reported = errorFilter({
			type: isErrValue ? String(error.name ?? "") : "Error",
			message: isErrValue ? String(error.message ?? "") : String(error),
			crash: attributes?.["autter.unhandled"] === true || attributes?.["autter.unhandled_rejection"] === true,
		});
		if (!reported) return;
		const split = splitFingerprint(attributes);
		const fingerprint = fingerprintEventAttributes(split.fingerprint, redact.text);
		const redacted = redact(split.attributes);
		const span: Span | undefined = trace.getActiveSpan();
		if (mode === "auto" && span?.isRecording()) {
			noteOperationError(error);
			notifyException(error, { ...redacted, ...fingerprint });
			span.setAttributes({ "autter.severity": "error", ...redacted, ...structuredErrorAttributes(error) });
			const declared = { ...errorAttributes(error), ...fingerprint };
			if (isError(error)) {
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
				message: isError(error) ? error.message : String(error),
			});
			return;
		}
		notifyException(error, { ...redacted, ...fingerprint });
		captureExceptionAsLog(error, { ...redacted, ...fingerprint });
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

	const onCrash = (error: unknown) => {
		if (recordedAsRejection(error)) return;
		captureException(error, { "autter.unhandled": true });
	};
	let uninstallRejections: (() => void) | null = null;
	if (options.captureGlobalErrors !== false) {
		process.on("uncaughtExceptionMonitor", onCrash);
		if (options.captureUnhandledRejections !== false)
			uninstallRejections = installUnhandledRejectionCapture((reason) =>
				captureException(reason, { "autter.unhandled_rejection": true }),
			);
	}

	registerFlushTarget("logging", { forceFlush: () => flushRuntimeLogs() });
	let autoFlushHandle: AutoFlushHandle | null =
		options.autoFlush === false ? null : installAutterAutoFlush();

	const handle: AutterLogging = {
		captureException,
		flush: flushRuntimeLogs,
		shutdown: async () => {
			process.off("uncaughtExceptionMonitor", onCrash);
			uninstallRejections?.();
			uninstallRejections = null;
			setLoggerOnlyCapture(null);
			autoFlushHandle?.dispose();
			autoFlushHandle = null;
			unregisterFlushTargets();
			if (L.active === handle) L.active = null;
			await shutdownRuntimeLogger();
		},
	};
	L.active = handle;
	return handle;
}
