import { createHash } from "node:crypto";
import {
	decodeOtlpAttributes,
	sanitizeRuntimeContext,
	type OtlpAttribute,
	type OtlpValue,
} from "./context.js";
import { declaredLink, liftErrorFields } from "./error-fields.js";
import { normalizeRoute } from "./fingerprint.js";
import type { RuntimeOccurrenceInput } from "./types.js";

export interface RuntimeLogRecord {
	id: string;
	service: string;
	environment: string;
	release: string;
	traceId: string;
	spanId: string;
	operationId: string;
	operation: string;
	type: "log" | "operation";
	severity: string;
	message: string;
	outcome: string;
	durationMs: number;
	attributes: Record<string, unknown>;
	occurredAt: Date;
	/**
	 * Lifted wide-event columns (migration 0012). `kind` is "request" for
	 * request summaries, "operation" for operation summaries (including
	 * pre-1.5.0 SDKs that never sent `autter.operation.kind`), "" for plain
	 * log records. The rest default to ""/0 when the record doesn't carry them.
	 */
	kind: "" | "request" | "operation";
	requestId: string;
	/** `http.route`, query-stripped and id-normalised. */
	route: string;
	statusCode: number;
	/** `autter.error.code`, only when it matches CODE_PATTERN. */
	errorCode: string;
	aiCostUsd: number;
	aiCalls: number;
	/**
	 * Not persisted on runtime_logs. Set for logger-only/edge error records
	 * (`autter.capture.mode = "log"`, severity ≥ error, `exception.*`
	 * present): the occurrence /v1/logs promotes into issue grouping —
	 * see log-promotion.ts.
	 */
	occurrence?: RuntimeOccurrenceInput;
}
export interface OtlpLogsRequest {
	resourceLogs?: Array<{
		resource?: { attributes?: OtlpAttribute[] };
		scopeLogs?: Array<{
			scope?: { name?: string };
			logRecords?: Array<{
				timeUnixNano?: string | number;
				observedTimeUnixNano?: string | number;
				severityNumber?: number;
				severityText?: string;
				traceId?: string;
				spanId?: string;
				body?: OtlpValue;
				attributes?: OtlpAttribute[];
			}>;
		}>;
	}>;
}

