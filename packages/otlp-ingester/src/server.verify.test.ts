import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { loadConfig, type IngesterConfig } from "./config.js";
import { DeliveryLog, ingestSummaryHeader, verifyIdOf } from "./delivery.js";
import { createIngesterApp } from "./server.js";

/**
 * The delivery check behind `autter-runtime verify`.
 * - a request whose resources all carry `autter.verify.id` is stored
 *   (spans, occurrences, logs) but feeds no rollup and never reaches the sink;
 * - `GET /v1/verify[/:traceId]` gives the key's holder its own last
 *   accepted/refused request and what was stored for a trace id;
 * - every accepted ingest answer says what it stored (`x-autter-ingest`).
 * ClickHouse is stubbed; the sink is a real HTTP endpoint.
 */

const KEY = `autter_rt_${"7".repeat(48)}`;
const OTHER = `autter_rt_${"8".repeat(48)}`;
const TRACE = "0123456789abcdef0123456789abcdef";
const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n);

async function sinkStub(t: TestContext) {
	const batches: unknown[] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			batches.push(JSON.parse(body));
			res.writeHead(202).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sink`, batches };
}

async function start(t: TestContext, overrides: Partial<IngesterConfig> = {}) {
	const ingester = createIngesterApp({
		...loadConfig(),
		clickhouseUrl: "http://127.0.0.1:1",
		sinkOutboxDir: null,
		ingestKeys: [
			{ key: KEY, orgId: "org-v", repositoryId: "repo-v" },
			{ key: OTHER, orgId: "org-o", repositoryId: "repo-o" },
		],
		...overrides,
	});
	const { app, store, drops, collapse } = ingester;
	const stub = store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) stub[name] = async () => {};
	}
	stub.ensureSchema = async () => {};
	stub.recentOccurrenceTraceIds = async () => new Set();
	stub.probe = async () => ({ state: "up", checkedAt: new Date().toISOString(), latencyMs: 1 });
	const writes: Record<string, number> = {};
	const count = (table: string) => async (_ctx: unknown, rows: unknown[]) => {
		writes[table] = (writes[table] ?? 0) + rows.length;
	};
	stub.insertSpans = count("spans");
	stub.insertOccurrences = count("occurrences");
	stub.insertMetricPoints = count("metrics");
	stub.insertRouteLatency = count("route_latency");
	stub.insertLogs = count("logs");
	const lookups: Array<{ org: string; trace: string }> = [];
	stub.verifyLookup = async (ctx: { orgId: string }, trace: string) => {
		lookups.push({ org: ctx.orgId, trace });
		return {
			spans: { rows: writes.spans ?? 0, services: ["checkout"], releases: ["abc123"] },
			occurrences: { rows: writes.occurrences ?? 0, services: ["checkout"], releases: ["abc123"] },
			logs: { rows: writes.logs ?? 0, services: ["checkout"], releases: ["abc123"] },
		};
	};
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(
		() =>
			new Promise<void>((resolve) => {
				void collapse.stop().then(() => drops.stop());
				ingester.sink?.stop();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	);
	return {
		ingester,
		writes,
		lookups,
		post: (path: string, key: string | null, body: unknown) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
				body: JSON.stringify(body),
			}),
		get: (path: string, key: string | null) =>
			fetch(`${base}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }),
	};
}

function resource(verify: string | null) {
	return {
		attributes: [
			{ key: "service.name", value: { stringValue: "checkout" } },
			{ key: "service.version", value: { stringValue: "abc123" } },
			...(verify ? [{ key: "autter.verify.id", value: { stringValue: verify } }] : []),
		],
	};
}

function traces(verify: string | null, traceId = TRACE) {
	const now = Date.now();
	return {
		resourceSpans: [
			{
				resource: resource(verify),
				scopeSpans: [
					{
						spans: [
							{
								traceId,
								spanId: "0123456789abcdef",
								name: "GET /checkout",
								kind: 2,
								startTimeUnixNano: nanos(now - 5),
								endTimeUnixNano: nanos(now),
								attributes: [
									{ key: "http.route", value: { stringValue: "/checkout" } },
									{ key: "http.response.status_code", value: { intValue: 500 } },
								],
								status: { code: 2 },
								events: [
									{
										name: "exception",
										timeUnixNano: nanos(now),
										attributes: [
											{ key: "exception.type", value: { stringValue: "AutterVerifyTestError" } },
											{ key: "exception.message", value: { stringValue: "test event" } },
										],
									},
								],
							},
						],
					},
				],
			},
		],
	};
}

function logs(verify: string | null) {
	return {
		resourceLogs: [
			{
				resource: resource(verify),
				scopeLogs: [
					{
						logRecords: [
							{
								timeUnixNano: nanos(Date.now()),
								severityText: "INFO",
								body: { stringValue: "verify log" },
								traceId: TRACE,
								spanId: "0123456789abcdef",
							},
						],
					},
				],
			},
		],
	};
}

test("verifyIdOf: every resource must carry the same 32-hex id", () => {
	assert.equal(verifyIdOf(traces(TRACE), "resourceSpans"), TRACE);
	assert.equal(verifyIdOf(traces(null), "resourceSpans"), null);
	assert.equal(verifyIdOf(traces("not-hex"), "resourceSpans"), null);
	const mixed = traces(TRACE);
	mixed.resourceSpans.push(traces(null).resourceSpans[0]!);
	assert.equal(verifyIdOf(mixed, "resourceSpans"), null, "a mixed request is real traffic");
	assert.equal(verifyIdOf({ resourceSpans: [] }, "resourceSpans"), null);
	assert.equal(verifyIdOf(null, "resourceSpans"), null);
});

