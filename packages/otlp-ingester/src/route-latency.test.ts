import assert from "node:assert/strict";
import { test } from "node:test";
import {
	histogramLatency,
	mergeLatency,
	requestLatency,
	routeLatencyInputDDL,
	routeLatencyTableDDL,
	routeLatencyViewDDL,
} from "./latency.js";
import { MIGRATIONS } from "./migrations.js";
import { normalizeMetrics, normalizeTraces } from "./normalize-otlp.js";

// IP-02: p95/p99 per route in the 1-minute rollups, built from the latency
// samples each rollup point now carries, folded into runtime_route_latency_1m
// as a t-digest. runtime_metrics_1m and its readers are untouched.

test("requestLatency is one weighted sample; mergeLatency concatenates", () => {
	assert.deepEqual(requestLatency(42), { valuesMs: [42], weights: [1] });
	assert.equal(requestLatency(-1), undefined, "a negative duration is no sample");
	const a = requestLatency(10)!;
	const merged = mergeLatency(a, requestLatency(20));
	assert.deepEqual(merged, { valuesMs: [10, 20], weights: [1, 1] });
	// mergeLatency(undefined, b) copies b (never aliases it).
	const b = requestLatency(5)!;
	const copy = mergeLatency(undefined, b)!;
	copy.valuesMs.push(99);
	assert.deepEqual(b.valuesMs, [5], "the source is not mutated");
});

test("histogramLatency spreads each bucket's count, weights summing to the count", () => {
	// bounds 100, 1000 → buckets [0,100], (100,1000], (1000,∞).
	const samples = histogramLatency([100, 1000], [80, 20, 3])!;
	assert.ok(samples, "built");
	const total = samples.weights.reduce((a, b) => a + b, 0);
	assert.equal(total, 103, "every request is represented");
	// Every sample value falls within its bucket's range.
	assert.ok(samples.valuesMs.every((v) => v >= 0));
	// The overflow bucket is pinned at the top bound.
	assert.ok(samples.valuesMs.includes(1000), "overflow samples sit at the highest bound");
	assert.equal(histogramLatency([], []), undefined, "no buckets → no samples");
	assert.equal(histogramLatency([100, 100], [1, 1, 1]), undefined, "non-increasing bounds rejected");
	assert.equal(histogramLatency([100, 1000], [0, 0, 0]), undefined, "an empty histogram yields nothing");
});

test("normalizeMetrics attaches latency samples to each delta histogram rollup point", () => {
	const points = normalizeMetrics({
		resourceMetrics: [{
			resource: { attributes: [
				{ key: "service.name", value: { stringValue: "api" } },
				{ key: "deployment.environment", value: { stringValue: "prod" } },
			] },
			scopeMetrics: [{ metrics: [{
				name: "http.server.request.duration",
				histogram: {
					aggregationTemporality: 1,
					dataPoints: [{
						startTimeUnixNano: "1755309660000000000",
						timeUnixNano: "1755309720000000000",
						count: "100", sum: 20,
						explicitBounds: [0.1, 1], bucketCounts: ["80", "20", "0"],
						attributes: [
							{ key: "http.route", value: { stringValue: "/items/:id" } },
							{ key: "http.request.method", value: { stringValue: "GET" } },
						],
					}],
				},
			}] }],
		}],
	});
	assert.equal(points.length, 1);
	const point = points[0]!;
	assert.equal(point.route, "/items/:id");
	assert.equal(point.requestCount, 100);
	assert.ok(point.latency, "the rollup point carries latency samples");
	assert.equal(point.latency!.weights.reduce((a, b) => a + b, 0), 100, "one sample weight per request");
	// Seconds became milliseconds, as durationSumMs did (×1000).
	assert.ok(point.latency!.valuesMs.some((v) => v > 1 && v <= 1000));
});

test("a span-counted request carries its own latency; runtime_metrics_1m counts are unchanged", () => {
	const NANOS_START = "1755309719000000000";
	const NANOS_END = "1755309720000000000";
	const { metricPoints } = normalizeTraces({
		resourceSpans: [{
			resource: { attributes: [
				{ key: "service.name", value: { stringValue: "api" } },
				{ key: "deployment.environment", value: { stringValue: "prod" } },
			] },
			scopeSpans: [{ spans: [{
				traceId: "a".repeat(32), spanId: "b".repeat(16),
				name: "GET /checkout", kind: 2,
				startTimeUnixNano: NANOS_START, endTimeUnixNano: NANOS_END,
				status: { code: 1 },
				attributes: [
					{ key: "http.route", value: { stringValue: "/checkout" } },
					{ key: "http.request.method", value: { stringValue: "POST" } },
					{ key: "http.response.status_code", value: { intValue: 200 } },
				],
			}] }],
		}],
	});
	const point = metricPoints.find((p) => p.route === "/checkout")!;
	assert.equal(point.requestCount, 1);
	assert.ok(point.latency, "the request's latency is sampled");
	assert.equal(point.latency!.valuesMs.length, 1);
	assert.equal(point.latency!.valuesMs[0], 1000, "the outermost span's duration, in ms");
});

test("migration 0022 ships the route-latency tables and the baseline uses the same DDL", () => {
	const migration = MIGRATIONS.find((m) => m.id === "0022-route-latency-1m");
	assert.ok(migration, "0022 exists");
	const sql = migration!.statements.join("\n");
	assert.match(sql, /runtime_route_latency_input/);
	assert.match(sql, /runtime_route_latency_1m/);
	assert.match(sql, /runtime_route_latency_1m_mv/);
	// Older readers keep working: every statement is additive and idempotent.
	for (const statement of migration!.statements) assert.match(statement, /IF NOT EXISTS/);
	// The view reads p50, p95 and p99.
	assert.match(routeLatencyViewDDL("db"), /quantilesTDigestWeightedState\(0\.5, 0\.95, 0\.99\)/);
	assert.match(routeLatencyTableDDL("db"), /AggregateFunction\(quantilesTDigestWeighted/);
	assert.match(routeLatencyInputDDL("db"), /ENGINE = Null/);
});
