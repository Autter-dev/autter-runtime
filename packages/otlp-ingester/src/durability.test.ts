import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { InsertReceipts } from "./insert-receipts.js";
import { createIngesterApp } from "./server.js";
import { batchIdFor, SINK_BATCH_LIMITS, SinkForwarder } from "./sink.js";
import { OutboxLockedError, SinkOutbox } from "./sink-outbox.js";
import type { IngestContext, RuntimeOccurrence } from "./types.js";

/**
 * 1.12 durability and readiness, with faults injected over the wire:
 * a ClickHouse HTTP stub that fails chosen inserts (or authentication, or
 * tables), and a sink webhook that is down while the ingester restarts.
 */

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<{ server: Server; url: string }> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => handler(req, body, res));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** What a ClickHouse server answers for an error (the client parses the body). */
function chError(res: ServerResponse, code: number, type: string): void {
	res.writeHead(code === 516 ? 401 : 500, { "x-clickhouse-exception-code": String(code) });
	res.end(`Code: ${code}. DB::Exception: injected fault. (${type}) (version 24.8.1.1)`);
}

interface ChCall {
	query: string;
	table: string | null;
	token: string | null;
	rows: number;
}

/** A ClickHouse stub recording every insert; `fault` decides failures. */
async function clickhouse(fault: (call: ChCall) => "ok" | "fail" | "auth" | "unknown_table" | "not_implemented" = () => "ok") {
	const calls: ChCall[] = [];
	const { server, url } = await listen((req, body, res) => {
		const params = new URL(req.url ?? "/", "http://x").searchParams;
		const query = params.get("query") ?? body;
		const table = /INSERT INTO\s+\S*?\.?(\w+)\s/i.exec(query)?.[1] ?? null;
		const call: ChCall = {
			query,
			table,
			token: params.get("insert_deduplication_token"),
			rows: table ? body.trim().split("\n").filter(Boolean).length : 0,
		};
		calls.push(call);
		const outcome = fault(call);
		if (outcome === "fail") return chError(res, 252, "TOO_MANY_PARTS");
		if (outcome === "auth") return chError(res, 516, "AUTHENTICATION_FAILED");
		if (outcome === "unknown_table") return chError(res, 60, "UNKNOWN_TABLE");
		if (outcome === "not_implemented") return chError(res, 48, "NOT_IMPLEMENTED");
		res.writeHead(200).end();
	});
	return { server, url, calls, inserts: (table: string) => calls.filter((c) => c.table === table) };
}

function config(overrides: Partial<IngesterConfig>): IngesterConfig {
	return {
		port: 0,
		clickhouseUrl: null,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [{ key: "test-key", orgId: "org-d", repositoryId: "repo-d" }],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: null,
		sinkToken: null,
		sinkMaxBufferedBatches: 1000,
		sinkMaxBufferedMb: 64,
		maxBodyBytes: 1024 * 1024,
		rateLimitPerMinute: 10_000,
		clientRateLimitPerMinute: 10_000,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
		logTtlDays: 14,
		loopCollapseAfter: 0,
		...overrides,
	};
}

