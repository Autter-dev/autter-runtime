import { createHash } from "node:crypto";
import type { IngestContext } from "./types.js";

/**
 * What the ingester refused or dropped, per tenant, per minute, by route and
 * reason (EI-27): `runtime_ingest_drops` in ClickHouse, so the Autter
 * dashboard can say why a repository's telemetry is missing instead of
 * showing nothing.
 *
 * Four kinds of loss:
 * - `rejected`: the whole request got a non-2xx answer and nothing from it
 *   was stored (bad key, wrong key type, rate limit, invalid or oversized
 *   payload, unsupported media type, storage down). 429 and 503 are retried
 *   by OTLP exporters, so those records usually arrive later; the others
 *   are not retried.
 * - `dropped`: the request was accepted but some of its records were not
 *   stored (spans past the per-request limit, cumulative HTTP histograms,
 *   invalid browser events, …). OTLP answers carry them in `partialSuccess`.
 * - `truncated`: records were stored with some attribute values cut or left
 *   out by the attribute bounds; `records` counts the values cut.
 * - `unforwarded`: stored in ClickHouse, but the sink webhook gave up on
 *   the batch; the consumer recovers it by replaying ClickHouse.
 *
 * And two kinds of records left out on purpose (1.9.0, EI-38), counted so
 * the dashboard can explain why stored rows are fewer than records sent:
 * - `collapsed`: a looping error past its first occurrences of the minute
 *   (loop-collapse.ts); its payload was not stored, its count is, on the
 *   minute's collapsed sample (`collapsed_count`). `records` counts payloads
 *   not stored.
 * - `suppressed`: occurrences a suppression rule set by the user dropped or
 *   sampled out (suppression.ts).
 *
 * Both are recorded with `requests` 0: no request was refused, and a
 * dashboard before 1.9.0 (which reads an unknown kind as a rejection)
 * finds nothing refused in the last hour.
 *
 * Counting never slows or fails ingest: `record()` is a synchronous map
 * update, rows are written in batches every few seconds, a failed write is
 * logged and dropped (never retried), and the buffer is bounded.
 */

export type DropKind = "rejected" | "dropped" | "truncated" | "unforwarded" | "collapsed" | "suppressed";