test("ingestSummaryHeader and DeliveryLog", () => {
	assert.equal(ingestSummaryHeader({ spans: 3, occurrences: 1, rejected: 0 }), "spans=3 occurrences=1 rejected=0");
	let now = Date.parse("2026-11-08T10:00:00Z");
	const log = new DeliveryLog(2, () => now);
	log.rejected("a", { route: "/v1/traces", status: 401, reason: "unknown_key", error: "invalid ingest key" });
	now += 1000;
	log.accepted("a", { route: "/v1/traces", status: 200, accepted: { spans: 1 } });
	const a = log.get("a")!;
	assert.equal(a.accepted, 1);
	assert.equal(a.rejected, 1);
	assert.equal(a.lastRejected?.reason, "unknown_key");
	assert.equal(a.lastAccepted?.at, "2026-11-08T10:00:01.000Z");
	log.accepted("b", { route: "/v1/logs", status: 200 });
	log.accepted("c", { route: "/v1/logs", status: 200 });
	assert.equal(log.get("a"), null, "bounded: the least recently used key goes");
});

test("a verify request is stored but never reaches the sink or the rollups", async (t) => {
	const sink = await sinkStub(t);
	const app = await start(t, { sinkUrl: sink.url });
	const res = await app.post("/v1/traces", KEY, traces(TRACE));
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("x-autter-ingest"), "spans=1 occurrences=1 metric_points=0 llm_calls=0 suppressed=0 collapsed=0 truncated_values=0 rejected=0");
	assert.equal(app.writes.spans, 1);
	assert.equal(app.writes.occurrences, 1);
	assert.equal(app.writes.metrics, undefined, "no request/error rollup from a test event");

	const logRes = await app.post("/v1/logs", KEY, logs(TRACE));
	assert.equal(logRes.status, 200);
	assert.match(logRes.headers.get("x-autter-ingest") ?? "", /^log_records=1 /);
	assert.equal(app.writes.logs, 1);

	// The same span without the marker is real traffic: rollups and the sink.
	const real = await app.post("/v1/traces", KEY, traces(null, "fedcba9876543210fedcba9876543210"));
	assert.equal(real.status, 200);
	assert.ok((app.writes.metrics ?? 0) > 0);
	for (let i = 0; i < 100 && sink.batches.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
	const forwarded = sink.batches.flatMap((b) => (b as { occurrences: Array<{ traceId?: string }> }).occurrences);
	assert.equal(forwarded.length, 1, "only the real occurrence");
	assert.notEqual(forwarded[0]!.traceId, TRACE);
});

test("GET /v1/verify/:traceId: what was stored, and this key's last accepted and refused requests", async (t) => {
	const app = await start(t);
	await app.post("/v1/traces", KEY, { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: TRACE, startTimeUnixNano: "not a number" }] }] }] });
	await app.post("/v1/traces", KEY, traces(TRACE));

	const res = await app.get(`/v1/verify/${TRACE.toUpperCase()}`, KEY);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	const body = await res.json();
	assert.equal(body.traceId, TRACE);
	assert.equal(body.storage, "up");
	assert.match(body.ingester.version, /^\d+\.\d+\.\d+/);
	assert.deepEqual(body.stored.spans, { rows: 1, services: ["checkout"], releases: ["abc123"] });
	assert.equal(body.stored.occurrences.rows, 1);
	assert.deepEqual(app.lookups, [{ org: "org-v", trace: TRACE }], "looked up in the caller's tenant only");
	assert.equal(body.delivery.accepted, 1);
	assert.equal(body.delivery.rejected, 1);
	assert.equal(body.delivery.lastAccepted.route, "/v1/traces");
	assert.equal(body.delivery.lastAccepted.accepted.spans, 1);
	assert.equal(body.delivery.lastRejected.status, 400);
	assert.equal(body.delivery.lastRejected.reason, "invalid_payload");
	assert.equal(body.delivery.lastRejected.error, "invalid OTLP traces payload");

	// Another key sees only its own record.
	const other = await (await app.get("/v1/verify", OTHER)).json();
	assert.equal(other.delivery, null);
	assert.equal(other.stored, undefined);
});

test("GET /v1/verify refuses what ingest refuses, and a bad trace id", async (t) => {
	const app = await start(t);
	const missing = await app.get("/v1/verify", null);
	assert.equal(missing.status, 401);
	assert.equal((await missing.json()).error, "missing ingest key");
	const wrong = await app.get("/v1/verify", `autter_rt_${"9".repeat(48)}`);
	assert.equal(wrong.status, 401);
	assert.equal((await wrong.json()).error, "invalid ingest key");
	const bad = await app.get("/v1/verify/xyz", KEY);
	assert.equal(bad.status, 400);
});

test("a refused key's last refusal is on record for when it is fixed", async (t) => {
	const app = await start(t);
	const browser = await app.post("/v1/browser", KEY, { version: 1, service: "web", environment: "p", events: [] });
	assert.equal(browser.status, 202);
	assert.match(browser.headers.get("x-autter-ingest") ?? "", /^events=0 occurrences=0 /);
	const body = await (await app.get("/v1/verify", KEY)).json();
	assert.equal(body.delivery.lastAccepted.route, "/v1/browser");
	assert.equal(body.delivery.lastAccepted.status, 202);
});
