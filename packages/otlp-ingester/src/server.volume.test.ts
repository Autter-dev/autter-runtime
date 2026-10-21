import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { loadConfig, type IngesterConfig } from "./config.js";
import type { IngestDropRow } from "./ingest-drops.js";
import { createIngesterApp } from "./server.js";
import type { RuntimeOccurrence } from "./types.js";

/**
 * EI-38 over the wire: a loop of 10,000 errors a minute is stored as N
 * occurrences plus one sample, while the sink webhook receives the exact
 * count (Σ `count ?? 1` = 10,000) and the error rollups count every error;
 * the folded payloads are counted as `collapsed` drops. Suppression rules
 * delivered with the key (validator answer or static entry) drop or sample
 * before anything is stored, counted as `suppressed`. ClickHouse is stubbed;
 * the sink is a real HTTP endpoint.
 */

const SERVER = `autter_rt_${"4".repeat(48)}`;
const RULED = `autter_rt_${"3".repeat(48)}`;
const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n);

interface SinkOccurrence {
	occurrenceId: string;
	fingerprint: string;
	errorType: string;
	count?: number;
}

async function sinkStub(t: TestContext) {
	const batches: Array<{ occurrences: SinkOccurrence[]; metrics: Array<{ errorCount: number }> }> = [];
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
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/runtime/sink`,
		occurrences: () => batches.flatMap((b) => b.occurrences),
		errorCount: () => batches.flatMap((b) => b.metrics).reduce((n, m) => n + m.errorCount, 0),
		/** Wait until the sink saw `count` events (weights summed). */
		async events(count: number): Promise<number> {
			const total = () => batches.flatMap((b) => b.occurrences).reduce((n, o) => n + (o.count ?? 1), 0);
			for (let i = 0; i < 200 && total() < count; i++) await new Promise((r) => setTimeout(r, 25));
			return total();
		},
	};
}

async function start(t: TestContext, overrides: Partial<IngesterConfig> = {}) {
	const ingester = createIngesterApp({
		...loadConfig(),
		clickhouseUrl: "http://127.0.0.1:1",
		maxBodyBytes: 16 * 1024 * 1024,
		rateLimitPerMinute: 1000,
		loopCollapseAfter: 10,
		ingestKeys: [{ key: SERVER, orgId: "org-v", repositoryId: "repo-v" }],
		...overrides,
	});
	const { app, store, drops, collapse } = ingester;
	const stub = store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) stub[name] = async () => {};
	}
	stub.ensureSchema = async () => {};
	stub.recentOccurrenceTraceIds = async () => new Set();
	stub.lookupSourceMap = async () => null;
	const stored: RuntimeOccurrence[] = [];
	let failNextOccurrenceWrite = false;
	store.insertOccurrences = async (_ctx, occurrences) => {
		if (failNextOccurrenceWrite) {
			failNextOccurrenceWrite = false;
			throw new Error("clickhouse down");
		}
		stored.push(...occurrences);
	};
	const dropRows: IngestDropRow[] = [];
	store.insertIngestDrops = async (rows) => void dropRows.push(...rows);
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
		stored,
		failNextOccurrenceWrite: () => {
			failNextOccurrenceWrite = true;
		},
		post: (path: string, key: string, body: unknown) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
				body: JSON.stringify(body),
			}),
		async drops(): Promise<IngestDropRow[]> {
			await drops.flush();
			return dropRows;
		},
	};
}

/**
 * Windows are per arrival minute: start a test that must stay in one minute
 * at least 10 s before the minute ends (each takes well under a second).
 */
async function awayFromMinuteEdge(): Promise<void> {
	const intoMinute = Date.now() % 60_000;
	if (intoMinute > 50_000) await new Promise((r) => setTimeout(r, 60_000 - intoMinute + 500));
}

let traceSerial = 0;
/** `count` failing job spans, each its own trace, each with the same looping exception. */
function loopingErrors(count: number, at = Date.now()) {
	return {
		resourceSpans: [{
			resource: { attributes: [
				{ key: "service.name", value: { stringValue: "worker" } },
				{ key: "deployment.environment", value: { stringValue: "production" } },
			] },
			scopeSpans: [{ spans: Array.from({ length: count }, (_, i) => {
				traceSerial += 1;
				return {
					traceId: traceSerial.toString(16).padStart(32, "0"),
					spanId: (i + 1).toString(16).padStart(16, "0"),
					name: "sync-job",
					kind: 1,
					startTimeUnixNano: nanos(at),
					endTimeUnixNano: nanos(at + 1),
					status: { code: 2 },
					events: [{
						name: "exception",
						timeUnixNano: nanos(at),
						attributes: [
							{ key: "exception.type", value: { stringValue: "ConnectionError" } },
							{ key: "exception.message", value: { stringValue: `connection to db-${traceSerial % 7} reset after ${traceSerial} ms` } },
							{ key: "exception.stacktrace", value: { stringValue: "ConnectionError: reset\n    at connect (/app/src/db.ts:41:11)\n    at syncJob (/app/src/jobs/sync.ts:12:3)" } },
						],
					}],
				};
			}) }],
		}],
	};
}

test("a loop of 10,000 errors a minute: N stored + one sample, and the sink counts exactly 10,000", async (t) => {
	await awayFromMinuteEdge();
	const sink = await sinkStub(t);
	const app = await start(t, { sinkUrl: sink.url });
	// Ten exports of 1,000 within the minute.
	for (let batch = 0; batch < 10; batch++) {
		const res = await app.post("/v1/traces", SERVER, loopingErrors(1_000));
		assert.equal(res.status, 200, await res.text());
	}
	assert.equal(app.stored.length, 10, "the first N occurrences are stored as they arrive");
	// The minute's sample is stored when its minute is over (or at shutdown).
	await app.ingester.collapse.flush(true);
	assert.equal(app.stored.length, 11, "N individual rows + one collapsed sample");
	const sample = app.stored.find((o) => o.collapsedCount);
	assert.equal(sample?.collapsedCount, 9_989);
	assert.equal(app.stored.reduce((n, o) => n + 1 + (o.collapsedCount ?? 0), 0), 10_000, "stored rows + collapsed_count");
	// The sink (issue counts, EI-32's buckets) sees the exact count…
	assert.equal(await sink.events(10_000), 10_000);
	const weighted = sink.occurrences().filter((o) => (o.count ?? 1) > 1);
	assert.equal(weighted.length, 1);
	assert.equal(weighted[0]!.count, 9_990);
	assert.equal(new Set(sink.occurrences().map((o) => o.fingerprint)).size, 1, "one issue");
	// …and so do the error rollups (hourly counts): every error, not every row.
	assert.equal(sink.errorCount(), 10_000);
	// The payloads not stored are explained as collapsed drops.
	const collapsed = (await app.drops()).filter((row) => row.reason === "collapsed");
	assert.deepEqual(
		collapsed.map((row) => [row.route, row.kind, row.requests, row.records, row.orgId, row.repositoryId]),
		[["/v1/traces", "collapsed", 0, 9_989, "org-v", "repo-v"]],
	);
});

test("a write that fails gives its folds back: the exporter's retry is counted once", async (t) => {
	await awayFromMinuteEdge();
	const sink = await sinkStub(t);
	const app = await start(t, { sinkUrl: sink.url });
	const batch = loopingErrors(50);
	app.failNextOccurrenceWrite();
	assert.equal((await app.post("/v1/traces", SERVER, batch)).status, 503);
	assert.equal((await app.post("/v1/traces", SERVER, batch)).status, 200);
	// A lost 2xx: the exporter sends the same batch again.
	assert.equal((await app.post("/v1/traces", SERVER, batch)).status, 200);
	await app.ingester.collapse.flush(true);
	const ids = new Set(app.stored.map((o) => o.occurrenceId));
	const sample = app.stored.find((o) => o.collapsedCount);
	assert.equal(ids.size, 11);
	assert.equal(sample?.collapsedCount, 39);
	// Duplicate rows share an id (deduped by readers); the count stays 50.
	assert.equal(ids.size + (sample?.collapsedCount ?? 0), 50);
});

test("suppression rules from the key validator drop and sample before anything is stored", async (t) => {
	await awayFromMinuteEdge();
	const sink = await sinkStub(t);
	let validations = 0;
	const validator = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			validations += 1;
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
				orgId: "org-v",
				repositoryId: "repo-rules",
				scope: "server",
				suppression: [
					{ id: "rsr_drop", action: "drop", filters: [{ key: "errorType", op: "equals", value: "AbortError" }] },
					{ id: "rsr_bad", action: "explode", filters: [] },
					{ id: "rsr_sample", action: "sample", sampleRate: 0.5, filters: [{ key: "message", op: "matches", value: "resizeobserver loop*" }] },
				],
			}));
		});
	});
	await new Promise<void>((resolve) => validator.listen(0, "127.0.0.1", resolve));
	t.after(() => validator.close());
	const app = await start(t, {
		sinkUrl: sink.url,
		ingestKeys: [],
		keyValidatorUrl: `http://127.0.0.1:${(validator.address() as AddressInfo).port}/runtime/validate-key`,
	});
	const at = new Date().toISOString();
	const event = (errorType: string, message: string, severity = "error") => ({
		type: "exception", timestamp: at, errorType, message, severity,
		stack: `${errorType}: ${message}\n    at app (https://app.test/main.js:1:${Math.floor(Math.random() * 1e6)})`,
	});
	const payload = (events: unknown[]) => ({ version: 1, service: "web", environment: "production", sessionId: "s_1", events });
	let resize = 0;
	for (let round = 0; round < 10; round++) {
		const res = await app.post("/v1/browser", RULED, payload([
			event("AbortError", "The user aborted a request."),
			event("AbortError", "The user aborted a request.", "fatal"),
			...Array.from({ length: 20 }, () => event("Error", `ResizeObserver loop completed with undelivered notifications ${resize++}`)),
			event("TypeError", "x is not a function"),
		]));
		assert.equal(res.status, 202, await res.text());
	}
	assert.equal(validations, 1, "rules are cached with the key");
	await app.ingester.collapse.flush(true);
	const kept = app.stored.reduce((n, o) => n + 1 + (o.collapsedCount ?? 0), 0);
	const byType = (type: string) => app.stored.filter((o) => o.errorType === type).reduce((n, o) => n + 1 + (o.collapsedCount ?? 0), 0);
	assert.equal(byType("AbortError"), 0, "drop: fatal ones too, the rule says so");
	assert.equal(byType("TypeError"), 10, "no rule: kept");
	const sampled = byType("Error");
	assert.ok(sampled > 60 && sampled < 140, `about half of 200 sampled in, got ${sampled}`);
	const suppressed = (await app.drops()).filter((row) => row.reason === "suppressed");
	assert.equal(suppressed.reduce((n, row) => n + row.records, 0), 20 + (200 - sampled));
	assert.deepEqual([...new Set(suppressed.map((row) => `${row.route} ${row.kind} ${row.requests}`))], ["/v1/browser suppressed 0"]);
	assert.equal(kept + 20 + (200 - sampled), 230, "every event is stored, collapsed or suppressed");
});

test("a static key's suppression rules apply too", async (t) => {
	const app = await start(t, {
		ingestKeys: [{
			key: SERVER,
			orgId: "org-v",
			repositoryId: "repo-v",
			suppression: [{ id: "worker-noise", action: "drop", filters: [
				{ key: "service", op: "equals", value: "worker" },
				{ key: "errorType", op: "starts_with", value: "connection" },
			] }],
		}],
	});
	assert.equal((await app.post("/v1/traces", SERVER, loopingErrors(30))).status, 200);
	await app.ingester.collapse.flush(true);
	assert.equal(app.stored.length, 0);
	const suppressed = (await app.drops()).filter((row) => row.reason === "suppressed");
	assert.equal(suppressed.reduce((n, row) => n + row.records, 0), 30);
});

test("LOOP_COLLAPSE_AFTER=0 stores every occurrence", async (t) => {
	const app = await start(t, { loopCollapseAfter: 0 });
	assert.equal((await app.post("/v1/traces", SERVER, loopingErrors(40))).status, 200);
	await app.ingester.collapse.flush(true);
	assert.equal(app.stored.length, 40);
	assert.equal(app.stored.some((o) => o.collapsedCount), false);
});
