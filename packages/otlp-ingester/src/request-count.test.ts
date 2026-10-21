import assert from "node:assert/strict";
import { test } from "node:test";
import {
	normalizeMetrics,
	normalizeTraces,
	type OtlpMetricsRequest,
	type OtlpTraceRequest,
} from "./normalize-otlp.js";
import { requestMembership } from "./request-spans.js";
import type { RuntimeMetricPoint } from "./types.js";

/**
 * EI-26: one request is one count in the usage rollups (`runtime_metrics_1m`),
 * however many server spans it has and whichever feed counts it.
 */

const BASE_MS = 1_755_309_720_000n;
const at = (ms: number) => String((BASE_MS + BigInt(ms)) * 1_000_000n);
const TRACE = "a".repeat(32);
const sid = (n: number) => n.toString(16).padStart(16, "0");

type Value = string | number | boolean;

function kv(attributes: Record<string, Value>) {
	return Object.entries(attributes).map(([key, value]) => ({
		key,
		value:
			typeof value === "string"
				? { stringValue: value }
				: typeof value === "boolean"
					? { boolValue: value }
					: { intValue: value },
	}));
}

const SERVER = 2;
const CLIENT = 3;

interface SpanSpec {
	id: number;
	parent?: number;
	name: string;
	kind?: number;
	start?: number;
	end?: number;
	error?: boolean;
	attributes?: Record<string, Value>;
	events?: unknown[];
	traceId?: string;
}

function span(spec: SpanSpec) {
	return {
		traceId: spec.traceId ?? TRACE,
		spanId: sid(spec.id),
		...(spec.parent !== undefined ? { parentSpanId: sid(spec.parent) } : {}),
		name: spec.name,
		kind: spec.kind ?? 1,
		startTimeUnixNano: at(spec.start ?? 0),
		endTimeUnixNano: at(spec.end ?? 50),
		...(spec.error ? { status: { code: 2 } } : {}),
		attributes: kv(spec.attributes ?? {}),
		events: spec.events ?? [],
	};
}

function resourceSpans(spans: SpanSpec[], service = "web", resource: Record<string, Value> = {}) {
	return {
		resource: {
			attributes: kv({ "service.name": service, "deployment.environment": "production", ...resource }),
		},
		scopeSpans: [{ spans: spans.map(span) }],
	};
}

function batch(spans: SpanSpec[], service = "web", resource: Record<string, Value> = {}): OtlpTraceRequest {
	return { resourceSpans: [resourceSpans(spans, service, resource)] };
}

function exception(ms: number, type: string, message: string, extra: Record<string, Value> = {}) {
	return {
		name: "exception",
		timeUnixNano: at(ms),
		attributes: kv({ "exception.type": type, "exception.message": message, ...extra }),
	};
}

function totals(points: RuntimeMetricPoint[]) {
	return points.reduce(
		(acc, p) => ({
			requests: acc.requests + p.requestCount,
			errors: acc.errors + p.errorCount,
			durationMs: acc.durationMs + p.durationSumMs,
		}),
		{ requests: 0, errors: 0, durationMs: 0 },
	);
}

function byService(points: RuntimeMetricPoint[]) {
	const out: Record<string, number> = {};
	for (const p of points) out[p.service] = (out[p.service] ?? 0) + p.requestCount;
	return out;
}

/** A Next.js request as the HTTP instrumentation and Next export it: the
 * HTTP server span (raw path only), Next's own `BaseServer.handleRequest`
 * server span under it (route template), and a render span. */
function nextRequest(opts: { base?: number; traceId?: string; path?: string } = {}): SpanSpec[] {
	const base = opts.base ?? 0;
	const traceId = opts.traceId ?? TRACE;
	const path = opts.path ?? "/blog/hello-world";
	return [
		{
			id: base + 3,
			parent: base + 2,
			traceId,
			name: "render route (app) /blog/[slug]",
			start: 10,
			end: 80,
			attributes: { "next.span_type": "AppRender.getBodyResult", "next.route": "/blog/[slug]" },
		},
		{
			id: base + 2,
			parent: base + 1,
			traceId,
			name: "GET /blog/[slug]",
			kind: SERVER,
			start: 5,
			end: 90,
			attributes: {
				"next.span_type": "BaseServer.handleRequest",
				"next.route": "/blog/[slug]",
				"http.route": "/blog/[slug]",
				"http.method": "GET",
				"http.target": path,
				"http.status_code": 200,
			},
		},
		{
			id: base + 1,
			traceId,
			name: "GET",
			kind: SERVER,
			start: 0,
			end: 100,
			attributes: {
				"http.method": "GET",
				"http.target": path,
				"http.status_code": 200,
			},
		},
	];
}

