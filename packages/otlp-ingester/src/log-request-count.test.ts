import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
import {
	EdgeLatencyAggregator,
	edgeLatencySamples,
	emptyEdgeLatencyDrops,
	type EdgeLatencyDrops,
} from "./edge-latency.js";
import type { LatencyHistogram } from "./latency.js";
import { logPromotionCandidates, logRollups } from "./log-promotion.js";
import { normalizeLogs, type OtlpLogsRequest } from "./logs.js";
import { createIngesterApp } from "./server.js";
import type { RuntimeMetricPoint, RuntimeOccurrence } from "./types.js";

/**
 * Requests of senders whose request summary is the only feed that sees them
 * (`@autter/runtime-edge`: no spans, no `http.server.duration`) are counted
 * from that summary — once, with its failure once — when the records say so
 * (`autter.request.counted_by = "summary"`). Records are shaped as
 * runtime-edge encodes them (OTLP/JSON, numbers as doubleValue).
 */

type Value = string | number | boolean;

function kv(attributes: Record<string, Value>) {
	return Object.entries(attributes).map(([key, value]) => ({
		key,
		value:
			typeof value === "string"
				? { stringValue: value }
				: typeof value === "boolean"
					? { boolValue: value }
					: { doubleValue: value },
	}));
}

const MINUTE = 1_760_000_040_000; // a minute boundary
const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n);

interface EdgeRequest {
	route: string;
	status: number;
	outcome: string;
	/** Captured exceptions (promoted error records). */
	errors?: number;
	/** null: no `autter.operation.duration_ms` at all. */
	durationMs?: number | null;
	counted?: boolean;
	at?: number;
	/** No timeUnixNano / observedTimeUnixNano. */
	untimed?: boolean;
	requestId?: string;
}

/** The records runtime-edge sends for one request: its error records, then its summary. */
function edgeRecords(request: EdgeRequest) {
	const counted = request.counted !== false;
	const base = {
		"autter.request.id": request.requestId ?? `req-${request.route.replace(/\W/g, "")}-0001`,
		"http.request.method": "GET",
		"http.route": request.route,
		...(counted ? { "autter.request.counted_by": "summary" } : {}),
	};
	const at = request.at ?? MINUTE + 1_000;
	const errors = Array.from({ length: request.errors ?? 0 }, (_, i) => ({
		timeUnixNano: nanos(at),
		severityNumber: 17,
		severityText: "ERROR",
		body: { stringValue: `failure ${i}` },
		attributes: kv({
			...base,
			"autter.capture.mode": "log",
			"exception.type": "Error",
			"exception.message": `failure ${i}`,
			"exception.stacktrace": `Error: failure ${i}\n    at handler (worker.js:1:1)`,
		}),
	}));
	const summary = {
		...(request.untimed ? {} : { timeUnixNano: nanos(at) }),
		severityNumber: request.outcome === "failed" ? 17 : 9,
		severityText: request.outcome === "failed" ? "ERROR" : "INFO",
		body: { stringValue: `GET ${request.route}: ${request.outcome}` },
		attributes: kv({
			...base,
			"autter.event.type": "operation",
			"autter.operation.kind": "request",
			"autter.operation.outcome": request.outcome,
			...(request.durationMs === null ? {} : { "autter.operation.duration_ms": request.durationMs ?? 10 }),
			"http.response.status_code": request.status,
			"autter.request.aborted": false,
			...(counted && (request.errors ?? 0) > 0 ? { "autter.request.error_reported": true } : {}),
		}),
	};
	return [...errors, summary];
}

function logsRequest(records: unknown[], resource: Record<string, Value> = { "service.name": "edge-api" }): OtlpLogsRequest {
	return { resourceLogs: [{ resource: { attributes: kv(resource) }, scopeLogs: [{ scope: { name: "autter-runtime" }, logRecords: records }] }] } as OtlpLogsRequest;
}

/** What /v1/logs adds to runtime_metrics_1m, without fingerprinting or dedupe
 * (every candidate promoted — edge records carry no trace id). */
function rollupsOf(request: OtlpLogsRequest): RuntimeMetricPoint[] {
	const rows = normalizeLogs(request);
	return logRollups(rows, logPromotionCandidates(rows) as RuntimeOccurrence[]);
}

