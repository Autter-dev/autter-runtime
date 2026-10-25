import type { Breadcrumb } from "./breadcrumbs.js";
import type { LatencySamples } from "./latency.js";
import type { SuppressionRule } from "./suppression.js";

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
	 * SDK fingerprint override (browser `fingerprint`, OTLP/log
	 * `autter.fingerprint`): ≤10 scrubbed values, each ≤200 chars. Hashed into
	 * the `manual-v1` candidate by `manualFingerprint` (fingerprint-override.ts).
	 * Omitted when absent.
	 */
	fingerprintOverride?: string[];
	/** Steps before the error, oldest first, ≤ 30 (validated by breadcrumbs.ts). */
	breadcrumbs?: Breadcrumb[];
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
	/**
	 * Loop collapse (1.9.0, loop-collapse.ts): the minute's collapsed sample
	 * stands for itself plus this many identical occurrences whose payloads
	 * were not stored. Stored as `collapsed_count`, sent to the sink as
	 * `count` (1 + collapsedCount). Absent (0) on every other occurrence.
	 */
	collapsedCount?: number;
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
	/**
	 * Latency samples behind `durationSumMs` (IP-02, latency.ts), written to
	 * `runtime_route_latency_1m`. Absent when the feed has no durations
	 * (errors outside requests, browser usage counters). Not forwarded to
	 * the sink.
	 */
	latency?: LatencySamples;
}

/**
 * The tenant a validated ingest key resolves to.
 *
 * Key scopes:
 * - `server` — secret key for backends: all endpoints (OTLP + browser relay).
 * - `client` — PUBLISHABLE key shipped in frontend bundles: `/v1/browser`
 *   only, origin allow-list enforced, stricter rate limit. Leaking it can
 *   at worst send fake browser errors for one repo — never read anything.
 * - `upload` — CI key (`autter_rtu_…`, 1.7.0+): `/v1/sourcemaps` and
 *   `/v1/sourcemaps/check` only; every telemetry route answers 403. Leaking
 *   it can at worst upload source maps for one repo.
 */
export type IngestKeyScope = "client" | "server" | "upload";

export interface IngestContext {
	orgId: string;
	repositoryId: string;
	scope: IngestKeyScope;
	/** client keys only: exact origins allowed to send (empty = any). */
	allowedOrigins: string[];
	/**
	 * Suppression rules set by the user for this repository (1.9.0): from the
	 * key validator's `suppression` answer (cached with the key, 60 s) or a
	 * static key's `suppression` entry. Absent or empty: nothing suppressed.
	 */
	suppression?: SuppressionRule[];
}