// ── One request, one count ────────────────────────────────────────────────

test("Next.js: the HTTP server span and Next's server span are one request, under Next's route template", () => {
	const { metricPoints, spans } = normalizeTraces(batch(nextRequest()));
	assert.equal(metricPoints.length, 1);
	const [point] = metricPoints;
	assert.equal(point?.requestCount, 1);
	assert.equal(point?.errorCount, 0);
	// The route template from Next's span beats the HTTP span's raw path.
	assert.equal(point?.route, "/blog/[slug]");
	// Latency is the outer (HTTP) span's: the whole request.
	assert.equal(point?.durationSumMs, 100);
	assert.equal(point?.bucketAt.getTime(), Math.floor(Number(BASE_MS) / 60_000) * 60_000);
	// Every span is still stored.
	assert.equal(spans.length, 3);
});

test("Next.js: an erroring request is one request and one error, without an extra event", () => {
	const spans = nextRequest();
	spans[0] = { ...spans[0]!, error: true, events: [exception(70, "Error", "render failed")] };
	spans[1] = { ...spans[1]!, error: true, attributes: { ...spans[1]!.attributes, "http.status_code": 500 } };
	spans[2] = { ...spans[2]!, error: true, attributes: { ...spans[2]!.attributes, "http.status_code": 500 } };
	const { occurrences, metricPoints } = normalizeTraces(batch(spans));
	// Both errored server spans' HttpServerErrors are explained by the
	// render span's exception (trace-dedupe.ts): one occurrence.
	assert.deepEqual(occurrences.map((o) => o.message), ["render failed"]);
	assert.deepEqual(totals(metricPoints), { requests: 1, errors: 1, durationMs: 100 });
	assert.equal(metricPoints[0]?.route, "/blog/[slug]");
});

test("a nested server span's error makes the request an errored one", () => {
	const spans = nextRequest();
	// Next's span errored, the HTTP span did not see it (status 200).
	spans[1] = { ...spans[1]!, error: true };
	const { metricPoints } = normalizeTraces(batch(spans));
	assert.deepEqual(totals(metricPoints), { requests: 1, errors: 1, durationMs: 100 });
});

test("Express: one server span is one request", () => {
	const { metricPoints } = normalizeTraces(batch([
		{ id: 2, parent: 1, name: "request handler - /api/users/:id", start: 2, end: 30, attributes: { "express.type": "request_handler" } },
		{
			id: 1,
			name: "GET /api/users/:id",
			kind: SERVER,
			start: 0,
			end: 40,
			attributes: { "http.route": "/api/users/:id", "http.request.method": "GET", "http.response.status_code": 200 },
		},
	]));
	assert.equal(metricPoints.length, 1);
	assert.equal(metricPoints[0]?.route, "/api/users/:id");
	assert.deepEqual(totals(metricPoints), { requests: 1, errors: 0, durationMs: 40 });
});

test("an error recorded inside a counted request rides it, even when the response succeeded", () => {
	// The handler caught the error, recorded it on a child span, returned 200.
	const { occurrences, metricPoints } = normalizeTraces(batch([
		{ id: 2, parent: 1, name: "cache.get", start: 2, end: 5, error: true, events: [exception(4, "Error", "cache down")] },
		{ id: 1, name: "GET /api/feed", kind: SERVER, end: 40, attributes: { "http.route": "/api/feed", "http.response.status_code": 200 } },
	]));
	assert.equal(occurrences.length, 1);
	assert.deepEqual(totals(metricPoints), { requests: 1, errors: 1, durationMs: 40 });
});

test("the outer span keeps its route when it already has a template", () => {
	const spans = nextRequest();
	// The HTTP span got the template too (a router instrumentation, or
	// runtime-node's Express hook): equally good, the outermost span wins.
	spans[2] = { ...spans[2]!, attributes: { ...spans[2]!.attributes, "http.route": "/blog/:slug" } };
	const { metricPoints } = normalizeTraces(batch(spans));
	assert.equal(metricPoints.length, 1);
	assert.equal(metricPoints[0]?.route, "/blog/:slug");
});