async function startApp(cfg: IngesterConfig) {
	const ingester = createIngesterApp(cfg);
	const server = ingester.app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		...ingester,
		url,
		post: (path: string, body: unknown) =>
			fetch(`${url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer test-key" },
				body: JSON.stringify(body),
			}),
		async stop() {
			ingester.sink?.stop();
			ingester.collapse.stop();
			await ingester.drops.stop();
			await close(server);
			await ingester.store.close();
		},
	};
}

/** One server span that failed with an exception: an occurrence, a span
 * and a metric point — the four-way fan-out minus LLM calls. */
function traceBody(message = "card declined") {
	const start = BigInt(Date.now()) * 1_000_000n;
	return {
		resourceSpans: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "payments" } }] },
			scopeSpans: [{
				spans: [{
					traceId: "0af7651916cd43dd8448eb211c80319c",
					spanId: "b7ad6b7169203331",
					name: "POST /charge",
					kind: 2,
					startTimeUnixNano: String(start),
					endTimeUnixNano: String(start + 5_000_000n),
					status: { code: 2, message },
					attributes: [
						{ key: "http.route", value: { stringValue: "/charge" } },
						{ key: "http.response.status_code", value: { intValue: "500" } },
					],
					events: [{
						name: "exception",
						timeUnixNano: String(start + 1_000_000n),
						attributes: [
							{ key: "exception.type", value: { stringValue: "PaymentError" } },
							{ key: "exception.message", value: { stringValue: message } },
						],
					}],
				}],
			}],
		}],
	};
}

const waitFor = async (check: () => boolean, ms = 5_000) => {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

test("a retry after a partial fan-out failure adds no rows twice (summed metrics, spans)", async (t) => {
	let failMetrics = true;
	const ch = await clickhouse((call) => (call.table === "runtime_metrics_1m" && failMetrics ? "fail" : "ok"));
	const app = await startApp(config({ clickhouseUrl: ch.url }));
	t.after(async () => {
		await app.stop();
		await close(ch.server);
	});
	const body = traceBody();

	const first = await app.post("/v1/traces", body);
	assert.equal(first.status, 503, "a failed insert answers 503 so the exporter retries");
	assert.equal(ch.inserts("runtime_spans").length, 1, "spans committed on the first attempt");
	assert.equal(ch.inserts("runtime_error_occurrences").length, 1);

	failMetrics = false;
	const retry = await app.post("/v1/traces", body);
	assert.equal(retry.status, 200);
	assert.equal(ch.inserts("runtime_spans").length, 1, "committed spans are not inserted again");
	assert.equal(ch.inserts("runtime_error_occurrences").length, 1, "nor occurrences");
	const metricInserts = ch.inserts("runtime_metrics_1m");
	assert.equal(metricInserts.length, 2, "the failed table is written on the retry");
	// Every fan-out insert names the request and table: ClickHouse drops a
	// block it already has, for a retry that reaches another replica.
	const spanToken = ch.inserts("runtime_spans")[0]!.token;
	assert.match(spanToken ?? "", /^[0-9a-f]{40}:autter_runtime\.runtime_spans$/);
	assert.equal(metricInserts[0]!.token, metricInserts[1]!.token, "the same request carries the same token");

	// A third, byte-identical send (the 200 got lost) writes nothing at all.
	assert.equal((await app.post("/v1/traces", body)).status, 200);
	assert.equal(ch.inserts("runtime_metrics_1m").length, 2);
	assert.equal(ch.inserts("runtime_spans").length, 1);

	// A different export is written normally.
	assert.equal((await app.post("/v1/traces", traceBody("insufficient funds"))).status, 200);
	assert.equal(ch.inserts("runtime_spans").length, 2);
});

test("another replica retrying the same request sends the same dedup tokens", async (t) => {
	const ch = await clickhouse((call) => (call.table === "runtime_spans" ? "fail" : "ok"));
	const a = await startApp(config({ clickhouseUrl: ch.url }));
	const b = await startApp(config({ clickhouseUrl: ch.url }));
	t.after(async () => {
		await a.stop();
		await b.stop();
		await close(ch.server);
	});
	const body = traceBody();
	assert.equal((await a.post("/v1/traces", body)).status, 503);
	assert.equal((await b.post("/v1/traces", body)).status, 503);
	const tokens = (table: string) => ch.inserts(table).map((c) => c.token);
	const [fromA, fromB] = tokens("runtime_metrics_1m");
	assert.ok(fromA);
	assert.equal(fromA, fromB, "metrics inserted by both replicas share a token, so ClickHouse keeps one");
	assert.equal(tokens("runtime_error_occurrences")[0], tokens("runtime_error_occurrences")[1]);
});

test("insert receipts are bounded and expire", async () => {
	let now = 0;
	const receipts = new InsertReceipts({ maxEntries: 2, ttlMs: 1_000, now: () => now });
	await receipts.add("a", "t1");
	await receipts.add("b", "t1");
	await receipts.add("c", "t1");
	assert.equal(receipts.size, 2);
	assert.equal((await receipts.committed("a")).size, 0, "oldest evicted");
	assert.ok((await receipts.committed("c")).has("t1"));
	now = 2_000;
	assert.equal((await receipts.committed("c")).size, 0, "expired");
});

test("insert receipts survive a restart through their journal, and expired lines are dropped", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "autter-receipts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "insert-receipts.log");
	let now = 1_000_000;
	const first = new InsertReceipts({ file, ttlMs: 60_000, now: () => now });
	await first.add("old", "runtime_spans");
	now += 50_000;
	await first.add("d1", "runtime_spans");
	await first.add("d1", "runtime_metrics_1m");
	assert.equal(first.mode, "file");
	now += 20_000; // "old" is now past the TTL; d1 is not
	const second = new InsertReceipts({ file, ttlMs: 60_000, now: () => now });
	assert.deepEqual([...(await second.committed("d1"))].sort(), ["runtime_metrics_1m", "runtime_spans"]);
	assert.equal((await second.committed("old")).size, 0);
	assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2, "compacted at load");
});

test("insert receipts in Redis are seen by another replica, and a Redis failure falls back", async () => {
	const store = new Map<string, string>();
	let down = false;
	const redis = {
		async eval(script: string, numKeys: number, ...args: Array<string | number>) {
			if (down) throw new Error("Connection is closed.");
			const keys = args.slice(0, numKeys).map(String);
			if (script.includes("MGET")) return keys.map((key) => store.get(key) ?? null);
			store.set(keys[0]!, "1");
			assert.equal(args[numKeys], 900, "expires with the receipt TTL");
			return "OK";
		},
	};
	const logs: string[] = [];
	const a = new InsertReceipts({ redis, log: (m) => logs.push(m) });
	const b = new InsertReceipts({ redis, log: (m) => logs.push(m) });
	await a.add("d1", "runtime_spans");
	assert.ok((await b.committed("d1", ["runtime_spans", "runtime_logs"])).has("runtime_spans"));
	assert.equal((await b.committed("d1", ["runtime_logs"])).has("runtime_logs"), false);
	down = true;
	assert.ok((await a.committed("d1", ["runtime_spans"])).has("runtime_spans"), "a still knows its own");
	assert.equal((await b.committed("d2", ["runtime_spans"])).size, 0);
	await a.add("d3", "runtime_spans");
	await a.add("d4", "runtime_spans");
	assert.equal(a.stats().redisFailures, 2);
	assert.equal(b.stats().redisFailures, 1);
	assert.equal(logs.length, 2, "each process logs once a minute at most");
	assert.equal(a.mode, "redis");
});

test("a retry after a restart writes no committed table again (journal)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "autter-receipts-app-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	let failMetrics = true;
	const ch = await clickhouse((call) => (call.table === "runtime_metrics_1m" && failMetrics ? "fail" : "ok"));
	t.after(() => close(ch.server));
	const cfg = config({ clickhouseUrl: ch.url, insertReceiptsFile: join(dir, "insert-receipts.log") });
	const body = traceBody();
	const first = await startApp(cfg);
	assert.equal((await first.post("/v1/traces", body)).status, 503);
	await first.stop();
	failMetrics = false;
	const second = await startApp(cfg);
	t.after(() => second.stop());
	assert.equal((await second.post("/v1/traces", body)).status, 200);
	assert.equal(ch.inserts("runtime_spans").length, 1, "spans from before the restart are not written again");
	assert.equal(ch.inserts("runtime_error_occurrences").length, 1);
	assert.equal(ch.inserts("runtime_metrics_1m").length, 2);
	const health = (await (await fetch(`${second.url}/healthz`)).json()) as { insertReceipts: { mode: string } };
	assert.equal(health.insertReceipts.mode, "file");
});

test("a re-send that overtakes a slow first attempt waits for it instead of writing twice", async (t) => {
	let firstSpans = true;
	const ch = await clickhouse();
	t.after(() => close(ch.server));
	// Hold the first spans insert for a while, as a slow ClickHouse would.
	const slow = await listen((req, body, res) => {
		const query = new URL(req.url ?? "/", "http://x").searchParams.get("query") ?? body;
		if (firstSpans && /runtime_spans/.test(query) && /^INSERT/.test(query)) {
			firstSpans = false;
			setTimeout(() => {
				void fetch(`${ch.url}${req.url}`, { method: "POST", body }).then(() => res.writeHead(200).end());
			}, 300);
			return;
		}
		void fetch(`${ch.url}${req.url}`, { method: "POST", body }).then((r) => res.writeHead(r.status).end());
	});
	t.after(() => close(slow.server));
	const app = await startApp(config({ clickhouseUrl: slow.url }));
	t.after(() => app.stop());
	const body = traceBody();
	const [a, b] = await Promise.all([app.post("/v1/traces", body), app.post("/v1/traces", body)]);
	assert.deepEqual([a.status, b.status], [200, 200]);
	assert.equal(ch.inserts("runtime_spans").length, 1);
	assert.equal(ch.inserts("runtime_metrics_1m").length, 1);
});

test("sink batches survive the webhook being down across an ingester restart", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "autter-outbox-test-"));
	let sinkUp = false;
	const received: Array<Record<string, unknown>> = [];
	const sink = await listen((_req, body, res) => {
		if (!sinkUp) {
			res.writeHead(503).end();
			return;
		}
		received.push(JSON.parse(body));
		res.writeHead(202).end();
	});
	const ch = await clickhouse();
	t.after(async () => {
		await close(sink.server);
		await close(ch.server);
		rmSync(dir, { recursive: true, force: true });
	});
	const cfg = config({ clickhouseUrl: ch.url, sinkUrl: `${sink.url}/runtime/sink`, sinkOutboxDir: dir });

	// Run 1: the webhook is down. The batch is on disk before the 200.
	const first = await startApp(cfg);
	assert.equal((await first.post("/v1/traces", traceBody())).status, 200);
	const pending = readdirSync(dir).filter((name) => name.endsWith(".json"));
	assert.equal(pending.length, 1, "the batch is in the outbox");
	await waitFor(() => (first.sink?.stats().retried ?? 0) >= 1);
	const queued = JSON.parse(readFileSync(join(dir, pending[0]!), "utf8"));
	// The process goes away with the batch undelivered (a deploy, a crash).
	await first.stop();
	assert.equal(readdirSync(dir).filter((name) => name.endsWith(".json")).length, 1, "still there after stop");

	// Run 2: the webhook is back. The new process sends what run 1 left.
	sinkUp = true;
	const second = await startApp(cfg);
	t.after(() => second.stop());
	await waitFor(() => received.length === 1);
	assert.equal(received[0]!.batchId, queued.batchId, "the same batch, so the consumer dedupes a repeat");
	assert.equal((received[0]!.occurrences as unknown[]).length, 1);
	await waitFor(() => readdirSync(dir).filter((name) => name.endsWith(".json")).length === 0);
	const stats = second.sink!.stats();
	assert.equal(stats.restored, 1);
	assert.equal(stats.delivered, 1);
	assert.equal(stats.durable, true);
});

test("a re-sent request is the same sink batch; a big one is split under the consumer's caps", async () => {
	const delivered: Array<Record<string, any>> = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		delivered.push(JSON.parse(String(init.body)));
		return new Response(null, { status: 202 });
	}) as typeof fetch;
	const forwarder = new SinkForwarder(config({ sinkUrl: "http://sink.local/hook" }), fetchImpl);
	const ctx: IngestContext = { orgId: "o", repositoryId: "r", scope: "server", allowedOrigins: [] };
	const occurrence = (i: number) => ({
		source: "server", severity: "error", service: "api", environment: "prod", release: null,
		errorType: "Error", message: "x", stack: null, route: null, method: null, statusCode: null, traceId: null,
		sessionId: null, attributes: null, occurredAt: new Date(0), occurrenceId: `occ-${i}`, fingerprint: "fp",
		fingerprintScheme: "message-v1", routeNormalized: "", messageNormalized: "", topFrames: [], firstFrame: "",
	}) as RuntimeOccurrence;
	const many = Array.from({ length: SINK_BATCH_LIMITS.occurrences * 2 + 5 }, (_, i) => occurrence(i));
	forwarder.enqueue(ctx, many, [], [], "digest-1");
	await waitFor(() => delivered.length === 3);
	assert.deepEqual(delivered.map((b) => b.occurrences.length).sort((x, y) => x - y), [5, 1000, 1000]);
	const ids = delivered.map((b) => b.batchId);
	assert.equal(new Set(ids).size, 3, "each part has its own id");
	forwarder.enqueue(ctx, many, [], [], "digest-1");
	await waitFor(() => delivered.length === 6);
	assert.deepEqual(new Set(delivered.slice(3).map((b) => b.batchId)), new Set(ids), "same request, same ids");
	assert.equal(batchIdFor("x"), batchIdFor("x"));
	assert.match(batchIdFor("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	forwarder.stop();
});

test("the outbox: dead letters keep the batch and its reason, a live owner locks the directory, bad files are set aside", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "autter-outbox-unit-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const outbox = new SinkOutbox(dir, { deadLetterMaxBytes: 4_000 });
	writeFileSync(join(dir, "000000000007-broken.json"), "{not json");
	assert.deepEqual(outbox.open(), []);
	assert.ok(readdirSync(join(dir, "dead")).some((name) => name.startsWith("corrupt-")), "unreadable file moved, not deleted");

	// A sink that rejects the batch for good: dead-lettered on disk.
	const drops: Array<Record<string, unknown>> = [];
	const forwarder = new SinkForwarder(
		config({ sinkUrl: "http://sink.local/hook" }),
		(async () => new Response(null, { status: 400 })) as typeof fetch,
		{},
		{ outbox, pending: [] },
	);
	forwarder.onDrop = (drop) => drops.push({ ...drop });
	const ctx: IngestContext = { orgId: "o", repositoryId: "r", scope: "server", allowedOrigins: [] };
	forwarder.enqueue(ctx, [], [{
		service: "api", environment: "prod", release: null, route: "/x", bucketAt: new Date(60_000),
		requestCount: 1, errorCount: 0, durationSumMs: 1, sessionCount: 0,
	}]);
	await waitFor(() => drops.length === 1);
	const file = drops[0]!.file as string;
	assert.ok(file && existsSync(join(dir, "dead", file)));
	const dead = JSON.parse(readFileSync(join(dir, "dead", file), "utf8"));
	assert.equal(dead.reason, "sink_rejected");
	assert.equal(dead.metricPoints, 1);
	assert.equal(drops[0]!.signalsFrom, new Date(60_000).toISOString());
	assert.equal(readdirSync(dir).filter((name) => name.endsWith(".json")).length, 0, "no longer pending");
	assert.equal(forwarder.stats().deadLettered, 1);
	forwarder.stop();

	// Another live process holding the directory: refuse to share it.
	writeFileSync(join(dir, ".lock"), String(process.ppid));
	assert.throws(() => new SinkOutbox(dir).open(), OutboxLockedError);
	// A lock left by a process that is gone is taken over.
	writeFileSync(join(dir, ".lock"), "999999");
	assert.doesNotThrow(() => new SinkOutbox(dir).open());
});

test("/healthz reports a wrong password, a dropped table and an unreachable ClickHouse as unready", async (t) => {
	let mode: "ok" | "auth" | "unknown_table" = "auth";
	let creates = 0;
	const ch = await clickhouse((call) => {
		if (/^CREATE TABLE IF NOT EXISTS \S+\.runtime_error_occurrences/.test(call.query)) creates += 1;
		if (call.query.startsWith("CREATE") || call.query.startsWith("SELECT") || call.query.startsWith("ALTER")) {
			return mode === "auth" ? "auth" : "ok";
		}
		return mode;
	});
	const app = await startApp(config({ clickhouseUrl: ch.url }));
	t.after(async () => {
		await app.stop();
		await close(ch.server);
	});
	const health = async () => {
		const res = await fetch(`${app.url}/healthz`);
		return { status: res.status, retryAfter: res.headers.get("retry-after"), body: (await res.json()) as Record<string, any> };
	};

	// Wrong password: ClickHouse's /ping would still say "up".
	let h = await health();
	assert.equal(h.status, 503);
	assert.equal(h.body.clickhouse, "auth_failed");
	assert.equal(h.body.retryable, false);
	assert.equal(h.retryAfter, null);
	// An empty export must not get a 2xx from an ingester that cannot store.
	assert.equal((await app.post("/v1/logs", { resourceLogs: [] })).status, 503);
	assert.equal((await fetch(`${app.url}/livez`)).status, 200, "liveness does not depend on storage");
	const metrics = await (await fetch(`${app.url}/metrics`)).text();
	assert.match(metrics, /^autter_ingester_ready 0$/m);
	assert.match(metrics, /^autter_ingester_storage_state\{state="auth_failed"\} 1$/m);

	// Fixed credentials, then the table is dropped under a running ingester.
	mode = "ok";
	app.store.writes.recordOk();
	app.store.onWriteStateChange?.(); // drop the cached probe answer
	h = await health();
	assert.equal(h.status, 200, JSON.stringify(h.body));
	assert.equal(h.body.clickhouse, "up");
	assert.equal(h.body.ok, true);
	assert.equal((await app.post("/v1/logs", { resourceLogs: [] })).status, 200, "empty export with storage up");

	mode = "unknown_table";
	const createsBefore = creates;
	assert.equal((await app.post("/v1/traces", traceBody())).status, 503);
	h = await health();
	assert.equal(h.status, 503);
	assert.equal(h.body.clickhouse, "schema_missing");
	assert.equal(h.body.writes.consecutiveFailures > 0, true);
	// The schema memo was cleared: the next write recreates the tables
	// instead of failing until a restart.
	mode = "ok";
	assert.equal((await app.post("/v1/traces", traceBody("after recreate"))).status, 200);
	assert.ok(creates > createsBefore, "baseline CREATEs ran again");
	h = await health();
	assert.equal(h.status, 200, JSON.stringify(h.body));
	// The drop counters are readable while storage is broken.
	assert.ok(h.body.drops.byReason.some((d: { reason: string }) => d.reason === "storage_unavailable"));

	// Unreachable: retryable, with Retry-After.
	await close(ch.server);
	app.store.writes.recordFailure("unreachable");
	app.store.onWriteStateChange?.();
	h = await health();
	assert.equal(h.status, 503);
	assert.equal(h.body.clickhouse, "down");
	assert.equal(h.body.retryable, true);
	assert.equal(h.retryAfter, "5");
});

test("/healthz without ClickHouse configured is not ready (ingest answers 503 there)", async (t) => {
	const app = await startApp(config({ clickhouseUrl: null }));
	t.after(() => app.stop());
	const res = await fetch(`${app.url}/healthz`);
	assert.equal(res.status, 503);
	assert.equal(((await res.json()) as { clickhouse: string }).clickhouse, "unconfigured");
});

test("shutdown drain cuts a waiting backoff short and delivers the queue", async () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return new Response(null, { status: calls === 1 ? 503 : 202 });
	}) as typeof fetch;
	// A one-minute backoff after the first failure: without the drain the
	// batch would still be waiting when the process exits.
	const forwarder = new SinkForwarder(config({ sinkUrl: "http://sink.local/hook" }), fetchImpl, {
		retryBaseMs: 60_000,
		retryCapMs: 60_000,
	});
	const ctx: IngestContext = { orgId: "o", repositoryId: "r", scope: "server", allowedOrigins: [] };
	forwarder.enqueue(ctx, [], [{
		service: "api", environment: "prod", release: null, route: "/x", bucketAt: new Date(0),
		requestCount: 1, errorCount: 0, durationSumMs: 1, sessionCount: 0,
	}]);
	await waitFor(() => forwarder.stats().retried === 1);
	const started = Date.now();
	assert.equal(await forwarder.drain(2_000), 0);
	assert.ok(Date.now() - started < 1_000);
	assert.equal(forwarder.stats().delivered, 1);
	forwarder.stop();
});

test("a server that refuses the dedupe settings still gets every insert (they are dropped, not fatal)", async (t) => {
	const ch = await clickhouse((call) => {
		if (!call.table) return "ok";
		return call.token ? "not_implemented" : "ok";
	});
	const app = await startApp(config({ clickhouseUrl: ch.url }));
	t.after(async () => {
		await app.stop();
		await close(ch.server);
	});
	assert.equal((await app.post("/v1/traces", traceBody())).status, 200);
	const spans = ch.inserts("runtime_spans");
	assert.equal(spans.at(-1)!.token, null, "retried without the token");
	assert.equal((await app.post("/v1/traces", traceBody("next"))).status, 200);
	assert.equal(ch.inserts("runtime_spans").at(-1)!.token, null, "and no longer sent");
});

test("shared outbox (EFS): a task adopts the batches of a task that is gone, never a live one's", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "autter-outbox-shared-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ctx: IngestContext = { orgId: "o", repositoryId: "r", scope: "server", allowedOrigins: [] };
	const point = (minute: number) => ({
		service: "api", environment: "prod", release: null, route: "/x", bucketAt: new Date(minute * 60_000),
		requestCount: 1, errorCount: 0, durationSumMs: 1, sessionCount: 0,
	});
	const down = (async () => new Response(null, { status: 503 })) as typeof fetch;
	const sinkCfg = config({ sinkUrl: "http://sink.local/hook" });

	// Task A (a deploy is about to replace it) and task C (crashed: no close).
	const a = new SinkOutbox(root, { shared: true, instance: "task-a" });
	const forwarderA = new SinkForwarder(sinkCfg, down, { retryBaseMs: 60_000 }, { outbox: a, pending: a.open() });
	forwarderA.enqueue(ctx, [], [point(1)]);
	const c = new SinkOutbox(root, { shared: true, instance: "task-c" });
	const forwarderC = new SinkForwarder(sinkCfg, down, { retryBaseMs: 60_000 }, { outbox: c, pending: c.open() });
	forwarderC.enqueue(ctx, [], [point(2)]);
	// Task L stays alive.
	const l = new SinkOutbox(root, { shared: true, instance: "task-l" });
	const forwarderL = new SinkForwarder(sinkCfg, down, { retryBaseMs: 60_000 }, { outbox: l, pending: l.open() });
	forwarderL.enqueue(ctx, [], [point(3)]);
	await waitFor(() => forwarderA.stats().retried >= 1 && forwarderC.stats().retried >= 1);
	forwarderA.stop(); // graceful: marks its directory closed
	// C crashed: no close, its heartbeat just stops (simulated with a later clock below).

	// Task B starts while C's heartbeat is still fresh: it takes A's batch only.
	const delivered: Array<Record<string, any>> = [];
	const up = (async (_url: string, init: RequestInit) => {
		delivered.push(JSON.parse(String(init.body)));
		return new Response(null, { status: 202 });
	}) as typeof fetch;
	const b = new SinkOutbox(root, { shared: true, instance: "task-b" });
	const forwarderB = new SinkForwarder(sinkCfg, up, {}, { outbox: b, pending: b.open() });
	await waitFor(() => delivered.length === 1);
	assert.equal(delivered[0]!.metrics[0].bucketAt, new Date(60_000).toISOString());
	assert.equal(existsSync(join(root, "task-a")), false, "A's directory is gone once adopted");

	// Two minutes later C has missed its heartbeats: B adopts it; L is live.
	const in130s = new Date(Date.now() + 130_000);
	utimesSync(join(root, "task-l", ".heartbeat"), in130s, in130s); // L keeps beating
	const later = new SinkOutbox(root, { shared: true, instance: "task-b", now: () => Date.now() + 130_000 });
	const adopted = later.adoptOrphans();
	assert.deepEqual(adopted.map((r) => JSON.parse(r.body).metrics[0].bucketAt), [new Date(120_000).toISOString()]);
	assert.equal(existsSync(join(root, "task-c")), false);
	assert.ok(readdirSync(join(root, "task-l")).some((n) => n.endsWith(".json")), "a live task's batches stay with it");
	forwarderB.stop();
	forwarderC.stop();
	forwarderL.stop();
});

test("a 503 waits for sibling inserts still in flight, so an immediate retry writes nothing twice", async (t) => {
	// The metrics insert is refused at once; the spans insert is acknowledged
	// only later, as an async insert is after its buffer flushes.
	let refuseMetrics = true;
	const ch = await clickhouse((call) => (call.table === "runtime_metrics_1m" && refuseMetrics ? "auth" : "ok"));
	t.after(() => close(ch.server));
	const slow = await listen((req, body, res) => {
		const query = new URL(req.url ?? "/", "http://x").searchParams.get("query") ?? body;
		const forward = () =>
			void fetch(`${ch.url}${req.url}`, { method: "POST", body }).then(async (r) => {
				res.writeHead(r.status).end(await r.text());
			});
		if (/^INSERT/.test(query) && /runtime_spans/.test(query)) setTimeout(forward, 300);
		else forward();
	});
	t.after(() => close(slow.server));
	const app = await startApp(config({ clickhouseUrl: slow.url }));
	t.after(() => app.stop());
	const body = traceBody();
	const started = Date.now();
	assert.equal((await app.post("/v1/traces", body)).status, 503);
	assert.ok(Date.now() - started >= 250, "the 503 came after the slow sibling settled");
	assert.equal(ch.inserts("runtime_spans").length, 1, "the sibling committed before the answer");
	refuseMetrics = false;
	assert.equal((await app.post("/v1/traces", body)).status, 200);
	assert.equal(ch.inserts("runtime_spans").length, 1, "the retry did not write spans again");
	assert.equal(ch.inserts("runtime_metrics_1m").filter((c) => c.rows > 0).length, 2);
});
