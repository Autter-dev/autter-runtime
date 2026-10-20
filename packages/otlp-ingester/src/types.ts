export type RuntimeSource = "browser" | "server";

/**
 * Signal severity. Errors AND warnings/info land in the same occurrences
 * table (severity is a column, not a separate pipeline) so later
 * aggregations can slice one dataset by severity, fingerprint, route, etc.
 * Severity is intentionally NOT part of the fingerprint — the same defect
 * reported once as a warning and once as an error groups together.
 */
export type RuntimeSeverity = "fatal" | "error" | "warning" | "info";

export const RUNTIME_SEVERITIES: readonly string[] = [
	"fatal",
	"error",
	"warning",
	"info",
];

export function asSeverity(
	value: unknown,
	fallback: RuntimeSeverity,
): RuntimeSeverity {
	return typeof value === "string" && RUNTIME_SEVERITIES.includes(value)
		? (value as RuntimeSeverity)
		: fallback;
}

/** A normalised error/warning event, before fingerprinting. */
export interface RuntimeOccurrenceInput {
	source: RuntimeSource;
	severity: RuntimeSeverity;
	service: string;
	environment: string;
	release: string | null;
	errorType: string;
	message: string;
	stack: string | null;
	/** Path only — never a full URL with query params. */
	route: string | null;
	/** HTTP request method for server signals (GET, POST, …), if known. */
	method: string | null;
	statusCode: number | null;
	traceId: string | null;
	sessionId: string | null;
	attributes: Record<string, unknown> | null;
	occurredAt: Date;
	/**
	 * Declared error metadata (`autter.error.*`, see error-fields.ts) —
	 * optional and omitted when absent. A valid `errorCode` switches the
	 * fingerprint to the source-independent "code-v1" scheme.
	 */
	errorCode?: string;
	/** Declared cause (≤1000 chars). */
	why?: string;
	/** Declared remedy (≤1000 chars). */
	fix?: string;
	/** Docs link — http(s) only, ≤500 chars. */
	link?: string;
	/** Expected business failure (declines, validation): recorded, never paged. */
	expected?: boolean;
	/** `autter.request.id` — joins the occurrence to its request summary. */
	requestId?: string;
	/**
	 * Browser only: script URL → debug id for the scripts on the page, used
	 * to find their source maps (EI-13). Input-only: never stored or sent to
	 * the sink.
	 */
	debugIds?: Record<string, string>;
}

/**
 * One stack frame, innermost (crash site) first. The sink wire shape
 * (contract §1) — also stored as JSON in `runtime_error_occurrences.frames`.
 */
export interface StackFrame {
	/** Resolved name when symbolicated, else as parsed. */
	function: string | null;
	/** Package / module / class when the language has one. */
	module: string | null;
	/** Path as resolved (the source map `sources` entry when resolved), query/hash stripped. */
	filename: string | null;
	lineno: number | null;
	colno: number | null;
	/** False for dependency, runtime and extension frames (stack-frames.ts §3). */
	inApp: boolean;
	/** True when a source map resolved the frame. */
	resolved: boolean;
	/** Only when `sourcesContent` supplied it (≤ 300 chars). */
	contextLine?: string;
	/** ≤ 3 lines each, ≤ 300 chars per line. */
	preContext?: string[];
	postContext?: string[];
}

/**
 * Every grouping scheme an issue identity can come from (contract §1).
 * The ingester computes `manual-v1`, `code-v1`, `frames-v3` and
 * `message-v1`; `rule-v1` and `external-v1` exist only on the platform.
 */
export type FingerprintSchemeV2 =
	| "manual-v1"
	| "rule-v1"
	| "code-v1"
	| "frames-v3"
	| "message-v1"
	| "external-v1";

export interface FingerprintCandidate {
	scheme: FingerprintSchemeV2;
	/** 32 lowercase hex characters. */
	fingerprint: string;
}

/** What went into a fingerprint, for the "why these were grouped" UI. */
export interface FingerprintRecord {
	scheme: string;
	parts: string[];
}

