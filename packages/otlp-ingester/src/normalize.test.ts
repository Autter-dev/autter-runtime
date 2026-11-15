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

// ── Test-client traffic and the running commit ───────────────────────────

const NOW_NANOS = NANOS;
const kv = (attributes: Record<string, string | boolean>) =>
	Object.entries(attributes).map(([key, value]) => ({
		key,
		value: typeof value === "boolean" ? { boolValue: value } : { stringValue: value },
	}));

/** One process: a request per entry of `requests`, each a server span with
 * an exception event and an internal child span, in its own trace. */
function processExport(
	resource: Record<string, string>,
	requests: Array<{ trace: string; attributes: Record<string, string | boolean>; event?: Record<string, string> }>,
) {
	return {
		resourceSpans: [{
			resource: { attributes: kv({ "service.name": "shop", ...resource }) },
			scopeSpans: [{
				spans: requests.flatMap(({ trace, attributes, event }) => [
					{
						traceId: trace, spanId: `${trace.slice(0, 15)}1`, name: "GET /carts/{cart_id}", kind: "SPAN_KIND_SERVER",
						startTimeUnixNano: NOW_NANOS, endTimeUnixNano: NOW_NANOS,
						attributes: kv({ "http.route": "/carts/{cart_id}", "http.method": "GET", "http.status_code": "500", ...attributes }),
						status: { code: "STATUS_CODE_ERROR" },
						events: [{ name: "exception", timeUnixNano: NOW_NANOS, attributes: kv({ "exception.type": "OutOfStock", "exception.message": "none left", ...event }) }],
					},
					{
						traceId: trace, spanId: `${trace.slice(0, 15)}2`, parentSpanId: `${trace.slice(0, 15)}1`, name: "db", kind: "SPAN_KIND_INTERNAL",
						startTimeUnixNano: NOW_NANOS, endTimeUnixNano: NOW_NANOS, attributes: [],
					},
				]),
			}],
		}],
	};
}

const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);

test("what a request says about itself never changes the environment: no environment is `production`, an explicit one is kept", () => {
	const claims: Array<Record<string, string | boolean>> = [
		{ "autter.test_client": true },
		{ "user_agent.original": "testclient" },
		{ "http.user_agent": "testclient" },
		{ "http.host": "testserver", "http.server_name": "testserver", "server.address": "testserver", "net.host.name": "testserver" },
	];
	for (const attributes of claims) {
		const result = normalizeTraces(processExport({}, [{ trace: TRACE_A, attributes }]));
		assert.deepEqual(result.spans.map((s) => s.environment), ["production", "production"], JSON.stringify(attributes));
		assert.deepEqual(result.occurrences.map((o) => o.environment), ["production"], JSON.stringify(attributes));
		assert.deepEqual(result.metricPoints.map((p) => p.environment), ["production"], JSON.stringify(attributes));
		for (const name of ["test", "staging"]) {
			const explicit = normalizeTraces(processExport({ "deployment.environment": name }, [{ trace: TRACE_A, attributes }]));
			assert.deepEqual(explicit.occurrences.map((o) => o.environment), [name]);
		}
	}
	// Two requests of one process, one claiming to be a test client: both production.
	const mixed = normalizeTraces(processExport({}, [
		{ trace: TRACE_A, attributes: { "http.host": "testserver" } },
		{ trace: TRACE_B, attributes: { "http.host": "shop.example.com" } },
	]));
	assert.deepEqual(mixed.occurrences.map((o) => o.environment), ["production", "production"]);
});

test("commit: deployment.commit (else vcs.ref.head.revision) from the resource, lower-cased, also in the attributes", () => {
	const fromResource = normalizeTraces(processExport({ "deployment.commit": "9C1E4F2A7B3D" }, [{ trace: TRACE_A, attributes: {} }]));
	assert.equal(fromResource.occurrences[0]!.commit, "9c1e4f2a7b3d");
	assert.equal(fromResource.occurrences[0]!.attributes?.["deployment.commit"], "9c1e4f2a7b3d");

	const sha = "0123456789abcdef0123456789abcdef01234567";
	const vcs = normalizeTraces(processExport({ "vcs.ref.head.revision": sha }, [{ trace: TRACE_A, attributes: {} }]));
	assert.equal(vcs.occurrences[0]!.commit, sha);
	const both = normalizeTraces(processExport({ "vcs.ref.head.revision": sha, "deployment.commit": "abcdef1" }, [{ trace: TRACE_A, attributes: {} }]));
	assert.equal(both.occurrences[0]!.commit, "abcdef1");
});

test("commit: an event attribute beats the span's and the resource's", () => {
	const result = normalizeTraces(processExport(
		{ "deployment.commit": "1111111111111111111111111111111111111111" },
		[{ trace: TRACE_A, attributes: { "deployment.commit": "2222222" }, event: { "deployment.commit": "3333333" } }],
	));
	assert.equal(result.occurrences[0]!.commit, "3333333");
	// Already in the attributes: kept as sent.
	assert.equal(result.occurrences[0]!.attributes?.["deployment.commit"], "3333333");
	const spanOnly = normalizeTraces(processExport(
		{ "deployment.commit": "1111111111111111111111111111111111111111" },
		[{ trace: TRACE_A, attributes: { "deployment.commit": "2222222" } }],
	));
	assert.equal(spanOnly.occurrences[0]!.commit, "2222222");
});

test("commit: anything but 7–40 hex is dropped; none means no field", () => {
	for (const bad of ["https://github.com/acme/shop", "9c1e4f", "0".repeat(41), "main", "v1.2.3", "9c1e4f2-dirty"]) {
		const result = normalizeTraces(processExport({ "deployment.commit": bad, "vcs.repository.url.full": "https://github.com/acme/shop" }, [{ trace: TRACE_A, attributes: {} }]));
		const [occurrence] = result.occurrences;
		assert.equal("commit" in occurrence!, false, bad);
		// Resource attributes never reach the occurrence's attributes.
		assert.equal(occurrence!.attributes?.["deployment.commit"], undefined, bad);
		assert.equal(occurrence!.attributes?.["vcs.repository.url.full"], undefined, bad);
	}
	// An invalid event value does not hide a valid one below it.
	const fallback = normalizeTraces(processExport({ "deployment.commit": "abcdef1234" }, [{ trace: TRACE_A, attributes: {}, event: { "deployment.commit": "not-a-sha" } }]));
	assert.equal(fallback.occurrences[0]!.commit, "abcdef1234");

	const none = normalizeTraces(processExport({}, [{ trace: TRACE_A, attributes: {} }]));
	assert.equal("commit" in none.occurrences[0]!, false);
	assert.equal(none.occurrences[0]!.attributes?.["deployment.commit"], undefined);
});
