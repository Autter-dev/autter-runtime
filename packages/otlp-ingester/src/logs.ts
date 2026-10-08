import { createHash } from "node:crypto";
import {
	decodeOtlpAttributes,
	sanitizeRuntimeContext,
	type OtlpAttribute,
	type OtlpValue,
} from "./context.js";
import { normalizeRoute } from "./fingerprint.js";

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
					service: String(info["service.name"] ?? "unknown").slice(0, 200),
					environment: String(
						info["deployment.environment.name"] ??
							info["deployment.environment"] ??
							"production",
					).slice(0, 100),
					release: String(info["service.version"] ?? "").slice(0, 200),
					traceId,
					spanId,
					operationId,
					operation: String(attributes["autter.operation.name"] ?? "").slice(
						0,
						200,
					),
					type:
						attributes["autter.event.type"] === "operation"
							? "operation"
							: "log",
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
				});
			}
		}
	}
	return rows;
}

export function logTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_logs (
		org_id String, repository_id String, event_id String,
		service LowCardinality(String), environment LowCardinality(String), release String DEFAULT '',
		trace_id String DEFAULT '', span_id String DEFAULT '', operation_id String DEFAULT '',
		operation String DEFAULT '', event_type LowCardinality(String) DEFAULT 'log',
		severity LowCardinality(String) DEFAULT 'info', message String CODEC(ZSTD(1)),
		outcome LowCardinality(String) DEFAULT '', duration_ms Float64 DEFAULT 0,
		attributes String DEFAULT '{}' CODEC(ZSTD(1)), occurred_at DateTime64(3, 'UTC'),
		ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
	) ENGINE = ReplacingMergeTree PARTITION BY toDate(occurred_at)
	ORDER BY (org_id, repository_id, occurred_at, event_id)
	TTL toDateTime(occurred_at) + INTERVAL 14 DAY`;
}