/** Every reason, its kind, and (for rejections) the HTTP status it answers with. */
export const DROP_REASONS = {
	// ── rejected: the request got this status and nothing was stored ──
	/** No key in `Authorization`, `x-autter-key` or `?key=`. */
	missing_key: { kind: "rejected", status: 401 },
	/** Not a configured key, and the validator did not accept it (revoked, mistyped, another repository's deployment). */
	unknown_key: { kind: "rejected", status: 401 },
	/** The key validator could not answer (unreachable, timeout, 5xx) and nothing was cached. */
	key_unverified: { kind: "rejected", status: 401 },
	/** An upload key (`autter_rtu_…`) on a telemetry route. */
	upload_key_not_allowed: { kind: "rejected", status: 403 },
	/** A client key (`autter_rtc_…`) on an OTLP or source map route. */
	client_key_not_allowed: { kind: "rejected", status: 403 },
	/** A client key sent from an origin missing from its allow-list. */
	origin_not_allowed: { kind: "rejected", status: 403 },
	/** A key whose scope this ingester does not know (never yielded by KeyResolver). */
	key_scope_not_allowed: { kind: "rejected", status: 403 },
	rate_limited: { kind: "rejected", status: 429 },
	/** Malformed JSON or protobuf, a schema failure, or values the normaliser can't read. */
	invalid_payload: { kind: "rejected", status: 400 },
	/** The client went away before its body arrived. */
	request_aborted: { kind: "rejected", status: 400 },
	/** Body over MAX_BODY_BYTES (after gzip is inflated), or a source map over 32 MiB. */
	payload_too_large: { kind: "rejected", status: 413 },
	/** A content type or content encoding (zstd, br) the route does not take. */
	unsupported_media_type: { kind: "rejected", status: 415 },
	/** POST to a path the ingester does not serve (route "other"). */
	unknown_route: { kind: "rejected", status: 404 },
	internal_error: { kind: "rejected", status: 500 },
	/** A ClickHouse write failed; exporters retry. */
	storage_unavailable: { kind: "rejected", status: 503 },
	// ── dropped: accepted, but these records were not stored ──
	/** Spans past the per-request limit (5000). */
	spans_over_limit: { kind: "dropped" },
	/** Log records past the per-request limit (2000). */
	log_records_over_limit: { kind: "dropped" },
	/** Data points of cumulative `http.server.duration` / `http.server.request.duration` histograms (only delta is summable). */
	cumulative_histogram: { kind: "dropped" },
	/** Memory/GC data points with a value, timestamp or unit out of range, or without service.name / service.instance.id. */
	memory_point_invalid: { kind: "dropped" },
	/** Memory/GC data points past 5000 in one request. */
	memory_points_over_limit: { kind: "dropped" },
	/** Browser events that failed validation (unknown type, bad timestamp, oversized field). */
	invalid_event: { kind: "dropped" },
	/** Browser events past 50 in one payload. */
	events_over_limit: { kind: "dropped" },
	/** Profile samples past the first 1000. */
	profile_samples_over_limit: { kind: "dropped" },
	// ── truncated: stored, with attribute values cut ──
	attributes_truncated: { kind: "truncated" },
	// ── unforwarded: stored, but the sink webhook gave up on the batch ──
	/** The sink retry buffer overflowed, or one batch was bigger than all of it. */
	sink_overflow: { kind: "unforwarded" },
	/** The sink consumer answered a permanent 4xx. */
	sink_rejected: { kind: "unforwarded" },
	/** SINK_MAX_ATTEMPTS deliveries failed. */
	sink_gave_up: { kind: "unforwarded" },
	// ── collapsed: counted on the minute's sample, payload not stored (1.9.0) ──
	/** Occurrences of a looping error past the first LOOP_COLLAPSE_AFTER of the minute. */
	collapsed: { kind: "collapsed" },
	// ── suppressed: a suppression rule set by the user left them out (1.9.0) ──
	/** Occurrences a `drop` rule matched, or a `sample` rule sampled out. */
	suppressed: { kind: "suppressed" },
} as const satisfies Record<string, { kind: DropKind; status?: number }>;

export type DropReason = keyof typeof DROP_REASONS;

/** Routes counted by name; anything else is "other". `sink` is the webhook. */
export const DROP_ROUTES = [
	"/v1/traces",
	"/v1/logs",
	"/v1/metrics",
	"/v1/browser",
	"/v1/profiles",
	"/v1/platform-events",
	"/v1/sourcemaps",
	"/v1/sourcemaps/check",
] as const;

export type DropRoute = (typeof DROP_ROUTES)[number] | "other" | "sink";

/** The route column for a request path (Express matches case-insensitively and ignores a trailing slash). */
export function dropRoute(path: string): DropRoute {
	const normalised = path.toLowerCase().replace(/\/+$/, "");
	return (DROP_ROUTES as readonly string[]).includes(normalised) ? (normalised as DropRoute) : "other";
}

const ACCEPTED_202: ReadonlySet<DropRoute> = new Set<DropRoute>(["/v1/browser", "/v1/profiles", "/v1/platform-events", "/v1/sourcemaps"]);

/** The HTTP status a reason is recorded with. `sink` has none (0). */
export function dropStatus(reason: DropReason, route: DropRoute): number {
	const info = DROP_REASONS[reason];
	if ("status" in info) return info.status;
	if (route === "sink") return 0;
	return ACCEPTED_202.has(route) ? 202 : 200;
}

const AUTTER_KEY_RE = /^autter_rt[cu]?_[A-Za-z0-9_-]{16,256}$/;

/**
 * sha256 (hex) of a key that did not resolve, when it has an Autter key
 * prefix; "" otherwise. Autter stores the same hash for every key it issues
 * (revoked ones included), so the platform can tell a repository that a
 * revoked or rotated key is still sending, while the ingester never learns
 * whose key it was. Anything without the prefix (another vendor's token, a
 * password in the wrong field) is never hashed or stored.
 */
