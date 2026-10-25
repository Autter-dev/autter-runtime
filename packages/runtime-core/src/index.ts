/**
 * @autter/runtime-core — PRIVATE. Bundled into @autter/runtime-node and
 * @autter/runtime-edge at build time (tsup `noExternal`); never published
 * and never a runtime dependency of a published package. Must stay free of
 * Node built-ins: it runs on Workers, Vercel Edge, Deno and Bun.
 */
export type { Attributes, AttributeValue } from "./attributes.js";
export {
	redactAttributes,
	redactText,
	makeRedactor,
	type RedactOptions,
	type Redactor as AttributeRedactor,
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
	isError,
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
	stackAttributesLast,
} from "./errors.js";
export { DEBUG_IDS_ATTRIBUTE, debugIdsForStacks, firstFramePath } from "./debug-ids.js";
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
export {
	BREADCRUMBS_ATTRIBUTE,
	BREADCRUMBS_ATTRIBUTE_MAX_CHARS,
	MAX_BREADCRUMBS,
	BreadcrumbTrail,
	breadcrumbsAttribute,
	normalizeBreadcrumb,
	sanitizeBreadcrumbs,
	type Breadcrumb,
	type BreadcrumbInput,
	type BreadcrumbLevel,
	type BreadcrumbRedactor,
	type BreadcrumbType,
} from "./breadcrumbs.js";
export {
	FINGERPRINT_ATTRIBUTE,
	FINGERPRINT_MAX_LENGTH,
	FINGERPRINT_MAX_VALUES,
	fingerprintEventAttributes,
	fingerprintValues,
	splitFingerprint,
	type FingerprintInput,
} from "./fingerprint-override.js";
export {
	BurstLimiter,
	CAUGHT_BURST,
	CAUGHT_DROPPED_ATTRIBUTE,
	CAUGHT_REFILL_MS,
	DEGRADED_REASON_ATTRIBUTE,
	DEGRADED_REASON_MAX,
	HANDLED_ATTRIBUTE,
	HANDLING_ATTRIBUTE,
	LOG_MESSAGE_ATTRIBUTE,
	LOG_MESSAGE_MAX,
	LOG_SOURCE_ATTRIBUTE,
	caughtErrorAttributes,
	degradedAttributes,
	formatLogArguments,
	handledErrorKind,
	loggedErrorSources,
	type BurstTail,
	type CaptureLoggedErrorsOption,
	type LoggedErrorSource,
} from "./handled.js";
export {
	createErrorFilter,
	effectiveSampleRate,
	isIgnoredError,
	type ErrorFilter,
	type ErrorFilterInput,
	type ErrorFilterOptions,
	type IgnoreErrorPattern,
} from "./error-filter.js";
