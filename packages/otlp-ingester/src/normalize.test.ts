import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeBrowserPayload } from "./normalize-browser.js";
import { normalizeTraces } from "./normalize-otlp.js";
import type { RuntimeMetricPoint } from "./types.js";

/**
 * Regression tests for "issues detected but error counts show 0": every
 * error or fatal occurrence must also land in the usage rollups' error_count.
 * `request_count` counts requests only (EI-26): an error outside a request
 * adds to error_count alone, one inside a request makes it a failed request.
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

test("browser errors count in error_count, never as requests", () => {
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
	// 4 exceptions + 1 rejection are errors outside any request; the
	// warning counts nothing; the track_event keeps its usage counter on
	// `event:clicked` (before EI-26 every event was also a request: 7).
	assert.equal(totals.requestCount, 1);
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

test("exceptions on internal spans (captureException, workers) count as errors outside a request", () => {
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
	assert.equal(totals.requestCount, 0);
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

test("exception spans inherit method, route, status, and duration from the HTTP parent", () => {
	const start = NANOS;
	const end = String(BigInt(NANOS) + 120_000_000n);
	const { occurrences } = normalizeTraces({
		resourceSpans: [
			{
				scopeSpans: [
					{
						spans: [
							{
								traceId: "a".repeat(32),
								spanId: "c".repeat(16),
								name: "POST /api/gmails",
								kind: 2,
								startTimeUnixNano: start,
								endTimeUnixNano: end,
								status: { code: 2 },
								attributes: [
									{ key: "http.route", value: { stringValue: "/api/gmails" } },
									{ key: "http.request.method", value: { stringValue: "POST" } },
									{ key: "http.response.status_code", value: { intValue: 500 } },
								],
							},
							{
								traceId: "a".repeat(32),
								spanId: "d".repeat(16),
								parentSpanId: "c".repeat(16),
								name: "Error",
								kind: 1,
								startTimeUnixNano: start,
								endTimeUnixNano: end,
								status: { code: 2, message: "Database Error" },
								events: [
									{
										name: "exception",
										timeUnixNano: start,
										attributes: [
											{ key: "exception.type", value: { stringValue: "Error" } },
											{
												key: "exception.message",
												value: { stringValue: "Database Error" },
											},
										],
									},
								],
							},
						],
					},
				],
			},
		],
	});

	const error = occurrences.find((row) => row.message === "Database Error");
	assert.ok(error);
	assert.equal(error.route, "/api/gmails");
	assert.equal(error.method, "POST");
	assert.equal(error.statusCode, 500);
	assert.equal(error.attributes?.["http.server.duration_ms"], 120);
});

test("warning occurrences outside a request count nothing", () => {
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

	assert.deepEqual(metricPoints, []);
});