export function autterKeyHash(key: string): string {
	return AUTTER_KEY_RE.test(key) ? createHash("sha256").update(key).digest("hex") : "";
}

// ── records in a request body ────────────────────────────────────────────

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const field = (value: unknown, key: string): unknown =>
	value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/** Leaf counts along a JSON path of array fields: `["resourceSpans", "scopeSpans", "spans"]`. */
function countJson(root: unknown, path: readonly string[]): number {
	let level: unknown[] = [root];
	for (const key of path.slice(0, -1)) level = level.flatMap((node) => arr(field(node, key)));
	const last = path[path.length - 1]!;
	return level.reduce<number>((sum, node) => sum + arr(field(node, last)).length, 0);
}

const METRIC_KINDS = ["gauge", "sum", "histogram", "exponentialHistogram", "summary"] as const;

function countJsonDataPoints(root: unknown): number {
	let points = 0;
	for (const resource of arr(field(root, "resourceMetrics")))
		for (const scope of arr(field(resource, "scopeMetrics")))
			for (const metric of arr(field(scope, "metrics")))
				for (const kind of METRIC_KINDS) points += arr(field(field(metric, kind), "dataPoints")).length;
	return points;
}

function readVarint(buf: Uint8Array, start: number, end: number): { value: number; next: number } | null {
	let value = 0;
	let scale = 1;
	for (let pos = start; pos < end && pos < start + 10; pos++) {
		const byte = buf[pos]!;
		value += (byte & 0x7f) * scale;
		if (byte < 0x80) return { value, next: pos + 1 };
		scale *= 128;
	}
	return null;
}

/**
 * Count the length-delimited fields at a nested path of field numbers
 * (one set per level) without decoding the message: tags are read and
 * everything else is skipped by length. O(body size); null when the bytes
 * are not a well-formed message.
 */
export function countProtoPath(buf: Uint8Array, path: readonly (readonly number[])[]): number | null {
	let count = 0;
	const scan = (start: number, end: number, depth: number): boolean => {
		let pos = start;
		while (pos < end) {
			const tag = readVarint(buf, pos, end);
			if (!tag) return false;
			pos = tag.next;
			const wire = tag.value % 8;
			const number = Math.floor(tag.value / 8);
			if (wire === 0) {
				const skipped = readVarint(buf, pos, end);
				if (!skipped) return false;
				pos = skipped.next;
			} else if (wire === 1) {
				pos += 8;
			} else if (wire === 5) {
				pos += 4;
			} else if (wire === 2) {
				const length = readVarint(buf, pos, end);
				if (!length) return false;
				const stop = length.next + length.value;
				if (stop > end) return false;
				if (path[depth]!.includes(number)) {
					if (depth === path.length - 1) count += 1;
					else if (!scan(length.next, stop, depth + 1)) return false;
				}
				pos = stop;
			} else {
				return false;
			}
			if (pos > end) return false;
		}
		return true;
	};
	return scan(0, buf.length, 0) ? count : null;
}

// ExportTraceServiceRequest.resource_spans(1) → ScopeSpans.scope_spans(2) → spans(2), …
const PROTO_SPANS = [[1], [2], [2]] as const;
const PROTO_LOG_RECORDS = [[1], [2], [2]] as const;
// … → Metric.gauge(5) | sum(7) | histogram(9) | exponential_histogram(10) | summary(11) → data_points(1)
const PROTO_DATA_POINTS = [[1], [2], [2], [5, 7, 9, 10, 11], [1]] as const;

/**
 * Records (spans, log records, data points, browser events) in a request
 * body that was refused, where they can be known: 0 for a body never read
 * (413, a bad encoding) or not understood. Profiles count samples, which a
 * refused profile never had decoded, so 0; a source map upload or platform
 * event is one record; a source map check carries none.
 */
