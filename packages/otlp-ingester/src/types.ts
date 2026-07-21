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
}

/**
 * Derived, aggregation-ready fields — computed once at ingest (from the
 * same normalisers the fingerprint uses) and stored as their own columns
 * so later aggregations never have to re-parse stacks or routes in SQL.
 */
export interface RuntimeOccurrence extends RuntimeOccurrenceInput {
	occurrenceId: string;
	fingerprint: string;
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
