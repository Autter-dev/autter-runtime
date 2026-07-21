export type RuntimeSource = "browser" | "server";

/** A normalised error event, before fingerprinting. */
export interface RuntimeOccurrenceInput {
	source: RuntimeSource;
	service: string;
	environment: string;
	release: string | null;
	errorType: string;
	message: string;
	stack: string | null;
	/** Path only — never a full URL with query params. */
	route: string | null;
	statusCode: number | null;
	traceId: string | null;
	sessionId: string | null;
	attributes: Record<string, unknown> | null;
	occurredAt: Date;
}

export interface RuntimeOccurrence extends RuntimeOccurrenceInput {
	occurrenceId: string;
	fingerprint: string;
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
