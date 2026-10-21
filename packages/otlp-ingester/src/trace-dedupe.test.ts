import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTraces, type OtlpTraceRequest } from "./normalize-otlp.js";
import type { RuntimeMetricPoint } from "./types.js";

/**
 * One thrown error recorded on several spans of a trace is one occurrence
 * (trace-dedupe.ts), and the usage rollups count it once.
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

function exception(
	ms: number,
	fields: { type: string; message: string; stack?: string },
	extra: Record<string, Value> = {},
) {
	return {
		name: "exception",
		timeUnixNano: at(ms),
		attributes: kv({
			"exception.type": fields.type,
			"exception.message": fields.message,
			...(fields.stack ? { "exception.stacktrace": fields.stack } : {}),
			...extra,
		}),
	};
}

interface SpanSpec {
	id: number;
	parent?: number;
	name: string;
	kind?: number;
	start?: number;
	end?: number;
	error?: boolean;
	attributes?: Record<string, Value>;
	events?: ReturnType<typeof exception>[];
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

function batch(spans: SpanSpec[], service = "web"): OtlpTraceRequest {
	return {
		resourceSpans: [
			{
				resource: { attributes: kv({ "service.name": service, "deployment.environment": "production" }) },
				scopeSpans: [{ spans: spans.map(span) }],
			},
		],
	};
}

function totals(points: RuntimeMetricPoint[]) {
	return points.reduce(
		(acc, p) => ({ requests: acc.requests + p.requestCount, errors: acc.errors + p.errorCount }),
		{ requests: 0, errors: 0 },
	);
}

const ROUTE_STACK = [
	"Error: boom 42",
	"    at GET (/app/.next/server/app/api/boom/route.js:12:11)",
	"    at async AppRouteRouteModule.do (/app/node_modules/next/dist/compiled/next-server/app-route.runtime.prod.js:6:38782)",
	"    at async loadOrder (/app/.next/server/chunks/orders.js:40:5)",
	"    at async /app/node_modules/next/dist/server/base-server.js:1200:3",
].join("\n");

// ── Next.js 15/16 ─────────────────────────────────────────────────────────

/** A route handler error as Next + @autter/runtime-node export it, in span
 * end order: Next's "executing api route" span (recordException), Next's
 * own BaseServer.handleRequest server span (errored, no event), then the
 * HTTP server span with runtime-node's capture and onRequestError context.
 * Error traces are exported by tail retention. */
function nextRouteError(): SpanSpec[] {
	return [
		{
			id: 3,
			parent: 2,
			name: "executing api route (app) /api/boom",
			start: 5,
			end: 10,
			error: true,
			attributes: {
				"next.span_name": "executing api route (app) /api/boom",
				"next.span_type": "AppRouteRouteHandlers.runHandler",
				"next.route": "/api/boom",
				"autter.tail_retained": true,
			},
			events: [exception(10, { type: "Error", message: "boom 42", stack: ROUTE_STACK })],
		},
		{
			id: 2,
			parent: 1,
			name: "GET /api/boom",
			kind: 2,
			start: 2,
			end: 14,
			error: true,
			attributes: {
				"next.span_type": "BaseServer.handleRequest",
				"http.status_code": 500,
				"autter.tail_retained": true,
			},
		},
		{
			id: 1,
			name: "GET",
			kind: 2,
			start: 0,
			end: 15,
			error: true,
			attributes: {
				"http.route": "/api/boom",
				"http.request.method": "GET",
				"http.response.status_code": 500,
				"autter.severity": "error",
				"next.route_path": "/api/boom",
				"next.router_kind": "App Router",
				"next.route_type": "route",
				"autter.tail_retained": true,
			},
			events: [exception(12, { type: "Error", message: "boom 42", stack: ROUTE_STACK })],
		},
	];
}

