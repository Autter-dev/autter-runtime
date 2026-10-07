/**
 * @autter/runtime-core — PRIVATE. Bundled into @autter/runtime-node and
 * @autter/runtime-edge at build time (tsup `noExternal`); never published
 * and never a runtime dependency of a published package. Must stay free of
 * Node built-ins: it runs on Workers, Vercel Edge, Deno and Bun.
 */
export type { Attributes, AttributeValue } from "./attributes.js";
export {
	redactAttributes,
	makeRedactor,
	type RedactOptions,
} from "./redact.js";
export {
	LEVEL_SEVERITY,
	maxLevel,
	boundContext,
	userContext,
	mergeContext,
	toSpanAttributes,
	type Redactor,
	type RuntimeLogContext,
	type RuntimeLogContextValue,
	type RuntimeLogLevel,
	type RuntimeOutcome,
	type RuntimeOperationKind,
} from "./context.js";
export {
	CODE_PATTERN,
	CODE_MAX_LENGTH,
	RuntimeError,
	defineRuntimeErrors,
	isRuntimeErrorLike,
	isValidErrorCode,
	errorCodeOf,
	errorStatusOf,
	isExpectedError,
	errorAttributes,
	errorInternal,
	toClientError,
	responseStatusOf,
	type RuntimeErrorDefinition,
	type RuntimeErrorExtras,
	type RuntimeErrorOptions,
	type RuntimeErrorLike,
	type RuntimeErrorFactory,
	type RuntimeErrorCatalog,
	type ClientErrorBody,
	type ErrorAttributeOptions,
} from "./errors.js";
export {
	INLINE_LOG_LIMIT,
	createInlineLogState,
	appendInlineLog,
	addAiUsage,
	createRuntimeEvent,
	isSummary,
	severityOf,
	type RuntimeEvent,
	type InlineLog,
	type InlineLogState,
	type AiRollup,
	type AiUsageInput,
} from "./record.js";
export {
	otlpValue,
	toOtlpLogRecord,
	buildOtlpLogsRequest,
	type OtlpLogRecord,
	type OtlpResource,
} from "./otlp-logs.js";
export {
	createCarrier,
	parseCarrier,
	formatTraceparent,
	parseTraceparent,
	type RuntimeCarrier,
} from "./carrier.js";
export {
	REQUEST_ID_PATTERN,
	DEFAULT_REQUEST_ID_HEADER,
	resolveRequestId,
	normalizeRoutePath,
	compileIgnore,
	requestOutcome,
	type RequestOutcomeInput,
} from "./request.js";
export { parseUserAgent, type UserAgentInfo } from "./user-agent.js";
export {
	CODE_FINGERPRINT_SCHEME,
	codeFingerprint,
} from "./fingerprint-code.js";