function byRoute(points: RuntimeMetricPoint[]) {
	const out: Record<string, { requests: number; errors: number; durationMs: number }> = {};
	for (const p of points) {
		const row = (out[p.route] ??= { requests: 0, errors: 0, durationMs: 0 });
		row.requests += p.requestCount;
		row.errors += p.errorCount;
		row.durationMs += p.durationSumMs;
	}
	return out;
}

test("an edge request is one request; it fails once however many errors it reported", () => {
	const points = rollupsOf(
		logsRequest([
			...edgeRecords({ route: "/ok", status: 200, outcome: "succeeded", durationMs: 12 }),
			...edgeRecords({ route: "/ok", status: 200, outcome: "succeeded", durationMs: 8 }),
			// Thrown out of the handler: one promoted record, summary failed.
			...edgeRecords({ route: "/throw", status: 500, outcome: "failed", errors: 1 }),
			// Two captured exceptions, a 200 response: one failed request.
			...edgeRecords({ route: "/handled", status: 200, outcome: "succeeded", errors: 2 }),
			// A 503 answered without an exception.
			...edgeRecords({ route: "/unavailable", status: 503, outcome: "failed" }),
			// rt.outcome("failed") on a 200.
			...edgeRecords({ route: "/declared", status: 200, outcome: "failed" }),
			// An expected coded error: degraded, 402, nothing reported.
			...edgeRecords({ route: "/declined", status: 402, outcome: "degraded" }),
			...edgeRecords({ route: "/gone", status: 200, outcome: "cancelled" }),
		]),
	);
	assert.deepEqual(byRoute(points), {
		"/ok": { requests: 2, errors: 0, durationMs: 20 },
		"/throw": { requests: 1, errors: 1, durationMs: 10 },
		"/handled": { requests: 1, errors: 1, durationMs: 10 },
		"/unavailable": { requests: 1, errors: 1, durationMs: 10 },
		"/declared": { requests: 1, errors: 1, durationMs: 10 },
		"/declined": { requests: 1, errors: 0, durationMs: 10 },
		"/gone": { requests: 1, errors: 0, durationMs: 10 },
	});
	for (const p of points) {
		assert.equal(p.service, "edge-api");
		assert.equal(p.environment, "production");
		assert.equal(p.release, null);
		assert.equal(p.bucketAt.getTime(), MINUTE);
	}
});

test("a request split over two batches is still counted once, from its summary", () => {
	const records = edgeRecords({ route: "/throw", status: 500, outcome: "failed", errors: 2 });
	const first = byRoute(rollupsOf(logsRequest(records.slice(0, 1))));
	const second = byRoute(rollupsOf(logsRequest(records.slice(1))));
	assert.deepEqual(first, {});
	assert.deepEqual(second, { "/throw": { requests: 1, errors: 1, durationMs: 10 } });
});

test("unmarked records count as before: summaries add nothing, promoted errors one error each", () => {
	// runtime-edge with countRequests: false, and runtime-node / runtime-next
	// summaries (their requests are counted by the histogram or the spans).
	const edge = rollupsOf(
		logsRequest([
			...edgeRecords({ route: "/mw", status: 200, outcome: "succeeded", counted: false }),
			...edgeRecords({ route: "/mw", status: 500, outcome: "failed", errors: 2, counted: false }),
		]),
	);
	assert.deepEqual(byRoute(edge), { "/mw": { requests: 0, errors: 2, durationMs: 0 } });
	const nodeSummary = rollupsOf(
		logsRequest(
			edgeRecords({ route: "/orders/:id", status: 500, outcome: "failed", counted: false }),
			{ "service.name": "api", "telemetry.distro.name": "@autter/runtime-node", "telemetry.distro.version": "1.8.0" },
		),
	);
	assert.deepEqual(nodeSummary, []);
	// The mark counts only on a request summary; an operation summary (a job)
	// carrying it adds no request.
	const operation = rollupsOf(
		logsRequest([
			{
				timeUnixNano: nanos(MINUTE),
				body: { stringValue: "job" },
				attributes: kv({
					"autter.event.type": "operation",
					"autter.operation.kind": "operation",
					"autter.operation.outcome": "failed",
					"autter.request.counted_by": "summary",
				}),
			},
		]),
	);
	assert.deepEqual(operation, []);
});