/**
 * Derived, aggregation-ready fields — computed once at ingest (from the
 * same normalisers the fingerprint uses) and stored as their own columns
 * so later aggregations never have to re-parse stacks or routes in SQL.
 */
export interface RuntimeOccurrence extends RuntimeOccurrenceInput {
	occurrenceId: string;
	/**
	 * The LEGACY identity, byte-for-byte as before 1.6.0 so an older
	 * platform groups exactly as it did: "code-v1" or "message-v1".
	 */
	fingerprint: string;
	/** "code-v1" when grouped by a valid error code, else "message-v1". */
	fingerprintScheme: "message-v1" | "code-v1";
	/** Parsed (and, for browser JS, symbolicated) frames, innermost first, ≤ 50. */
	frames?: StackFrame[];
	/**
	 * Every applicable identity, highest precedence first (manual-v1,
	 * code-v1, frames-v3, message-v1); always ends with the legacy one.
	 */
	fingerprints?: FingerprintCandidate[];
	/** What went into the frames-v3 fingerprint, when one was computed. */
	fingerprintRecord?: FingerprintRecord;
	/** normalizeRoute(route) — "/users/:id/orders/:id"; GROUP BY-safe. */
	routeNormalized: string;
	/** normalizeMessage(message) — ids/numbers/strings templated out. */
	messageNormalized: string;
	/** Top normalised stack frames (≤5) — the "points" of the error. */
	topFrames: string[];
	/** topFrames[0] — single-column GROUP BY for "where did this come from". */
	firstFrame: string;
}

export interface RuntimeSpanRow {
	service: string;
	environment: string;
	release: string | null;
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	kind: string;
	status: "ok" | "error";
	route: string | null;
	statusCode: number | null;
	durationMs: number;
	attributes: Record<string, unknown> | null;
	startedAt: Date;
}

/**
 * One LLM provider call (chat, completion, embedding, …) extracted from a
 * span carrying GenAI/Vercel-AI/Autter attributes — see llm.ts. Stored per
 * call, not rolled up: LLM traffic is orders of magnitude smaller than
 * HTTP, and spend analysis needs every call. Tokens and cost are resolved
 * at ingest so usage/spend queries are plain aggregates.
 */
export interface RuntimeLlmCall {
	service: string;
	environment: string;
	release: string | null;
	traceId: string;
	spanId: string;
	/** gen_ai.provider.name / gen_ai.system / ai.model.provider — "openai", … */
	provider: string;
	model: string;
	/** gen_ai.operation.name — "chat", "embeddings", "generateText", … */
	operation: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	/** reported = SDK sent the exact cost; estimated = built-in pricing table. */
	costSource: "reported" | "estimated" | "none";
	durationMs: number;
	status: "ok" | "error";
	/** Provider exception type for failed calls ("RateLimitError", …); "" when ok. */
	errorType: string;
	/** Opaque end-user id for per-user usage/cost attribution. */
	userId: string;
	sessionId: string;
	attributes: Record<string, string> | null;
	startedAt: Date;
}

/** One 60-second usage rollup bucket. */
export interface RuntimeMetricPoint {
	service: string;
	environment: string;
	release: string | null;
	route: string;
	bucketAt: Date;
	requestCount: number;
	errorCount: number;
	durationSumMs: number;
	sessionCount: number;
}

/**
 * The tenant a validated ingest key resolves to.
 *
 * Key scopes:
 * - `server` — secret key for backends: all endpoints (OTLP + browser relay).
 * - `client` — PUBLISHABLE key shipped in frontend bundles: `/v1/browser`
 *   only, origin allow-list enforced, stricter rate limit. Leaking it can
 *   at worst send fake browser errors for one repo — never read anything.
 */
export interface IngestContext {
	orgId: string;
	repositoryId: string;
	scope: "client" | "server";
	/** client keys only: exact origins allowed to send (empty = any). */
	allowedOrigins: string[];
}
