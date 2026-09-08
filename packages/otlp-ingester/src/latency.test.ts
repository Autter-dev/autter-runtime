import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLatencyHistograms } from "./latency.js";
import type { OtlpMetricsRequest } from "./normalize-otlp.js";

function payload(): OtlpMetricsRequest {
	return { resourceMetrics: [{ resource: { attributes: [
		{ key: "service.name", value: { stringValue: "sample-service" } },
		{ key: "service.instance.id", value: { stringValue: "instance-a" } },
	] }, scopeMetrics: [{ metrics: [{ name: "http.server.request.duration", histogram: {
		aggregationTemporality: 2, dataPoints: [{
			startTimeUnixNano: "1735689600000000000", timeUnixNano: "1735689660000000000",
			count: "100", sum: 20, explicitBounds: [0.1, 1], bucketCounts: ["80", "20", "0"],
			attributes: [{ key: "http.route", value: { stringValue: "/items/:id" } },
				{ key: "http.request.method", value: { stringValue: "GET" } }],
		}],
	} }] }] }] };
}

test("delta histograms retain buckets and use milliseconds", () => {
	const [point] = normalizeLatencyHistograms(payload());
	assert.ok(point);
	assert.deepEqual(point.boundsMs, [100, 1000]);
	assert.deepEqual(point.counts, [80, 20, 0]);
	assert.equal(point.durationSumMs, 20000);
	assert.equal(point.method, "GET");
});

test("retry identity is stable and separates service instances", () => {
	const first = normalizeLatencyHistograms(payload())[0]!;
	assert.equal(first.pointId, normalizeLatencyHistograms(payload())[0]!.pointId);
	const other = payload();
	other.resourceMetrics![0]!.resource!.attributes![1]!.value!.stringValue = "instance-b";
	assert.notEqual(first.pointId, normalizeLatencyHistograms(other)[0]!.pointId);
});

test("cumulative, invalid, and long-interval histograms are not used for detection", () => {
	const cumulative = payload();
	const histogram = cumulative.resourceMetrics![0]!.scopeMetrics![0]!.metrics![0]!.histogram!;
	histogram.aggregationTemporality = 1;
	assert.deepEqual(normalizeLatencyHistograms(cumulative), []);
	histogram.aggregationTemporality = 2;
	histogram.dataPoints![0]!.bucketCounts = ["1", "2", "0"];
	assert.deepEqual(normalizeLatencyHistograms(cumulative), []);
	const delayed = payload();
	delayed.resourceMetrics![0]!.scopeMetrics![0]!.metrics![0]!.histogram!.dataPoints![0]!.startTimeUnixNano = "1735689000000000000";
	assert.deepEqual(normalizeLatencyHistograms(delayed), []);
});
