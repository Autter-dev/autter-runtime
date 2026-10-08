import type { RuntimeEvent } from "./record.js";

/** One OTLP/HTTP JSON log record, as runtime-node 1.4.0 encoded it. */
export interface OtlpLogRecord {
	timeUnixNano: string;
	severityNumber: number;
	severityText: string;
	body: { stringValue: string };
	attributes: Array<{ key: string; value: Record<string, unknown> }>;
	traceId?: string;
	spanId?: string;
}

export interface OtlpResource {
	service: string;
	environment: string;
	release?: string;
	/** SDK identity, sent as the `telemetry.distro.*` resource attributes. */
	distro?: { name: string; version: string };
}

const SEVERITY = { debug: 5, info: 9, warning: 13, error: 17 } as const;

/** OTLP AnyValue encoding (bounded: 64 array items, 128 keys, 32 000 chars). */
export function otlpValue(input: unknown): Record<string, unknown> {
	if (typeof input === "number") return { doubleValue: input };
	if (typeof input === "boolean") return { boolValue: input };
	if (Array.isArray(input))
		return { arrayValue: { values: input.slice(0, 64).map(otlpValue) } };
	if (input && typeof input === "object")
		return {
			kvlistValue: {
				values: Object.entries(input)
					.slice(0, 128)
					.map(([key, item]) => ({ key, value: otlpValue(item) })),
			},
		};
	return { stringValue: String(input ?? "").slice(0, 32000) };
}

/** Encode one event. Byte-compatible with runtime-node 1.4.0. */
export function toOtlpLogRecord(event: RuntimeEvent): OtlpLogRecord {
	return {
		timeUnixNano: String(BigInt(Math.trunc(event.time)) * 1_000_000n),
		severityNumber: SEVERITY[event.level],
		severityText: event.level.toUpperCase(),
		body: otlpValue(event.message) as { stringValue: string },
		attributes: Object.entries(event.attributes).map(([key, item]) => ({
			key,
			value: otlpValue(item),
		})),
		...(event.traceId
			? { traceId: event.traceId, spanId: event.spanId ?? "" }
			: {}),
	};
}

/** Wrap encoded records in an ExportLogsServiceRequest (scope "autter-runtime"). */
export function buildOtlpLogsRequest(
	resource: OtlpResource,
	records: OtlpLogRecord[],
): Record<string, unknown> {
	return {
		resourceLogs: [
			{
				resource: {
					attributes: Object.entries({
						"service.name": resource.service,
						"deployment.environment.name": resource.environment,
						...(resource.release ? { "service.version": resource.release } : {}),
						...(resource.distro
							? {
									"telemetry.distro.name": resource.distro.name,
									"telemetry.distro.version": resource.distro.version,
								}
							: {}),
					}).map(([key, item]) => ({ key, value: otlpValue(item) })),
				},
				scopeLogs: [
					{
						scope: { name: "autter-runtime" },
						logRecords: records,
					},
				],
			},
		],
	};
}
