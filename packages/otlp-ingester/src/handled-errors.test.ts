import assert from "node:assert/strict";
import { test } from "node:test";
import { caughtLimitedRecords } from "./ingest-drops.js";
import { logRollups, normalizeLogs } from "./logs.js";
import { logPromotionCandidates } from "./log-promotion.js";
import { normalizeBrowserPayload } from "./normalize-browser.js";
import { normalizeTraces } from "./normalize-otlp.js";

// RF-01 / RF-02 (ingester side): a handled error (caught and logged, or a
// deliberate fallback marked `autter.handled`) is recorded as an occurrence
// and an issue, but it never fails its span or request and never counts in
// `error_count`. A handled warning is still promoted to an occurrence.

const NANOS = "1755309720000000000";

function serverSpanWith(eventAttributes: Array<{ key: string; value: Record<string, unknown> }>, statusCode = 200) {
	return normalizeTraces({
		resourceSpans: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
			scopeSpans: [{ spans: [{
				traceId: "a".repeat(32), spanId: "b".repeat(16),
				name: "GET /checkout", kind: 2,
				startTimeUnixNano: NANOS, endTimeUnixNano: NANOS,
				status: { code: 1 },
				attributes: [
					{ key: "http.route", value: { stringValue: "/checkout" } },
					{ key: "http.request.method", value: { stringValue: "GET" } },
					{ key: "http.response.status_code", value: { intValue: statusCode } },
				],
				events: [{ name: "exception", timeUnixNano: NANOS, attributes: eventAttributes }],
			}] }],
		}],
	});
}

test("a caught error in a request is an occurrence, but the request does not fail", () => {
	const { occurrences, metricPoints } = serverSpanWith([
		{ key: "exception.type", value: { stringValue: "Error" } },
		{ key: "exception.message", value: { stringValue: "db timeout, retried" } },
		{ key: "exception.stacktrace", value: { stringValue: "Error: db timeout\n    at q (/app/db.js:3:1)" } },
		{ key: "autter.handled", value: { boolValue: true } },
		{ key: "autter.handling", value: { stringValue: "caught" } },
	]);
	assert.equal(occurrences.length, 1, "still an occurrence");
	assert.equal(occurrences[0]!.attributes!["autter.handled"], true);
	const errorCount = metricPoints.reduce((a, p) => a + p.errorCount, 0);
	const requestCount = metricPoints.reduce((a, p) => a + p.requestCount, 0);
	assert.equal(requestCount, 1, "the request is counted");
	assert.equal(errorCount, 0, "a handled error does not fail the request");
});

test("an unhandled exception on the same span does fail the request (control)", () => {
	const { metricPoints } = serverSpanWith([
		{ key: "exception.type", value: { stringValue: "Error" } },
		{ key: "exception.message", value: { stringValue: "unhandled" } },
	], 500);
	const errorCount = metricPoints.reduce((a, p) => a + p.errorCount, 0);
	assert.equal(errorCount, 1, "an unhandled error fails its request");
});

test("a handled exception outside a request is recorded but not counted", () => {
	const { occurrences, metricPoints } = normalizeTraces({
		resourceSpans: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "worker" } }] },
			scopeSpans: [{ spans: [{
				traceId: "c".repeat(32), spanId: "d".repeat(16),
				name: "job", kind: 1, startTimeUnixNano: NANOS, endTimeUnixNano: NANOS,
				status: { code: 1 },
				events: [{ name: "exception", timeUnixNano: NANOS, attributes: [
					{ key: "exception.type", value: { stringValue: "Error" } },
					{ key: "exception.message", value: { stringValue: "caught in worker" } },
					{ key: "autter.handled", value: { boolValue: true } },
				] }],
			}] }],
		}],
	});
	assert.equal(occurrences.length, 1);
	assert.equal(metricPoints.reduce((a, p) => a + p.errorCount, 0), 0, "handled, so no error counted");
});

test("a deliberate fallback (handled warning, capture.mode=log) is promoted but not counted", () => {
	const rows = normalizeLogs({
		resourceLogs: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
			scopeLogs: [{ logRecords: [{
				timeUnixNano: NANOS,
				severityNumber: 13, // warning
				body: { stringValue: "pricing degraded" },
				attributes: [
					{ key: "autter.capture.mode", value: { stringValue: "log" } },
					{ key: "autter.handled", value: { boolValue: true } },
					{ key: "autter.handling", value: { stringValue: "deliberate" } },
					{ key: "autter.degraded.reason", value: { stringValue: "using cached prices" } },
					{ key: "exception.type", value: { stringValue: "Error" } },
					{ key: "exception.message", value: { stringValue: "pricing service down" } },
					{ key: "exception.stacktrace", value: { stringValue: "Error: pricing service down\n    at p (/app/p.js:1:1)" } },
				],
			}] }],
		}],
	});
	const promoted = logPromotionCandidates(rows);
	assert.equal(promoted.length, 1, "a handled warning is promoted to an occurrence");
	assert.equal(promoted[0]!.severity, "warning");
	// Build RuntimeOccurrence-shaped inputs for the rollup: handled, warning.
	const rollups = logRollups(rows, promoted.map((o) => ({ ...o, attributes: o.attributes ?? {} }) as never));
	assert.equal(rollups.reduce((a, p) => a + p.errorCount, 0), 0, "a deliberate fallback never counts as an error");
});

test("caughtLimitedRecords sums the per-record autter.caught.dropped counts", () => {
	assert.equal(caughtLimitedRecords([{ "autter.caught.dropped": 5 }, { "autter.caught.dropped": 2 }, {}, null]), 7);
	assert.equal(caughtLimitedRecords([{ "autter.caught.dropped": -1 }, { "autter.caught.dropped": "x" }]), 0);
});

test("a browser console.error occurrence is marked caught and not counted", () => {
	const { occurrences, metricPoints } = normalizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "production",
		events: [{
			type: "exception",
			timestamp: "2026-08-16T02:02:00.000Z",
			message: "render failed",
			errorType: "Error",
			severity: "error",
			context: { "autter.log.message": "component crashed render failed" },
		}],
	});
	assert.equal(occurrences.length, 1);
	assert.equal(occurrences[0]!.attributes!["autter.handled"], true);
	assert.equal(occurrences[0]!.attributes!["autter.handling"], "caught");
	assert.equal(metricPoints.reduce((a, p) => a + p.errorCount, 0), 0, "a caught browser error is not a counted failure");
});