test("counted summaries land on their own route, minute and release, next to errors outside requests", () => {
	const points = rollupsOf(
		logsRequest(
			[
				...edgeRecords({ route: "/orders/1234", status: 200, outcome: "succeeded", at: MINUTE + 59_000 }),
				...edgeRecords({ route: "/orders/5678", status: 500, outcome: "failed", errors: 1, at: MINUTE + 60_000 }),
				// captureEdgeException from a cron handler: no request, one error.
				{
					timeUnixNano: nanos(MINUTE + 60_000),
					severityNumber: 17,
					body: { stringValue: "sync failed" },
					attributes: kv({ "autter.capture.mode": "log", "exception.type": "Error", "exception.message": "sync failed" }),
				},
			],
			{ "service.name": "edge-api", "service.version": "abc123", "deployment.environment.name": "staging" },
		),
	);
	const rows = points
		.map((p) => [p.route, p.bucketAt.getTime() - MINUTE, p.requestCount, p.errorCount, p.release, p.environment])
		.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]));
	assert.deepEqual(rows, [
		["", 60_000, 0, 1, "abc123", "staging"],
		["/orders/:id", 0, 1, 0, "abc123", "staging"],
		["/orders/:id", 60_000, 1, 1, "abc123", "staging"],
	]);
});

