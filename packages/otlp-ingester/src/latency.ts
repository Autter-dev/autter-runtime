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

/**
 * Per-route latency percentiles in the 1-minute rollups (IP-02).
 *
 * `runtime_metrics_1m` is a SummingMergeTree with an explicit column list,
 * so no percentile can be merged there. Every rollup point also carries
 * latency samples (`RuntimeMetricPoint.latency`): a request's own duration
 * (span- and summary-fed requests) or a delta histogram's buckets
 * (metric-fed), spread evenly over each bucket. They are written to
 * `runtime_route_latency_input` (ENGINE = Null: nothing is stored), whose
 * materialized view folds them into `runtime_route_latency_1m`, keyed like
 * `runtime_metrics_1m`, as a mergeable t-digest:
 *
 *   SELECT route, sum(request_count) AS requests,
 *          quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(duration_quantiles) AS q
 *   FROM runtime_route_latency_1m
 *   WHERE org_id = … AND repository_id = … AND bucket_at >= now() - INTERVAL 1 HOUR
 *   GROUP BY route            -- q[1] p50, q[2] p95, q[3] p99, in ms
 *
 * Any window and grouping merge exactly as the t-digest does. Like
 * `runtime_metrics_1m`, an exporter retry after a lost 2xx counts twice.
 */
export interface LatencySamples {
	/** Durations in ms… */
	valuesMs: number[];
	/** …and how many requests each stands for. */
	weights: number[];
}

/** Points one histogram bucket is spread over (uniform within the bucket). */
const BUCKET_SPREAD = 8;

/**
 * Samples for a delta histogram: each bucket's count spread evenly over
 * [previous bound, bound] (at most 8 points), the overflow bucket at the
 * highest bound. Undefined for a histogram without usable buckets.
 */
export function histogramLatency(boundsMs: readonly number[], counts: readonly number[]): LatencySamples | undefined {
	if (boundsMs.length === 0 || boundsMs.length > 256 || counts.length !== boundsMs.length + 1) return undefined;
	if (boundsMs.some((bound, i) => !Number.isFinite(bound) || bound < 0 || (i > 0 && bound <= boundsMs[i - 1]!))) return undefined;
	if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return undefined;
	const valuesMs: number[] = [];
	const weights: number[] = [];
	counts.forEach((count, i) => {
		if (count === 0) return;
		const lower = i === 0 ? 0 : boundsMs[i - 1]!;
		if (i === boundsMs.length) {
			valuesMs.push(lower);
			weights.push(count);
			return;
		}
		const upper = boundsMs[i]!;
		const points = Math.min(count, BUCKET_SPREAD);
		const base = Math.floor(count / points);
		for (let j = 0; j < points; j++) {
			valuesMs.push(lower + ((upper - lower) * (j + 0.5)) / points);
			weights.push(base + (j < count - base * points ? 1 : 0));
		}
	});
	return valuesMs.length ? { valuesMs, weights } : undefined;
}

/** One request's duration as samples. */
export function requestLatency(durationMs: number): LatencySamples | undefined {
	return Number.isFinite(durationMs) && durationMs >= 0 ? { valuesMs: [durationMs], weights: [1] } : undefined;
}

/** Concatenate samples of points folded into one rollup row. */
export function mergeLatency(a: LatencySamples | undefined, b: LatencySamples | undefined): LatencySamples | undefined {
	if (!a) return b && { valuesMs: [...b.valuesMs], weights: [...b.weights] };
	if (b) {
		a.valuesMs.push(...b.valuesMs);
		a.weights.push(...b.weights);
	}
	return a;
}

/** Null input table: rows pass to the view, nothing is stored. */
export function routeLatencyInputDDL(database: string): string {
	return `CREATE TABLE IF NOT EXISTS ${database}.runtime_route_latency_input (
		org_id String, repository_id String, service String, environment String,
		release String, route String, bucket_at DateTime('UTC'),
		values_ms Array(Float64), weights Array(UInt64)
	) ENGINE = Null`;
}

export function routeLatencyTableDDL(database: string, ttlDays = 90): string {
	return `CREATE TABLE IF NOT EXISTS ${database}.runtime_route_latency_1m (
		org_id String, repository_id String,
		service LowCardinality(String), environment LowCardinality(String),
		release String DEFAULT '', route String DEFAULT '', bucket_at DateTime('UTC'),
		request_count SimpleAggregateFunction(sum, UInt64),
		duration_quantiles AggregateFunction(quantilesTDigestWeighted(0.5, 0.95, 0.99), Float64, UInt64)
	) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(bucket_at)
	ORDER BY (org_id, repository_id, service, environment, release, route, bucket_at)
	TTL bucket_at + INTERVAL ${Math.max(1, Math.round(ttlDays))} DAY`;
}

/** Needs both tables above; reads nothing older than itself. */
export function routeLatencyViewDDL(database: string): string {
	return `CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.runtime_route_latency_1m_mv
	TO ${database}.runtime_route_latency_1m AS
	SELECT
		org_id, repository_id, service, environment, release, route, bucket_at,
		sum(weight) AS request_count,
		quantilesTDigestWeightedState(0.5, 0.95, 0.99)(value_ms, weight) AS duration_quantiles
	FROM ${database}.runtime_route_latency_input
	ARRAY JOIN values_ms AS value_ms, weights AS weight
	GROUP BY org_id, repository_id, service, environment, release, route, bucket_at`;
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