test("two requests in one batch are two", () => {
	const { metricPoints } = normalizeTraces(batch([
		...nextRequest({ base: 0, traceId: "a".repeat(32) }),
		...nextRequest({ base: 10, traceId: "b".repeat(32), path: "/blog/second-post" }),
	]));
	assert.deepEqual(totals(metricPoints), { requests: 2, errors: 0, durationMs: 200 });
	assert.equal(metricPoints.length, 1);
	assert.equal(metricPoints[0]?.route, "/blog/[slug]");
});

test("two requests sharing a trace id (a browser page's fetches) are two", () => {
	// Each server span's parent is the browser's span, not in the batch.
	const { metricPoints } = normalizeTraces(batch([
		{ id: 1, parent: 100, name: "GET /api/a", kind: SERVER, attributes: { "http.route": "/api/a" } },
		{ id: 2, parent: 101, name: "GET /api/b", kind: SERVER, attributes: { "http.route": "/api/b" } },
	]));
	assert.equal(totals(metricPoints).requests, 2);
});

// ── Calls between services ────────────────────────────────────────────────

test("a service called by another, in one batch: one request per service", () => {
	const { metricPoints } = normalizeTraces({
		resourceSpans: [
			resourceSpans([
				{ id: 2, parent: 1, name: "GET", kind: CLIENT, start: 5, end: 40 },
				{ id: 1, name: "GET /checkout", kind: SERVER, end: 50, attributes: { "http.route": "/checkout" } },
			], "frontend"),
			resourceSpans([
				{ id: 3, parent: 2, name: "GET /prices", kind: SERVER, start: 10, end: 35, attributes: { "http.route": "/prices" } },
			], "pricing"),
		],
	});
	assert.deepEqual(byService(metricPoints), { frontend: 1, pricing: 1 });
});

test("a server span directly under another service's server span is that service's own request", () => {
	// No client instrumentation in the caller: the link crosses processes.
	const { metricPoints } = normalizeTraces({
		resourceSpans: [
			resourceSpans([{ id: 1, name: "GET /checkout", kind: SERVER, attributes: { "http.route": "/checkout" } }], "frontend"),
			resourceSpans([{ id: 2, parent: 1, name: "GET /prices", kind: SERVER, attributes: { "http.route": "/prices" } }], "pricing"),
		],
	});
	assert.deepEqual(byService(metricPoints), { frontend: 1, pricing: 1 });
});

test("a service calling itself over HTTP serves two requests", () => {
	const { metricPoints } = normalizeTraces(batch([
		{ id: 1, name: "GET /page", kind: SERVER, attributes: { "http.route": "/page" } },
		{ id: 2, parent: 1, name: "GET", kind: CLIENT },
		{ id: 3, parent: 2, name: "GET /api/data", kind: SERVER, attributes: { "http.route": "/api/data" } },
	]));
	assert.equal(totals(metricPoints).requests, 2);
	assert.deepEqual(metricPoints.map((p) => p.route).sort(), ["/api/data", "/page"]);
});

test("another instance of the same service is another process", () => {
	const { metricPoints } = normalizeTraces({
		resourceSpans: [
			resourceSpans([{ id: 1, name: "GET /a", kind: SERVER }], "api", { "service.instance.id": "i-1" }),
			resourceSpans([{ id: 2, parent: 1, name: "GET /b", kind: SERVER }], "api", { "service.instance.id": "i-2" }),
		],
	});
	assert.equal(totals(metricPoints).requests, 2);
});

// ── Across batches ────────────────────────────────────────────────────────

test("a server span whose parent is in another batch counts in its own", () => {
	const [render, nextSpan, httpSpan] = nextRequest();
	// The exporter's timer split the request: Next's spans ended first.
	const first = normalizeTraces(batch([render!, nextSpan!]));
	assert.equal(totals(first.metricPoints).requests, 1);
	assert.equal(first.metricPoints[0]?.route, "/blog/[slug]");
	// The HTTP span arrives in the next batch and counts there too: a batch
	// cannot tell a parent exported elsewhere from a remote caller.
	const second = normalizeTraces(batch([httpSpan!]));
	assert.equal(totals(second.metricPoints).requests, 1);
});

// ── Metric feed vs spans ──────────────────────────────────────────────────

const METRICS_WIRED = { "autter.metrics_wired": true };