test("/v1/logs writes counted edge requests to runtime_metrics_1m", async () => {
	const inserted: Record<string, Array<Record<string, unknown>>> = {};
	const ch = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const query = new URL(req.url!, "http://localhost").searchParams.get("query") ?? "";
			const insert = /INSERT INTO autter_runtime\.(\w+)/.exec(query);
			if (insert) {
				(inserted[insert[1]!] ??= []).push(
					...body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
				);
			}
			res.end();
		});
	});
	await new Promise<void>((resolve) => ch.listen(0, "127.0.0.1", resolve));
	const ingester = createIngesterApp(config(`http://127.0.0.1:${(ch.address() as AddressInfo).port}`));
	const app = ingester.app.listen(0, "127.0.0.1");
	await new Promise((resolve) => app.once("listening", resolve));
	const now = Date.now();
	const post = (body: string) => fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/v1/logs`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer server" },
		body,
	});
	try {
		// runtime-edge exports per request: two batches, one minute.
		const first = JSON.stringify(logsRequest(edgeRecords({ route: "/ok", status: 200, outcome: "succeeded", at: now })));
		const res = await post(first);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("x-autter-ingest") ?? "", / latency_summaries=1 /);
		const second = await post(JSON.stringify(logsRequest(edgeRecords({ route: "/ok", status: 500, outcome: "failed", errors: 1, at: now }))));
		assert.equal(second.status, 200);
		// A retried batch adds nothing twice.
		const retry = await post(first);
		assert.equal(retry.status, 200);
		assert.equal(inserted.runtime_latency_histograms, undefined, "the minute is written once it is over");
		await ingester.edgeLatency.stop();
		assert.equal(inserted.runtime_error_occurrences?.length, 1);
		const metrics = inserted.runtime_metrics_1m ?? [];
		assert.equal(metrics.reduce((n, row) => n + Number(row.request_count), 0), 2);
		assert.equal(metrics.reduce((n, row) => n + Number(row.error_count), 0), 1);
		assert.deepEqual([...new Set(metrics.map((row) => row.route))], ["/ok"]);
		// …and to the latency histograms endpoint regression detection reads:
		// one point for the minute, across both batches.
		const histograms = inserted.runtime_latency_histograms ?? [];
		assert.equal(histograms.length, 1);
		assert.equal(histograms[0]!.request_count, 2);
		assert.equal(histograms[0]!.error_count, 1);
		assert.equal(histograms[0]!.method, "GET");
		assert.equal(histograms[0]!.route, "/ok");
	} finally {
		await close(app);
		await close(ch);
	}
});

const TENANT = { orgId: "org-1", repositoryId: "repo-1" } as Parameters<EdgeLatencyAggregator["add"]>[0];

/** An aggregator on a fake clock that records what it writes. */
function aggregator(options: { failWrites?: number; routesPerService?: number } = {}) {
	const clock = { now: MINUTE + 1_000 };
	const written: LatencyHistogram[][] = [];
	const attempts: string[][] = [];
	let failures = options.failWrites ?? 0;
	const agg = new EdgeLatencyAggregator({
		now: () => clock.now,
		routesPerService: options.routesPerService,
		log: () => {},
		write: async (_ctx, points) => {
			attempts.push(points.map((p) => p.pointId));
			if (failures-- > 0) throw new Error("clickhouse down");
			written.push(points.map((p) => ({ ...p, counts: [...p.counts] })));
		},
	});
	const add = (records: unknown[], drops: EdgeLatencyDrops = emptyEdgeLatencyDrops(), resource?: Record<string, Value>) =>
		agg.add(TENANT, edgeLatencySamples(normalizeLogs(logsRequest(records, resource)), drops, clock.now), drops);
	return { agg, clock, written, attempts, add, points: () => written.flat() };
}

test("counted edge summaries become one latency point per route and minute, with runtime-node's bounds", async () => {
	const { agg, clock, add, points } = aggregator();
	const resource = { "service.name": "edge-api", "service.version": "abc123" };
	// One batch per request, as runtime-edge exports.
	for (const request of [
		{ durationMs: 40, at: MINUTE + 1_000, requestId: "a" },
		{ durationMs: 600, at: MINUTE + 2_000, requestId: "b" },
		{ durationMs: 200_000, at: MINUTE + 3_000, requestId: "c", status: 503, outcome: "failed" },
		// Another minute: its own point.
		{ durationMs: 5, at: MINUTE + 61_000, requestId: "d" },
	]) {
		add(edgeRecords({ route: "/items/:id", status: 200, outcome: "succeeded", ...request }), undefined, resource);
	}
	// Not counted by its summary (runtime-node / runtime-next, or
	// countRequests: false): its histogram, if any, has it already.
	add(edgeRecords({ route: "/node", status: 200, outcome: "succeeded", counted: false }), undefined, resource);

	clock.now = MINUTE + 60_000 + 14_000;
	await agg.flush();
	assert.equal(points().length, 0, "a minute waits for its late batches");
	clock.now = MINUTE + 60_000 + 15_000;
	await agg.flush();
	assert.equal(points().length, 1);
	const [first] = points();
	assert.deepEqual(first!.boundsMs, [5, 10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 60000, 120000]);
	assert.equal(first!.counts.length, first!.boundsMs.length + 1);
	assert.equal(first!.counts[3], 1, "40 ms lands in (25, 50]");
	assert.equal(first!.counts[7], 1, "600 ms lands in (500, 750]");
	assert.equal(first!.counts[20], 1, "past the last bound: the overflow bucket");
	assert.deepEqual(
		[first!.requestCount, first!.errorCount, first!.durationSumMs, first!.method, first!.route, first!.release, first!.bucketAt.getTime()],
		[3, 1, 200_640, "GET", "/items/:id", "abc123", MINUTE],
	);
	await agg.stop();
	const second = points()[1]!;
	assert.deepEqual([second.requestCount, second.counts[0], second.bucketAt.getTime()], [1, 1, MINUTE + 60_000]);
	assert.notEqual(first!.pointId, second.pointId);
});

test("a record added twice counts once; a late one for a written minute is a new point", async () => {
	const { agg, clock, add, points } = aggregator();
	const records = edgeRecords({ route: "/a", status: 200, outcome: "succeeded", requestId: "x" });
	add(records);
	add(records);
	clock.now = MINUTE + 80_000;
	await agg.flush();
	add(edgeRecords({ route: "/a", status: 200, outcome: "succeeded", requestId: "late" }));
	await agg.stop();
	assert.deepEqual(points().map((p) => [p.bucketAt.getTime(), p.requestCount]), [[MINUTE, 1], [MINUTE, 1]]);
	assert.notEqual(points()[0]!.pointId, points()[1]!.pointId);
});

test("a failed write is retried with the same point ids", async () => {
	const { agg, add, written, attempts } = aggregator({ failWrites: 1 });
	add(edgeRecords({ route: "/a", status: 200, outcome: "succeeded" }));
	await agg.flush({ all: true });
	assert.equal(written.length, 0);
	assert.equal(agg.size, 1, "kept for the next flush");
	await agg.flush();
	assert.equal(written.length, 1);
	assert.equal(agg.size, 0);
	assert.deepEqual(attempts[1], attempts[0], "a write that may have landed is replaced, not added to");
});

test("invalid edge summaries are left out of histograms and counted as drops", async () => {
	const { agg, clock, add, points } = aggregator();
	const drops = emptyEdgeLatencyDrops();
	add([
		...edgeRecords({ route: "/missing", status: 200, outcome: "succeeded", durationMs: null }),
		...edgeRecords({ route: "/negative", status: 200, outcome: "succeeded", durationMs: -5 }),
		...edgeRecords({ route: "/huge", status: 200, outcome: "succeeded", durationMs: 1e308 }),
		...edgeRecords({ route: "/untimed", status: 200, outcome: "succeeded", untimed: true }),
		...edgeRecords({ route: "/future", status: 200, outcome: "succeeded", at: clock.now + 60 * 60_000 }),
		...edgeRecords({ route: "/ancient", status: 200, outcome: "succeeded", at: clock.now - 3 * 24 * 60 * 60_000 }),
		...edgeRecords({ route: "/fine", status: 200, outcome: "succeeded", durationMs: 1e7 / 1e4 }),
	], drops);
	assert.deepEqual(drops, { invalid: 6, overLimit: 0 });
	await agg.stop();
	assert.deepEqual(points().map((p) => p.route), ["/fine"]);
	assert.ok(points().every((p) => Number.isFinite(p.durationSumMs)));
	// The usage rollups still count the request without a duration, with no latency.
	const rows = normalizeLogs(logsRequest(edgeRecords({ route: "/missing", status: 200, outcome: "succeeded", durationMs: null })));
	const [rollup] = logRollups(rows, []);
	assert.deepEqual([rollup!.requestCount, rollup!.durationSumMs, rollup!.latency], [1, 0, undefined]);
});

test("route cardinality is capped per service", async () => {
	const { agg, add, points } = aggregator({ routesPerService: 3 });
	const drops = emptyEdgeLatencyDrops();
	for (const route of ["/r1", "/r2", "/r3", "/r4", "/r5"]) add(edgeRecords({ route, status: 200, outcome: "succeeded" }), drops);
	add(edgeRecords({ route: "/r1", status: 200, outcome: "succeeded", requestId: "again" }), drops);
	add(edgeRecords({ route: "/r9", status: 200, outcome: "succeeded" }), drops, { "service.name": "other-service" });
	assert.equal(drops.overLimit, 2);
	await agg.stop();
	assert.deepEqual(points().map((p) => `${p.service} ${p.route} ${p.requestCount}`).sort(), [
		"edge-api /r1 2", "edge-api /r2 1", "edge-api /r3 1", "other-service /r9 1",
	]);
});

test("a route that also reports Node histograms gets no edge points", async () => {
	const { agg, add, points } = aggregator();
	agg.noteNodeHistograms(TENANT, [{
		pointId: "n", service: "edge-api", environment: "production", release: "", method: "GET", route: "/shared",
		bucketAt: new Date(MINUTE), requestCount: 1, errorCount: 0, durationSumMs: 5, boundsMs: [5], counts: [1, 0],
	}]);
	add([
		...edgeRecords({ route: "/shared", status: 200, outcome: "succeeded" }),
		...edgeRecords({ route: "/edge-only", status: 200, outcome: "succeeded" }),
	]);
	await agg.stop();
	assert.deepEqual(points().map((p) => p.route), ["/edge-only"]);
});

const close = (server: Server) =>
	new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});

function config(clickhouseUrl: string): IngesterConfig {
	return {
		port: 0,
		clickhouseUrl,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [{ key: "server", orgId: "org-1", repositoryId: "repo-1" }],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: null,
		sinkToken: null,
		sinkMaxAttempts: 1,
		sinkMaxBufferedBatches: 10,
		sinkMaxBufferedMb: 2,
		maxBodyBytes: 1024 * 1024,
		rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
		logTtlDays: 14,
	};
}
