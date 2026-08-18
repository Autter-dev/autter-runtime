import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeBrowserPayload } from "./normalize-browser.js";
import { normalizeTraces } from "./normalize-otlp.js";
import type { RuntimeMetricPoint } from "./types.js";

/**
 * Regression tests for "issues detected but event counts show 0": every
 * occurrence that can group into an issue must also land in the usage
 * rollups, so the dashboard's event counters agree with the issues list.
 */

function sums(points: RuntimeMetricPoint[]) {
	return points.reduce(
		(acc, p) => ({
			requestCount: acc.requestCount + p.requestCount,
			errorCount: acc.errorCount + p.errorCount,
			sessionCount: acc.sessionCount + p.sessionCount,
		}),
		{ requestCount: 0, errorCount: 0, sessionCount: 0 },
	);
}

const T = "2026-08-16T02:02:00.000Z";

test("browser error events count into the usage rollups", () => {
	const { occurrences, metricPoints } = normalizeBrowserPayload({
		version: 1,
		service: "test-html-page",
		environment: "development",
		events: [
			...Array.from({ length: 4 }, () => ({
				type: "exception" as const,
				timestamp: T,
				message: "Deliberate test error for Autter Runtime",
				errorType: "Error",
			})),
			{
				type: "unhandled_rejection" as const,
				timestamp: T,
				message: "Deliberate test unhandled rejection",
			},
			{
				type: "message" as const,
				timestamp: T,
				message: "soft warning",
				severity: "warning" as const,
			},
			{ type: "session_start" as const, timestamp: T, message: "" },
			{
				type: "track_event" as const,
				timestamp: T,
				message: "",
				name: "clicked",
			},
		],
	});

	assert.equal(occurrences.length, 6);
	const totals = sums(metricPoints);
	// 4 exceptions + 1 rejection + 1 warning + 1 track_event = 7 events;
	// only fatal/error severity counts as an error event.
	assert.equal(totals.requestCount, 7);
	assert.equal(totals.errorCount, 5);
	assert.equal(totals.sessionCount, 1);
});

function otlpSpan(overrides: Record<string, unknown>) {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "worker" } },
						{
							key: "deployment.environment",
							value: { stringValue: "development" },
						},
					],
				},
				scopeSpans: [{ spans: [overrides] }],
			},
		],
	};
}

const NANOS = "1755309720000000000";

test("exceptions on internal spans (captureException, workers) count as events", () => {
	const { occurrences, metricPoints } = normalizeTraces(
		otlpSpan({
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			name: "TypeError",
			kind: 1, // internal — no request rollup of its own
			startTimeUnixNano: NANOS,
			endTimeUnixNano: NANOS,
			status: { code: 2, message: "boom" },
			events: [
				{
					name: "exception",
					timeUnixNano: NANOS,
					attributes: [
						{ key: "exception.type", value: { stringValue: "TypeError" } },
						{ key: "exception.message", value: { stringValue: "boom" } },
					],
				},
			],
		}),
	);

	assert.equal(occurrences.length, 1);
	const totals = sums(metricPoints);
	assert.equal(totals.requestCount, 1);
	assert.equal(totals.errorCount, 1);
});

test("server-span exceptions are not double counted", () => {
	const { occurrences, metricPoints } = normalizeTraces(
		otlpSpan({
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			name: "GET /api/boom",
			kind: 2, // server — the request rollup already represents it
			startTimeUnixNano: NANOS,
			endTimeUnixNano: NANOS,
			status: { code: 2, message: "boom" },
			attributes: [
				{ key: "http.route", value: { stringValue: "/api/boom" } },
				{ key: "http.status_code", value: { intValue: 500 } },
			],
			events: [
				{
					name: "exception",
					timeUnixNano: NANOS,
					attributes: [
						{ key: "exception.type", value: { stringValue: "TypeError" } },
					],
				},
			],
		}),
	);

	assert.equal(occurrences.length, 1);
	const totals = sums(metricPoints);
	assert.equal(totals.requestCount, 1);
	assert.equal(totals.errorCount, 1);
});

test("warning occurrences count as events but not error events", () => {
	const { metricPoints } = normalizeTraces(
		otlpSpan({
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			name: "Message",
			kind: 1,
			startTimeUnixNano: NANOS,
			endTimeUnixNano: NANOS,
			status: { code: 2, message: "deprecated path" },
			attributes: [
				{ key: "autter.severity", value: { stringValue: "warning" } },
			],
			events: [
				{
					name: "exception",
					timeUnixNano: NANOS,
					attributes: [
						{ key: "exception.message", value: { stringValue: "deprecated" } },
					],
				},
			],
		}),
	);

	const totals = sums(metricPoints);
	assert.equal(totals.requestCount, 1);
	assert.equal(totals.errorCount, 0);
});
