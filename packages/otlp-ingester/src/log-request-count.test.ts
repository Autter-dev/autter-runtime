import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
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
	durationMs?: number;
	counted?: boolean;
	at?: number;
}

/** The records runtime-edge sends for one request: its error records, then its summary. */
function edgeRecords(request: EdgeRequest) {
	const counted = request.counted !== false;
	const base = {
		"autter.request.id": `req-${request.route.replace(/\W/g, "")}-0001`,
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
		timeUnixNano: nanos(at),
		severityNumber: request.outcome === "failed" ? 17 : 9,
		severityText: request.outcome === "failed" ? "ERROR" : "INFO",
		body: { stringValue: `GET ${request.route}: ${request.outcome}` },
		attributes: kv({
			...base,
			"autter.event.type": "operation",
			"autter.operation.kind": "request",
			"autter.operation.outcome": request.outcome,
			"autter.operation.duration_ms": request.durationMs ?? 10,
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
	const app = createIngesterApp(config(`http://127.0.0.1:${(ch.address() as AddressInfo).port}`)).app.listen(0, "127.0.0.1");
	await new Promise((resolve) => app.once("listening", resolve));
	const now = Date.now();
	try {
		const res = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/v1/logs`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer server" },
			body: JSON.stringify(
				logsRequest([
					...edgeRecords({ route: "/ok", status: 200, outcome: "succeeded", at: now }),
					...edgeRecords({ route: "/ok", status: 500, outcome: "failed", errors: 1, at: now }),
				]),
			),
		});
		assert.equal(res.status, 200);
		assert.equal(inserted.runtime_error_occurrences?.length, 1);
		const metrics = inserted.runtime_metrics_1m ?? [];
		assert.equal(metrics.reduce((n, row) => n + Number(row.request_count), 0), 2);
		assert.equal(metrics.reduce((n, row) => n + Number(row.error_count), 0), 1);
		assert.deepEqual([...new Set(metrics.map((row) => row.route))], ["/ok"]);
	} finally {
		await close(app);
		await close(ch);
	}
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