export function recordsInBody(route: DropRoute, body: unknown, protobuf: boolean): number {
	try {
		if (route === "/v1/platform-events" || route === "/v1/sourcemaps") return 1;
		if (protobuf && Buffer.isBuffer(body)) {
			const path =
				route === "/v1/traces" ? PROTO_SPANS
				: route === "/v1/logs" ? PROTO_LOG_RECORDS
				: route === "/v1/metrics" ? PROTO_DATA_POINTS
				: null;
			return path ? (countProtoPath(body, path) ?? 0) : 0;
		}
		switch (route) {
			case "/v1/traces":
				return countJson(body, ["resourceSpans", "scopeSpans", "spans"]);
			case "/v1/logs":
				return countJson(body, ["resourceLogs", "scopeLogs", "logRecords"]);
			case "/v1/metrics":
				return countJsonDataPoints(body);
			case "/v1/browser": {
				// Direct browser beacons arrive as text/plain.
				const parsed: unknown = typeof body === "string" ? JSON.parse(body) : body;
				return arr(field(parsed, "events")).length;
			}
			default:
				return 0;
		}
	} catch {
		return 0;
	}
}

/** Spans in an OTLP traces request (JSON-shaped, as decoded). */
export function spansInRequest(request: unknown): number {
	return countJson(request, ["resourceSpans", "scopeSpans", "spans"]);
}

/** Data points in an OTLP metrics request (JSON-shaped, as decoded). */
export function dataPointsInRequest(request: unknown): number {
	return countJsonDataPoints(request);
}

/**
 * Data points of cumulative HTTP server duration histograms: the request
 * rollups (normalizeMetrics) and the latency table (normalizeLatencyHistograms)
 * both skip them, since cumulative points repeat lifetime totals on every
 * export. Mirrors normalizeMetrics' check; keep the two in step.
 */
export function cumulativeHttpHistogramPoints(request: unknown): number {
	let points = 0;
	for (const resource of arr(field(request, "resourceMetrics")))
		for (const scope of arr(field(resource, "scopeMetrics")))
			for (const metric of arr(field(scope, "metrics"))) {
				const name = field(metric, "name");
				if (name !== "http.server.duration" && name !== "http.server.request.duration") continue;
				const histogram = field(metric, "histogram");
				const temporality = field(histogram, "aggregationTemporality");
				if (temporality !== 2 && temporality !== "AGGREGATION_TEMPORALITY_CUMULATIVE") continue;
				points += arr(field(histogram, "dataPoints")).length;
			}
	return points;
}

// ── OTLP partial success ──────────────────────────────────────────────────

/** What an accepted OTLP request did not store, for its `partial_success`. */
export interface PartialSuccess {
	/** rejected_spans / rejected_log_records / rejected_data_points. */
	rejected: number;
	errorMessage: string;
}

