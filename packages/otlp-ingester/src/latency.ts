import { createHash } from "node:crypto";
import { normalizeRoute } from "./fingerprint.js";
import type { OtlpMetricsRequest } from "./normalize-otlp.js";

export interface LatencyHistogram {
	pointId: string;
	service: string;
	environment: string;
	release: string;
	method: string;
	route: string;
	bucketAt: Date;
	requestCount: number;
	errorCount: number;
	durationSumMs: number;
	boundsMs: number[];
	counts: number[];
}

export function latencyTableDDL(database: string, ttlDays = 30): string {
	return `CREATE TABLE IF NOT EXISTS ${database}.runtime_latency_histograms (
		org_id String, repository_id String, point_id String,
		service LowCardinality(String), environment LowCardinality(String),
		release String, method LowCardinality(String), route String,
		bucket_at DateTime('UTC'), request_count UInt64, error_count UInt64,
		duration_sum_ms Float64, bounds_ms Array(Float64), counts Array(UInt64)
	) ENGINE = ReplacingMergeTree
	PARTITION BY toDate(bucket_at)
	ORDER BY (org_id, repository_id, service, environment, bucket_at, point_id)
	TTL bucket_at + INTERVAL ${Math.max(1, Math.round(ttlDays))} DAY`;
}

export function normalizeLatencyHistograms(request: OtlpMetricsRequest): LatencyHistogram[] {
	const points: LatencyHistogram[] = [];
	for (const resource of request.resourceMetrics ?? []) {
		const hasStableDuration = resource.scopeMetrics?.some((scope) => scope.metrics?.some((metric) => metric.name === "http.server.request.duration"));
		const resourceAttributes = Object.fromEntries((resource.resource?.attributes ?? [])
			.map((attribute) => [attribute.key ?? "", attribute.value?.stringValue ?? ""]));
		for (const scope of resource.scopeMetrics ?? []) {
			for (const metric of scope.metrics ?? []) {
				if (hasStableDuration && metric.name === "http.server.duration") continue;
				const multiplier = metric.name === "http.server.request.duration" ? 1000
					: metric.name === "http.server.duration" ? 1 : null;
				if (multiplier === null || ![1, "1", "AGGREGATION_TEMPORALITY_DELTA"].includes(metric.histogram?.aggregationTemporality ?? "")) continue;
				for (const point of metric.histogram?.dataPoints ?? []) {
					const bounds = point.explicitBounds ?? [];
					const counts = (point.bucketCounts ?? []).map(Number);
					const count = Number(point.count);
					const endMs = Number(point.timeUnixNano) / 1e6;
					const startMs = Number(point.startTimeUnixNano) / 1e6;
					if (!Number.isSafeInteger(count) || count <= 0 || !Number.isFinite(endMs)
						|| !Number.isFinite(startMs) || endMs <= startMs || endMs - startMs > 120_000
						|| !Number.isFinite(point.sum) || Number(point.sum) < 0
						|| bounds.length === 0 || bounds.length > 256 || counts.length !== bounds.length + 1
						|| bounds.some((bound, index) => !Number.isFinite(bound) || bound < 0 || (index > 0 && bound <= bounds[index - 1]!))
						|| counts.some((value) => !Number.isSafeInteger(value) || value < 0)
						|| counts.reduce((total, value) => total + value, 0) !== count) continue;
					const attrs = Object.fromEntries((point.attributes ?? []).map((attribute) => [attribute.key ?? "",
						String(attribute.value?.stringValue ?? attribute.value?.intValue ?? "")]));
					const route = normalizeRoute(attrs["http.route"] ?? "");
					const method = attrs["http.request.method"] ?? attrs["http.method"] ?? "";
					if (!route || !method) continue;
					const status = Number(attrs["http.response.status_code"] ?? attrs["http.status_code"]);
					points.push({
						pointId: createHash("sha256").update(JSON.stringify([metric.name,
							Object.entries(resourceAttributes).sort(), Object.entries(attrs).sort(),
							String(point.startTimeUnixNano), String(point.timeUnixNano)])).digest("hex"),
						service: resourceAttributes["service.name"] || "unknown",
						environment: resourceAttributes["deployment.environment.name"] || resourceAttributes["deployment.environment"] || "production",
						release: resourceAttributes["service.version"] || "",
						method: method.slice(0, 20), route,
						bucketAt: new Date(Math.floor(endMs / 60_000) * 60_000),
						requestCount: count, errorCount: status >= 500 ? count : 0,
						durationSumMs: Number(point.sum) * multiplier,
						boundsMs: bounds.map((bound) => bound * multiplier), counts,
					});
				}
			}
		}
	}
	return points;
}