test("Next.js: the Autter capture and Next's recordException of one error are one occurrence", () => {
	const { occurrences, occurrenceBatchIndexes, metricPoints } = normalizeTraces(batch(nextRouteError()));

	assert.equal(occurrences.length, 1);
	const [error] = occurrences;
	assert.ok(error);
	// The Autter capture on the HTTP server span is kept: its time, route and
	// position (signals: Next's exception 0, the status-only span 1, the
	// HTTP span's exception 2), so its deterministic id is the one it had.
	assert.deepEqual(occurrenceBatchIndexes, [2]);
	assert.equal(error.occurredAt.getTime(), Number(BASE_MS) + 12);
	assert.equal(error.errorType, "Error");
	assert.equal(error.message, "boom 42");
	assert.equal(error.stack, ROUTE_STACK);
	assert.equal(error.route, "/api/boom");
	assert.equal(error.method, "GET");
	assert.equal(error.statusCode, 500);
	// Nothing lost: runtime-next's context from the HTTP span, Next's span
	// fields from the other recording.
	assert.equal(error.attributes?.["next.route_path"], "/api/boom");
	assert.equal(error.attributes?.["next.router_kind"], "App Router");
	assert.equal(error.attributes?.["next.span_type"], "AppRouteRouteHandlers.runHandler");
	assert.equal(error.attributes?.["autter.merged_recordings"], 2);
	// Nothing from the spans: tail retention exported them, so the metric
	// feed counts this request and its 500 (before the dedupe: three events,
	// two exceptions and the BaseServer span's HttpServerError; before EI-26:
	// one event, also counted as a request).
	assert.deepEqual(totals(metricPoints), { requests: 0, errors: 0 });
});

test("merging fills the kept recording's gaps, declared error fields included", () => {
	const spans = nextRouteError();
	// Plain OTel: the user declared the code on Next's span.
	spans[0]!.attributes = { ...spans[0]!.attributes, "autter.error.code": "orders.load_failed", "autter.error.why": "orders DB down" };
	const { occurrences } = normalizeTraces(batch(spans));
	assert.equal(occurrences.length, 1);
	const [error] = occurrences;
	assert.equal(error?.errorCode, "orders.load_failed");
	assert.equal(error?.why, "orders DB down");
	assert.equal(error?.attributes?.["next.route_path"], "/api/boom");
});

test("OTel's recordException type for an error with a code (Prisma P2002) still merges", () => {
	const message = "Unique constraint failed on the fields: (`email`)";
	const stack = [
		`PrismaClientKnownRequestError: ${message}`,
		"    at createUser (/app/.next/server/app/api/users/route.js:9:20)",
		"    at async POST (/app/.next/server/app/api/users/route.js:30:5)",
	].join("\n");
	const { occurrences } = normalizeTraces(batch([
		{
			id: 2,
			parent: 1,
			name: "executing api route (app) /api/users",
			error: true,
			// @opentelemetry/sdk-trace-base: exception.type = String(error.code)
			events: [exception(10, { type: "P2002", message, stack })],
		},
		{
			id: 1,
			name: "POST",
			kind: 2,
			error: true,
			attributes: { "http.route": "/api/users", "http.response.status_code": 500, "autter.severity": "error" },
			events: [exception(11, { type: "PrismaClientKnownRequestError", message, stack })],
		},
	]));
	assert.equal(occurrences.length, 1);
	assert.equal(occurrences[0]?.errorType, "PrismaClientKnownRequestError");
});

// ── Status-only occurrences ───────────────────────────────────────────────

test("express: a status-only 500 on the http span and the middleware's exception → the exception", () => {
	const stack = [
		"Error: Database Error",
		"    at listGmails (/app/src/routes/gmails.js:18:11)",
		"    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)",
	].join("\n");
	const { occurrences, metricPoints } = normalizeTraces(batch([
		{
			id: 2,
			parent: 1,
			name: "request handler - /api/gmails",
			error: true,
			attributes: { "express.type": "request_handler" },
			events: [exception(5, { type: "Error", message: "Database Error", stack })],
		},
		{
			id: 1,
			name: "POST /api/gmails",
			kind: 2,
			error: true,
			attributes: {
				"http.route": "/api/gmails",
				"http.request.method": "POST",
				"http.response.status_code": 500,
			},
		},
	]));
	assert.equal(occurrences.length, 1);
	assert.equal(occurrences[0]?.errorType, "Error");
	assert.equal(occurrences[0]?.message, "Database Error");
	assert.equal(occurrences[0]?.route, "/api/gmails");
	// One request, one error. The exception sits on a span inside the
	// request the server span counts, so it rides that request instead of
	// adding an event of its own (before EI-26: 2 requests, 2 errors for one
	// request); the dropped HttpServerError never added one either.
	assert.deepEqual(totals(metricPoints), { requests: 1, errors: 1 });
});