/** Merge per-reason rejections into one partial success; null when nothing was rejected. */
export function partialSuccess(parts: Array<{ rejected: number; message: string }>): PartialSuccess | null {
	const kept = parts.filter((part) => part.rejected > 0);
	if (kept.length === 0) return null;
	return {
		rejected: kept.reduce((sum, part) => sum + part.rejected, 0),
		errorMessage: kept.map((part) => part.message).join(" "),
	};
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const PARTIAL_MESSAGES = {
	spans: (rejected: number, limit: number) =>
		`${plural(rejected, "span")} rejected: one request takes at most ${limit} spans; send smaller batches (OTel Collector: batch processor send_batch_max_size).`,
	logRecords: (rejected: number, limit: number) =>
		`${plural(rejected, "log record")} rejected: one request takes at most ${limit} log records; send smaller batches (OTel Collector: batch processor send_batch_max_size).`,
	cumulative: (rejected: number) =>
		`${plural(rejected, "data point")} of cumulative http.server.duration / http.server.request.duration histograms rejected: request counts need delta temporality (OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta); without it they come from server spans.`,
	memoryInvalid: (rejected: number) =>
		`${plural(rejected, "memory data point")} rejected: the resource needs service.name and service.instance.id, and each point a value, timestamp (at most 30 days old, 5 minutes ahead) and byte unit in range.`,
	memoryOverLimit: (rejected: number, limit: number) =>
		`${plural(rejected, "memory data point")} rejected: one request takes at most ${limit}.`,
} as const;

// ── the counter ───────────────────────────────────────────────────────────

/** A drop as recorded by the request path. */
export interface IngestDrop {
	/** Who sent it; null when the key did not resolve (or there was none). */
	tenant: Pick<IngestContext, "orgId" | "repositoryId"> | null;
	route: DropRoute;
	reason: DropReason;
	/** Requests (or sink batches); default 1. */
	requests?: number;
	/** Records lost (values cut, for `attributes_truncated`); default 0. */
	records?: number;
	/** The response status, when it differs from the reason's own. */
	status?: number;
	/** Null tenant only: autterKeyHash() of the key that did not resolve. */
	keyHash?: string;
}

/** One `runtime_ingest_drops` row: a tenant, minute, route and reason. */
export interface IngestDropRow {
	orgId: string;
	repositoryId: string;
	minute: Date;
	route: DropRoute;
	reason: DropReason;
	kind: DropKind;
	status: number;
	keyHash: string;
	requests: number;
	records: number;
}

export interface IngestDropCounterOptions {
	/** How often buffered rows are written. Default 5 s. */
	flushIntervalMs?: number;
	/** Distinct rows buffered between writes; past it, new rows are not counted (and logged). Default 10 000. */
	maxRows?: number;
	/** Distinct key hashes buffered between writes; past it, a new one is counted with no hash. Default 1000. */
	maxKeyHashes?: number;
	/** A write that has not settled after this long counts as failed, so counting goes on. Default 30 s. */
	writeTimeoutMs?: number;
	/** False when there is no ClickHouse: nothing is buffered. */
	enabled?: boolean;
	now?: () => number;
	log?: (message: string) => void;
}

export interface IngestDropCounterStats {
	/** Rows waiting for the next write. */
	buffered: number;
	/** Rows written since start. */
	written: number;
	/** Writes that failed (their rows were dropped). */
	failedWrites: number;
	/** Rows dropped with a failed write. */
	discardedRows: number;
	/** Requests not counted because the buffer was full. */
	overflowRequests: number;
}

export class IngestDropCounter {
	private rows = new Map<string, IngestDropRow>();
	private keyHashes = new Set<string>();
	private overflowRequests = 0;
	private overflowSinceLog = 0;
	private inFlight: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private written = 0;
	private failedWrites = 0;
	private discardedRows = 0;
	private lastErrorLog = Number.NEGATIVE_INFINITY;
	private readonly flushIntervalMs: number;
	private readonly maxRows: number;
	private readonly maxKeyHashes: number;
	private readonly writeTimeoutMs: number;
	private readonly enabled: boolean;
	private readonly now: () => number;
	private readonly log: (message: string) => void;

	constructor(
		private readonly write: (rows: IngestDropRow[]) => Promise<void>,
		options: IngestDropCounterOptions = {},
	) {
		this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
		this.maxRows = options.maxRows ?? 10_000;
		this.maxKeyHashes = options.maxKeyHashes ?? 1_000;
		this.writeTimeoutMs = options.writeTimeoutMs ?? 30_000;
		this.enabled = options.enabled ?? true;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? ((message) => console.warn(message));
	}

	/** Count a drop. Synchronous and O(1); never throws. */
	record(drop: IngestDrop): void {
		if (!this.enabled) return;
		try {
			const requests = Math.max(0, Math.round(drop.requests ?? 1));
			const records = Math.max(0, Math.round(drop.records ?? 0));
			if (requests === 0 && records === 0) return;
			const tenant = drop.tenant;
			let keyHash = tenant ? "" : (drop.keyHash ?? "");
			if (keyHash && !this.keyHashes.has(keyHash) && this.keyHashes.size >= this.maxKeyHashes) keyHash = "";
			const minuteMs = Math.floor(this.now() / 60_000) * 60_000;
			const status = drop.status ?? dropStatus(drop.reason, drop.route);
			const orgId = tenant?.orgId ?? "";
			const repositoryId = tenant?.repositoryId ?? "";
			const key = [orgId, repositoryId, minuteMs, drop.route, drop.reason, status, keyHash].join("\u0000");
			const existing = this.rows.get(key);
			if (existing) {
				existing.requests += requests;
				existing.records += records;
				return;
			}
			if (this.rows.size >= this.maxRows) {
				this.overflowRequests += requests;
				this.overflowSinceLog += requests;
				return;
			}
			if (keyHash) this.keyHashes.add(keyHash);
			this.rows.set(key, {
				orgId,
				repositoryId,
				minute: new Date(minuteMs),
				route: drop.route,
				reason: drop.reason,
				kind: DROP_REASONS[drop.reason].kind,
				status,
				keyHash,
				requests,
				records,
			});
		} catch {
			// Counting must never fail ingest.
		}
	}

	/** Write buffered rows every flushIntervalMs (unref'd: never keeps the process alive). */
	start(): void {
		if (!this.enabled || this.timer) return;
		this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
		this.timer.unref?.();
	}

	/** Stop the timer and write what is buffered (shutdown). */
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.flush();
	}

	/**
	 * Write the buffered rows once. One write at a time: while one is in
	 * flight, rows keep accumulating (bounded) for the next. A failed or
	 * stalled write is logged and its rows dropped, never retried. Never
	 * rejects.
	 */
	flush(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		if (this.overflowSinceLog > 0) {
			this.log(`ingest drop counter full: ${this.overflowSinceLog} request(s) not counted since the last write`);
			this.overflowSinceLog = 0;
		}
		if (this.rows.size === 0) return Promise.resolve();
		const batch = [...this.rows.values()];
		this.rows = new Map();
		this.keyHashes = new Set();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const stalled = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error(`write did not settle in ${this.writeTimeoutMs} ms`)), this.writeTimeoutMs);
			timeout.unref?.();
		});
		let written: Promise<void>;
		try {
			written = this.write(batch);
		} catch (err) {
			written = Promise.reject(err);
		}
		this.inFlight = Promise.race([written, stalled])
			.then(() => {
				this.written += batch.length;
			})
			.catch((err) => {
				this.failedWrites += 1;
				this.discardedRows += batch.length;
				// One line a minute at most: a missing table or a ClickHouse
				// outage must not flood the logs every few seconds.
				if (this.now() - this.lastErrorLog >= 60_000) {
					this.lastErrorLog = this.now();
					this.log(`ingest drop counts not written (${batch.length} row(s) dropped): ${(err as Error)?.message ?? err}`);
				}
			})
			.finally(() => {
				clearTimeout(timeout);
				this.inFlight = null;
			});
		return this.inFlight;
	}

	stats(): IngestDropCounterStats {
		return {
			buffered: this.rows.size,
			written: this.written,
			failedWrites: this.failedWrites,
			discardedRows: this.discardedRows,
			overflowRequests: this.overflowRequests,
		};
	}
}

/**
 * Migration 0018 / baseline. A SummingMergeTree: readers `sum(requests)`,
 * `sum(records)` and GROUP BY, since rows of one key collapse at merge time,
 * eventually. `org_id = '' AND repository_id = ''` is the null tenant: keys
 * that did not resolve (401), with `key_hash` set for Autter-format keys.
 * `status` is the HTTP status answered (2xx for drops inside accepted
 * requests, 0 for the sink).
 */
export function ingestDropsTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_ingest_drops (
		org_id String, repository_id String,
		minute DateTime('UTC'),
		route LowCardinality(String), reason LowCardinality(String),
		kind LowCardinality(String), status UInt16,
		key_hash String DEFAULT '',
		requests UInt64, records UInt64
	) ENGINE = SummingMergeTree((requests, records))
	PARTITION BY toYYYYMM(minute)
	ORDER BY (org_id, repository_id, minute, route, reason, kind, status, key_hash)
	TTL minute + INTERVAL 30 DAY`;
}
