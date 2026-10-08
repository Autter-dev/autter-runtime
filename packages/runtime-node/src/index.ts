export {
	createBrowserRelayHandler,
	createBrowserRelayFetchHandler,
	sanitizeBrowserPayload,
	type RelayOptions,
} from "./relay.js";
export {
	initAutterServer,
	captureException,
	captureMessage,
	reportOutcome,
	withProcessSpan,
	withLlmCall,
	trackLlmCall,
	emitLlmSelftestTrace,
	makeSafeCapture,
	type AutterServerOptions,
	type AutterServer,
	type AutterSeverity,
	type LlmCallInfo,
	type LlmCallHandle,
	type LlmUsage,
	type TrackedLlmCall,
	type SafeCapture,
} from "./server.js";
export {
	installAutterAutoFlush,
	type AutoFlushHandle,
	type AutoFlushOptions,
	type FlushTarget,
} from "./lifecycle.js";
export {
	redactAttributes,
	redactText,
	type RedactOptions,
} from "./redact.js";
export {
	instrumentLlmClient,
	type InstrumentLlmOptions,
} from "./llm-instrument.js";
export { startCaughtExceptionSampler } from "./caught-exceptions.js";
export {
	createRuntimeLogger,
	runtimeLogger,
	withRuntimeOperation,
	flushRuntimeLogs,
	runtimeLogStats,
	type RuntimeLogContext,
	type RuntimeLogContextValue,
	type RuntimeLogLevel,
	type RuntimeOutcome,
	type RuntimeOperation,
	type RuntimeLoggingOptions,
} from "./logger.js";
export {
	fetchIngesterCompat,
	evaluateCompat,
	COMPAT_MANIFEST,
	INGESTER_VERSION_HEADER,
	SDK_IDENTITY,
	type CompatIssue,
	type IngesterCompatInfo,
	type SdkIdentity,
} from "./compat.js";
export { runDoctor, type DoctorOptions, type DoctorReport } from "./doctor.js";