test("an errored ancestor without an event adds no stackless SpanError", () => {
	const { occurrences, metricPoints } = normalizeTraces(batch([
		{
			id: 3,
			parent: 2,
			name: "db.query",
			error: true,
			events: [exception(5, { type: "QueryError", message: "relation missing" })],
		},
		{ id: 2, parent: 1, name: "OrdersService.list", error: true },
		{ id: 1, name: "worker.tick", error: true },
	]));
	assert.deepEqual(occurrences.map((o) => o.errorType), ["QueryError"]);
	// A worker, no request: one error, no request (EI-26).
	assert.deepEqual(totals(metricPoints), { requests: 0, errors: 1 });
});

test("a status-only error alone is kept", () => {
	const { occurrences, metricPoints } = normalizeTraces(batch([
		{
			id: 1,
			name: "GET /health",
			kind: 2,
			error: true,
			attributes: { "http.route": "/health", "http.response.status_code": 503 },
		},
	]));
	assert.deepEqual(occurrences.map((o) => o.errorType), ["HttpServerError"]);
	assert.deepEqual(totals(metricPoints), { requests: 1, errors: 1 });
});

test("status-only errors are kept when nothing on their chain explains them", () => {
	const { occurrences } = normalizeTraces({
		resourceSpans: [
			batch([
				// A warning and a handled error do not explain a failure.
				{ id: 1, name: "jobs.run", error: true },
				{
					id: 2,
					parent: 1,
					name: "Message",
					error: true,
					attributes: { "autter.severity": "warning" },
					events: [exception(5, { type: "Message", message: "slow path" }, { "autter.severity": "warning" })],
				},
				{
					id: 3,
					parent: 1,
					name: "retry",
					events: [exception(6, { type: "Error", message: "flaky" }, { "autter.handled": true })],
				},
				// An error on a sibling branch is not this span's cause.
				{ id: 10, name: "root" },
				{ id: 11, parent: 10, name: "cache.get", error: true },
				{ id: 12, parent: 10, name: "render", events: [exception(7, { type: "Error", message: "render failed" })] },
				// Parent exported in another batch: no visible link.
				{ id: 20, parent: 99, name: "orphan", error: true },
			]).resourceSpans![0]!,
			// Another service in the same trace (an OTel collector batching
			// both): its failure stays its own.
			batch([
				{ id: 30, parent: 12, name: "GET /render", kind: 2, error: true, attributes: { "http.response.status_code": 500 } },
			], "renderer").resourceSpans![0]!,
		],
	});
	const statusOnly = occurrences.filter((o) => o.errorType === "SpanError" || o.errorType === "HttpServerError");
	assert.deepEqual(
		statusOnly.map((o) => o.message).sort(),
		["HTTP GET /render returned 500", "cache.get failed", "jobs.run failed", "orphan failed"],
	);
});

// ── Separate errors stay separate ─────────────────────────────────────────

test("two different errors in one trace are two occurrences", () => {
	const { occurrences } = normalizeTraces(batch([
		{ id: 2, parent: 1, name: "inner", error: true, events: [exception(5, { type: "TypeError", message: "x is undefined", stack: ROUTE_STACK })] },
		{ id: 1, name: "GET /a", kind: 2, error: true, attributes: { "autter.severity": "error" }, events: [exception(6, { type: "Error", message: "boom 42", stack: ROUTE_STACK })] },
	]));
	assert.equal(occurrences.length, 2);
});

test("the same type and message thrown from different places are two occurrences", () => {
	const fromValidate = "Error: invalid input\n    at validate (/app/src/validate.js:4:9)\n    at handler (/app/src/handler.js:10:3)";
	const fromParse = "Error: invalid input\n    at parse (/app/src/parse.js:22:7)\n    at handler (/app/src/handler.js:14:3)";
	const { occurrences } = normalizeTraces(batch([
		{ id: 2, parent: 1, name: "parse", error: true, events: [exception(5, { type: "Error", message: "invalid input", stack: fromParse })] },
		{ id: 1, name: "POST /submit", kind: 2, error: true, events: [exception(6, { type: "Error", message: "invalid input", stack: fromValidate })] },
	]));
	assert.equal(occurrences.length, 2);
});

// ── Retry loops ───────────────────────────────────────────────────────────