function durationMetrics(
	service: string,
	instruments: Array<{ name: string; count: number; sum: number }>,
	resource: Record<string, Value> = {},
): OtlpMetricsRequest {
	return {
		resourceMetrics: [{
			resource: { attributes: kv({ "service.name": service, "deployment.environment": "production", ...resource }) },
			scopeMetrics: [{
				metrics: instruments.map((instrument) => ({
					name: instrument.name,
					histogram: {
						aggregationTemporality: 1,
						dataPoints: [{
							attributes: kv({ "http.route": "/api/users/:id", "http.request.method": "GET", "http.response.status_code": 200 }),
							startTimeUnixNano: at(0),
							timeUnixNano: at(60_000),
							count: instrument.count,
							sum: instrument.sum,
							explicitBounds: [100],
							bucketCounts: [instrument.count, 0],
						}],
					},
				})),
			}],
		}],
	};
}

const expressRequest: SpanSpec[] = [{
	id: 1,
	name: "GET /api/users/:id",
	kind: SERVER,
	end: 40,
	attributes: { "http.route": "/api/users/:id", "http.request.method": "GET", "http.response.status_code": 200 },
}];

test("a resource whose metric feed counts its requests (autter.metrics_wired) gets no span-fed count", () => {
	// @autter/runtime-node: a head-sampled request's span, and the delta
	// http.server.duration histogram that counted the same request.
	const traces = normalizeTraces(batch(expressRequest, "api", METRICS_WIRED));
	const metrics = normalizeMetrics(durationMetrics("api", [{ name: "http.server.duration", count: 1, sum: 40 }], METRICS_WIRED));
	assert.deepEqual(traces.metricPoints, []);
	assert.deepEqual(totals([...traces.metricPoints, ...metrics]), { requests: 1, errors: 0, durationMs: 40 });
});

test("the flag also holds for Next.js's nested server spans", () => {
	const { metricPoints } = normalizeTraces(batch(nextRequest(), "web", METRICS_WIRED));
	assert.deepEqual(metricPoints, []);
});

test("an error in a metrics-wired request is one error event, not a span-fed request", () => {
	// The metric feed counts the request; the occurrence is not on a
	// span-fed request, so it is an event of its own, as tail-retained
	// error traces always were. The errored server span adds nothing.
	const spans: SpanSpec[] = [
		{ id: 2, parent: 1, name: "db.query", error: true, events: [exception(5, "QueryError", "relation missing")] },
		{ ...expressRequest[0]!, error: true, attributes: { ...expressRequest[0]!.attributes, "http.response.status_code": 500 } },
	];
	const { occurrences, metricPoints } = normalizeTraces(batch(spans, "api", METRICS_WIRED));
	assert.equal(occurrences.length, 1);
	assert.deepEqual(totals(metricPoints), { requests: 1, errors: 1, durationMs: 0 });
});

test("without the flag, server spans are the fallback request count", () => {
	// Plain OTel with no (or cumulative) request metrics.
	const { metricPoints } = normalizeTraces(batch(expressRequest, "api"));
	assert.deepEqual(totals(metricPoints), { requests: 1, errors: 0, durationMs: 40 });
});

test("a resource sending both HTTP duration instruments counts each request once", () => {
	// OTEL_SEMCONV_STABILITY_OPT_IN=http/dup: both instruments see every request.
	const points = normalizeMetrics(durationMetrics("api", [
		{ name: "http.server.duration", count: 3, sum: 120 },
		{ name: "http.server.request.duration", count: 3, sum: 0.12 },
	]));
	assert.deepEqual(totals(points), { requests: 3, errors: 0, durationMs: 120 });
});

test("tail-retained request spans still add no span-fed count", () => {
	const spans = nextRequest().map((s) => ({ ...s, attributes: { ...s.attributes, "autter.tail_retained": true } }));
	const { metricPoints } = normalizeTraces(batch(spans));
	assert.deepEqual(metricPoints, []);
});

// ── requestMembership ─────────────────────────────────────────────────────

test("requestMembership: outermost server span, depth, and malformed parent cycles", () => {
	const link = (spanId: string, parentSpanId: string | null, kind: string, process = "p") =>
		({ traceId: "t", spanId, parentSpanId, kind, process });
	const { requestOf, depth } = requestMembership([
		link("render", "next", "internal"),
		link("next", "mw", "server"),
		link("mw", "http", "internal"),
		link("http", "remote", "server"),
		link("worker", null, "internal"),
		link("x", "y", "server"),
		link("y", "x", "internal"),
	]);
	assert.deepEqual(requestOf.slice(0, 5), [3, 3, 3, 3, -1]);
	assert.deepEqual(depth.slice(0, 5), [3, 2, 1, 0, 0]);
	// A parent cycle terminates; each span still gets an answer.
	assert.ok(requestOf[5]! >= -1 && requestOf[6]! >= -1);
});
