import assert from "node:assert/strict";
import { test } from "node:test";
import protobuf from "protobufjs";
import { normalizeLatencyHistograms } from "./latency.js";
import type { OtlpMetricsRequest } from "./normalize-otlp.js";
import { decodeMetricsRequest } from "./otlp-proto.js";

function payload(): OtlpMetricsRequest {
	return { resourceMetrics: [{ resource: { attributes: [
		{ key: "service.name", value: { stringValue: "sample-service" } },
		{ key: "service.instance.id", value: { stringValue: "instance-a" } },
	] }, scopeMetrics: [{ metrics: [{ name: "http.server.request.duration", histogram: {
		aggregationTemporality: 1, dataPoints: [{
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

test("only delta temporality representations are accepted", () => {
	for (const temporality of [1, "1", "AGGREGATION_TEMPORALITY_DELTA", 2, "2", "AGGREGATION_TEMPORALITY_CUMULATIVE", 0, "0", undefined]) {
		const request = payload();
		request.resourceMetrics![0]!.scopeMetrics![0]!.metrics![0]!.histogram!.aggregationTemporality = temporality;
		const expected = [1, "1", "AGGREGATION_TEMPORALITY_DELTA"].includes(temporality ?? "") ? 1 : 0;
		assert.equal(normalizeLatencyHistograms(request).length, expected, String(temporality));
	}
});

test("OTLP protobuf delta buckets reach the latency normalizer", () => {
	const schema = protobuf.parse(`
		syntax = "proto3";
		message AnyValue { string string_value = 1; }
		message KeyValue { string key = 1; AnyValue value = 2; }
		message Resource { repeated KeyValue attributes = 1; }
		message Request { repeated ResourceMetrics resource_metrics = 1; }
		message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
		message ScopeMetrics { repeated Metric metrics = 2; }
		message Metric { string name = 1; Histogram histogram = 9; }
		enum AggregationTemporality {
			AGGREGATION_TEMPORALITY_UNSPECIFIED = 0;
			AGGREGATION_TEMPORALITY_DELTA = 1;
			AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
		}
		message Histogram { repeated Point data_points = 1; AggregationTemporality aggregation_temporality = 2; }
		message Point {
			fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3;
			fixed64 count = 4; optional double sum = 5;
			repeated fixed64 bucket_counts = 6; repeated double explicit_bounds = 7;
			repeated KeyValue attributes = 9;
		}
	`).root.lookupType("Request");
	for (const temporality of ["AGGREGATION_TEMPORALITY_DELTA", "AGGREGATION_TEMPORALITY_CUMULATIVE"]) {
		const request = payload();
		request.resourceMetrics![0]!.scopeMetrics![0]!.metrics![0]!.histogram!.aggregationTemporality = temporality;
		const encoded = Buffer.from(schema.encode(schema.fromObject(request)).finish());
		const points = normalizeLatencyHistograms(decodeMetricsRequest(encoded));
		assert.deepEqual(points, temporality === "AGGREGATION_TEMPORALITY_DELTA" ? normalizeLatencyHistograms(payload()) : []);
	}
});

test("cumulative, invalid, and long-interval histograms are not used for detection", () => {
	const cumulative = payload();
	const histogram = cumulative.resourceMetrics![0]!.scopeMetrics![0]!.metrics![0]!.histogram!;
	histogram.aggregationTemporality = 2;
	assert.deepEqual(normalizeLatencyHistograms(cumulative), []);
	histogram.aggregationTemporality = 1;
	histogram.dataPoints![0]!.bucketCounts = ["1", "2", "0"];
	assert.deepEqual(normalizeLatencyHistograms(cumulative), []);
	const delayed = payload();
	delayed.resourceMetrics![0]!.scopeMetrics![0]!.metrics![0]!.histogram!.dataPoints![0]!.startTimeUnixNano = "1735689000000000000";
	assert.deepEqual(normalizeLatencyHistograms(delayed), []);
});