const RETRY_STACK = "Error: connect ETIMEDOUT\n    at callUpstream (/app/src/upstream.js:31:13)\n    at withRetry (/app/src/retry.js:8:20)";

test("a retry loop capturing each attempt on one span keeps every attempt", () => {
	const { occurrences, metricPoints } = normalizeTraces(batch([
		{
			id: 1,
			name: "sync.run",
			events: [0, 10, 20].map((ms) =>
				exception(ms, { type: "Error", message: "connect ETIMEDOUT", stack: RETRY_STACK }, { "autter.handled": true })),
		},
	]));
	assert.equal(occurrences.length, 3);
	// Three errors outside any request; no requests (EI-26).
	assert.deepEqual(totals(metricPoints), { requests: 0, errors: 3 });
});

test("a retry loop with a span per attempt pairs each attempt with its own parent capture", () => {
	const attempts = [0, 100, 200];
	const { occurrences, occurrenceBatchIndexes } = normalizeTraces(batch([
		...attempts.map((ms, i) => ({
			id: 10 + i,
			parent: 1,
			name: "GET upstream",
			kind: 3,
			start: ms,
			end: ms + 5,
			error: true,
			events: [exception(ms + 5, { type: "Error", message: "connect ETIMEDOUT", stack: RETRY_STACK })],
		})),
		{
			id: 1,
			name: "sync.run",
			end: 300,
			attributes: { "autter.severity": "error" },
			events: attempts.map((ms) =>
				exception(ms + 6, { type: "Error", message: "connect ETIMEDOUT", stack: RETRY_STACK }, { "autter.handled": true })),
		},
	]));
	assert.equal(occurrences.length, 3);
	assert.deepEqual(occurrences.map((o) => o.attributes?.["autter.merged_recordings"]), [2, 2, 2]);
	// Each kept recording is the parent's capture of that attempt.
	assert.deepEqual(occurrenceBatchIndexes, [3, 4, 5]);
	assert.deepEqual(
		occurrences.map((o) => o.occurredAt.getTime() - Number(BASE_MS)),
		[6, 106, 206],
	);
});

test("recordings of the same error far apart in time stay separate", () => {
	const { occurrences } = normalizeTraces(batch([
		{ id: 2, parent: 1, name: "attempt", error: true, events: [exception(0, { type: "Error", message: "connect ETIMEDOUT", stack: RETRY_STACK })] },
		{ id: 1, name: "sync.run", end: 40_000, error: true, events: [exception(30_000, { type: "Error", message: "connect ETIMEDOUT", stack: RETRY_STACK })] },
	]));
	assert.equal(occurrences.length, 2);
});

// ── Stack formats ─────────────────────────────────────────────────────────

test("Python: a traceback recorded higher up (more frames) is the same error", () => {
	const inner = [
		"Traceback (most recent call last):",
		'  File "/app/billing/service.py", line 20, in charge',
		"    raise PaymentError(\"card declined\")",
		"billing.service.PaymentError: card declined",
	].join("\n");
	const outer = [
		"Traceback (most recent call last):",
		'  File "/app/app.py", line 10, in handle',
		"    return checkout(request)",
		'  File "/app/views.py", line 44, in checkout',
		"    charge(order)",
		'  File "/app/billing/service.py", line 20, in charge',
		"    raise PaymentError(\"card declined\")",
		"billing.service.PaymentError: card declined",
	].join("\n");
	const { occurrences } = normalizeTraces(batch([
		{ id: 2, parent: 1, name: "charge", error: true, events: [exception(5, { type: "PaymentError", message: "card declined", stack: inner })] },
		{ id: 1, name: "POST /checkout", kind: 2, error: true, attributes: { "http.response.status_code": 500 }, events: [exception(6, { type: "PaymentError", message: "card declined", stack: outer })] },
	], "checkout-py"));
	assert.equal(occurrences.length, 1);
	assert.equal(occurrences[0]?.stack, outer);
});

// ── Determinism ───────────────────────────────────────────────────────────

test("a re-sent batch dedupes identically", () => {
	const first = normalizeTraces(batch(nextRouteError()));
	const second = normalizeTraces(batch(nextRouteError()));
	assert.deepEqual(second.occurrences, first.occurrences);
	assert.deepEqual(second.occurrenceBatchIndexes, first.occurrenceBatchIndexes);
	assert.deepEqual(second.metricPoints, first.metricPoints);
});