export function normalizeLogs(request: OtlpLogsRequest): RuntimeLogRecord[] {
	if (!request || !Array.isArray(request.resourceLogs))
		throw new Error("resourceLogs must be an array");
	const rows: RuntimeLogRecord[] = [];
	if (request.resourceLogs.length > 128)
		throw new Error("too many log resources");
	for (const resource of request.resourceLogs) {
		if (
			!resource ||
			(resource.scopeLogs && !Array.isArray(resource.scopeLogs)) ||
			(resource.scopeLogs?.length ?? 0) > 128
		)
			throw new Error("invalid log scopes");
		const info = decodeOtlpAttributes(resource.resource?.attributes);
		for (const scope of resource.scopeLogs ?? []) {
			if (!scope || (scope.logRecords && !Array.isArray(scope.logRecords)))
				throw new Error("invalid log records");
			for (const record of scope.logRecords ?? []) {
				if (!record || typeof record !== "object")
					throw new Error("invalid log record");
				if (rows.length >= 2000) throw new Error("too many log records");
				const attrs = decodeOtlpAttributes(record.attributes);
				let event: Record<string, unknown> = {};
				const decodedBody = decodeOtlpAttributes([
					{ key: "event", value: record.body },
				]).event;
				const body =
					typeof decodedBody === "string"
						? decodedBody
						: decodedBody == null
							? ""
							: JSON.stringify(decodedBody);
				if (
					decodedBody &&
					typeof decodedBody === "object" &&
					!Array.isArray(decodedBody)
				)
					event = sanitizeRuntimeContext(decodedBody);
				const metadata = Object.fromEntries(
					Object.entries(attrs).filter(([key]) =>
						/^autter\.(?:operation|event)\./.test(key),
					),
				);
				const attributes = sanitizeRuntimeContext({
					...metadata,
					...event,
					...attrs,
				});
				const nanos = record.timeUnixNano ?? record.observedTimeUnixNano;
				const occurredAt =
					nanos === undefined
						? new Date()
						: new Date(Number(BigInt(String(nanos)) / 1_000_000n));
				if (!Number.isFinite(occurredAt.getTime()))
					throw new Error("invalid log timestamp");
				const number = Number(record.severityNumber ?? 9);
				const text = String(
					record.severityText ?? event.level ?? "",
				).toLowerCase();
				const severity =
					number >= 21 || text === "fatal"
						? "fatal"
						: number >= 17 || text === "error"
							? "error"
							: number >= 13 || /warn/.test(text)
								? "warning"
								: number < 9 || text === "debug"
									? "debug"
									: "info";
				const errorMessage =
					event.error && typeof event.error === "object"
						? (event.error as Record<string, unknown>).message
						: event.error;
				const message = String(
					sanitizeRuntimeContext({
						message: event.message ?? errorMessage ?? body,
					}).message ?? "",
				).slice(0, 4000);
				const operationId = String(
					attributes["autter.operation.id"] ?? "",
				).slice(0, 128);
				const traceId = /^[a-f0-9]{32}$/i.test(record.traceId ?? "")
					? record.traceId!.toLowerCase().replace(/^0+$/, "")
					: "";
				const spanId = /^[a-f0-9]{16}$/i.test(record.spanId ?? "")
					? record.spanId!.toLowerCase().replace(/^0+$/, "")
					: "";
				if (typeof attributes.path === "string")
					attributes.path = normalizeRoute(attributes.path.split(/[?#]/)[0]!);
				const service = String(info["service.name"] ?? "unknown").slice(0, 200);
				const environment = String(
					info["deployment.environment.name"] ??
						info["deployment.environment"] ??
						"production",
				).slice(0, 100);
				const release = String(info["service.version"] ?? "").slice(0, 200);
				const declared = liftErrorFields(attributes);
				// The sanitiser strips URL fragments; the declared docs link keeps
				// its #anchor from the raw attribute (still validated).
				const rawLink = declaredLink(
					record.attributes?.find((a) => a?.key === "autter.error.link")
						?.value?.stringValue,
				);
				if (rawLink) declared.link = rawLink;
				const rawRoute =
					typeof attributes["http.route"] === "string"
						? attributes["http.route"].split(/[?#]/)[0]!
						: "";
				const route = normalizeRoute(rawRoute).slice(0, 500);
				const status = Number(attributes["http.response.status_code"]);
				const statusCode =
					Number.isInteger(status) && status > 0 && status < 1000 ? status : 0;
				const declaredKind = attributes["autter.operation.kind"];
				const type =
					attributes["autter.event.type"] === "operation" ? "operation" : "log";
				const ai = attributes["autter.operation.ai"];
				const aiRollup =
					ai && typeof ai === "object" && !Array.isArray(ai)
						? (ai as Record<string, unknown>)
						: {};
				const occurrence =
					attributes["autter.capture.mode"] === "log" &&
					(severity === "error" || severity === "fatal") &&
					hasException(attributes)
						? {
								source: "server" as const,
								severity: severity as "error" | "fatal",
								service,
								environment,
								release: release || null,
								errorType: String(attributes["exception.type"] || "Error").slice(0, 200),
								message: String(attributes["exception.message"] || message || "Unknown error").slice(0, 4000),
								stack:
									typeof attributes["exception.stacktrace"] === "string"
										? attributes["exception.stacktrace"]
										: null,
								route: rawRoute || stringOrNull(attributes["url.path"]),
								method:
									typeof attributes["http.request.method"] === "string"
										? attributes["http.request.method"].toUpperCase().slice(0, 16)
										: null,
								statusCode: statusCode || null,
								traceId: traceId || null,
								sessionId: null,
								attributes,
								occurredAt,
								...declared,
							}
						: undefined;
				rows.push({
					id: createHash("sha256")
						.update(
							JSON.stringify([
								info,
								nanos,
								traceId,
								spanId,
								severity,
								attributes,
								message,
							]),
						)
						.digest("hex")
						.slice(0, 32),
					service,
					environment,
					release,
					traceId,
					spanId,
					operationId,
					operation: String(attributes["autter.operation.name"] ?? "").slice(
						0,
						200,
					),
					type,
					severity,
					message,
					outcome: String(attributes["autter.operation.outcome"] ?? "").slice(
						0,
						30,
					),
					durationMs: Math.max(
						0,
						Number(attributes["autter.operation.duration_ms"]) || 0,
					),
					attributes,
					occurredAt,
					kind:
						declaredKind === "request" || declaredKind === "operation"
							? declaredKind
							: type === "operation"
								? "operation"
								: "",
					requestId: declared.requestId ?? "",
					route,
					statusCode,
					errorCode: declared.errorCode ?? "",
					aiCostUsd: nonNegative(
						attributes["autter.operation.ai.cost_usd"] ?? aiRollup.cost_usd,
					),
					aiCalls: Math.min(
						4_294_967_295,
						Math.round(
							nonNegative(attributes["autter.operation.ai.calls"] ?? aiRollup.calls),
						),
					),
					...(occurrence ? { occurrence } : {}),
				});
			}
		}
	}
	return rows;
}

function hasException(attributes: Record<string, unknown>): boolean {
	return ["exception.type", "exception.message", "exception.stacktrace"].some(
		(key) => typeof attributes[key] === "string" && attributes[key] !== "",
	);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value ? value.split(/[?#]/)[0]! : null;
}

function nonNegative(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Baseline for fresh databases. The 0012 columns and request-id skip index
 * are included so a fresh DB matches a migrated one. `ttlDays` is
 * LOG_TTL_DAYS; existing tables are brought in line at boot
 * (ClickHouseStore.applyLogTtl), not here.
 */
export function logTableDDL(db: string, ttlDays = 14): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_logs (
		org_id String, repository_id String, event_id String,
		service LowCardinality(String), environment LowCardinality(String), release String DEFAULT '',
		trace_id String DEFAULT '', span_id String DEFAULT '', operation_id String DEFAULT '',
		operation String DEFAULT '', event_type LowCardinality(String) DEFAULT 'log',
		severity LowCardinality(String) DEFAULT 'info', message String CODEC(ZSTD(1)),
		outcome LowCardinality(String) DEFAULT '', duration_ms Float64 DEFAULT 0,
		attributes String DEFAULT '{}' CODEC(ZSTD(1)), occurred_at DateTime64(3, 'UTC'),
		ingested_at DateTime64(3, 'UTC') DEFAULT now64(3),
		${LOG_REQUEST_COLUMNS.map((column) => column.ddl).join(", ")},
		${LOG_REQUEST_ID_INDEX}
	) ENGINE = ReplacingMergeTree PARTITION BY toDate(occurred_at)
	ORDER BY (org_id, repository_id, occurred_at, event_id)
	TTL toDateTime(occurred_at) + INTERVAL ${ttlDays} DAY`;
}

/** Migration 0012 columns — shared by the baseline DDL and the migration. */
export const LOG_REQUEST_COLUMNS: Array<{ name: string; ddl: string }> = [
	{ name: "kind", ddl: "kind LowCardinality(String) DEFAULT ''" },
	{ name: "request_id", ddl: "request_id String DEFAULT ''" },
	{ name: "route", ddl: "route String DEFAULT ''" },
	{ name: "status_code", ddl: "status_code UInt16 DEFAULT 0" },
	{ name: "error_code", ddl: "error_code String DEFAULT ''" },
	{ name: "ai_cost_usd", ddl: "ai_cost_usd Float64 DEFAULT 0" },
	{ name: "ai_calls", ddl: "ai_calls UInt32 DEFAULT 0" },
];
export const LOG_REQUEST_ID_INDEX =
	"INDEX idx_logs_request_id request_id TYPE bloom_filter GRANULARITY 4";

/**
 * Per-minute request rollup (migration 0014), fed by runtime_request_1m_mv
 * from `runtime_logs` rows with kind = 'request'. Route stats read this
 * instead of scanning raw summaries:
 *   sum(request_count), sum(failed_count), sum(duration_sum_ms),
 *   quantilesMerge(0.5, 0.95)(duration_quantiles)
 */
export function requestRollupTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_request_1m (
		org_id String, repository_id String,
		service LowCardinality(String), environment LowCardinality(String),
		route String, method LowCardinality(String), bucket_at DateTime('UTC'),
		request_count SimpleAggregateFunction(sum, UInt64),
		failed_count SimpleAggregateFunction(sum, UInt64),
		duration_sum_ms SimpleAggregateFunction(sum, Float64),
		duration_quantiles AggregateFunction(quantiles(0.5, 0.95), Float64)
	) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(bucket_at)
	ORDER BY (org_id, repository_id, service, environment, route, method, bucket_at)
	TTL bucket_at + INTERVAL 90 DAY`;
}

/**
 * The view only sees rows inserted AFTER it exists (no backfill) and is
 * created by migration 0014 only — not the baseline — because it reads the
 * 0012 columns, which an existing runtime_logs table lacks until migrations
 * run. runtime_logs is a ReplacingMergeTree keyed by a content-derived
 * event_id, so a retried batch collapses there on merge — but the view
 * aggregates every INSERT, so retries can count a summary twice. The
 * rollup is therefore approximate under exporter retries (rare: a retry
 * needs a 503 or a lost 2xx); exact per-request answers come from
 * runtime_logs itself. `method` is read from the attributes JSON since
 * runtime_logs has no method column.
 */
export function requestRollupViewDDL(db: string): string {
	return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${db}.runtime_request_1m_mv
	TO ${db}.runtime_request_1m AS
	SELECT
		org_id, repository_id, service, environment, route,
		upper(JSONExtractString(attributes, 'http.request.method')) AS method,
		toDateTime(toStartOfMinute(occurred_at), 'UTC') AS bucket_at,
		count() AS request_count,
		countIf(outcome = 'failed') AS failed_count,
		sum(duration_ms) AS duration_sum_ms,
		quantilesState(0.5, 0.95)(duration_ms) AS duration_quantiles
	FROM ${db}.runtime_logs
	WHERE kind = 'request'
	GROUP BY org_id, repository_id, service, environment, route, method, bucket_at`;
}
