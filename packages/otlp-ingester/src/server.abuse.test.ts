import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { test } from "node:test";
import { loadConfig, type IngesterConfig } from "./config.js";
import { connectRedis, RedisLimitStore, type LimitStore } from "./limits.js";
import { createIngesterApp } from "./server.js";

/**
 * The abuses reported against the 1.11.0 ingester, reproduced over HTTP
 * against the real app (ClickHouse stubbed, a real validator that counts
 * its calls):
 *  - every unknown key made a validator POST (200 junk keys → 200 calls);
 *  - concurrent lookups of one key were not deduplicated (50 → 50 calls);
 *  - 404s and unparseable bodies still resolved keys;
 *  - the limiter counted requests, not records;
 *  - flooding the limiter with distinct keys reset a throttled tenant;
 *  - N replicas gave each tenant N times the limit.
 */

const GOOD = `autter_rt_${"1".repeat(48)}`;
const SECOND = `autter_rt_${"2".repeat(48)}`;
const junk = (i: number) => `autter_rt_${String(i).padStart(48, "0")}`;
const nanos = () => String(BigInt(Date.now()) * 1_000_000n);

const traces = (spans: number) => ({
	resourceSpans: [{
		resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
		scopeSpans: [{ spans: Array.from({ length: spans }, (_, i) => ({
			traceId: "a".repeat(32), spanId: (i + 1).toString(16).padStart(16, "0"), name: "work", kind: 2,
			startTimeUnixNano: nanos(), endTimeUnixNano: nanos(),
		})) }],
	}],
});

async function validator() {
	const state = { calls: 0, delayMs: 10 };
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			state.calls++;
			const { key } = JSON.parse(raw) as { key: string };
			setTimeout(() => {
				if (key === GOOD || key === SECOND) {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ orgId: "org", repositoryId: key === GOOD ? "repo" : "repo-2", scope: "server" }));
				} else {
					res.writeHead(404).end();
				}
			}, state.delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return Object.assign(state, {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/runtime/validate-key`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	});
}

type Validator = Awaited<ReturnType<typeof validator>>;

async function start(v: Validator, overrides: Partial<IngesterConfig> = {}, sharedLimits?: LimitStore | null) {
	const config: IngesterConfig = {
		...loadConfig(),
		clickhouseUrl: "http://127.0.0.1:1",
		ingestKeys: [],
		keyValidatorUrl: v.url,
		keyValidatorToken: null,
		sinkUrl: null,
		redisUrl: null,
		replicas: 1,
		...overrides,
	};
	const ingester = createIngesterApp(config, sharedLimits === undefined ? {} : { sharedLimits });
	const stub = ingester.store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(ingester.store))) {
		if (name.startsWith("insert")) stub[name] = async () => {};
	}
	stub.ensureSchema = async () => {};
	stub.probe = async () => ({ state: "up", checkedAt: new Date().toISOString(), latencyMs: 0 });
	stub.recentOccurrenceTraceIds = async () => new Set();
	stub.lookupSourceMap = async () => null;
	stub.ping = async () => true;
	const server = ingester.app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = (path: string, key: string | null, body: unknown, headers: Record<string, string> = {}) =>
		fetch(`${base}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(key ? { authorization: `Bearer ${key}` } : {}),
				...headers,
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	return {
		post,
		ingester,
		close: async () => {
			ingester.drops.stop();
			await ingester.limits.close();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		},
	};
}

test("200 junk keys cost at most the unknown-key budget in validator calls, the rest get 429", async (t) => {
	const v = await validator();
	v.delayMs = 0;
	const app = await start(v, { ipUnknownKeyLookupsPerMinute: 20, unknownKeyLookupsPerMinute: 1000 });
	t.after(async () => { await app.close(); await v.close(); });
	const statuses: number[] = [];
	for (let i = 0; i < 200; i++) {
		const res = await app.post("/v1/traces", junk(i), traces(1));
		statuses.push(res.status);
		if (res.status === 429) assert.ok(Number(res.headers.get("retry-after")) >= 1);
		await res.arrayBuffer();
	}
	assert.equal(v.calls, 20, "only the per-address budget reached the validator");
	assert.equal(statuses.filter((s) => s === 401).length, 20);
	assert.equal(statuses.filter((s) => s === 429).length, 180);
	// A good key this ingester has never seen, from the same address, waits
	// for the budget too: a 429 (exporters retry), never a 401.
	const fresh = await app.post("/v1/traces", GOOD, traces(1));
	assert.equal(fresh.status, 429);
});

test("the global unknown-key budget holds when junk comes from many addresses", async (t) => {
	const v = await validator();
	v.delayMs = 0;
	const app = await start(v, { ipUnknownKeyLookupsPerMinute: 1000, unknownKeyLookupsPerMinute: 15, trustProxy: 1 });
	t.after(async () => { await app.close(); await v.close(); });
	for (let i = 0; i < 60; i++) {
		const res = await app.post("/v1/traces", junk(i), traces(1), { "x-forwarded-for": `198.51.100.${i}` });
		await res.arrayBuffer();
	}
	assert.equal(v.calls, 15);
});

test("50 parallel requests with one new key make one validator call", async (t) => {
	const v = await validator();
	v.delayMs = 50;
	const app = await start(v);
	t.after(async () => { await app.close(); await v.close(); });
	const results = await Promise.all(Array.from({ length: 50 }, () => app.post("/v1/traces", GOOD, traces(1))));
	assert.ok(results.every((res) => res.status === 200), results.map((r) => r.status).join(","));
	assert.equal(v.calls, 1);
	const junkResults = await Promise.all(Array.from({ length: 50 }, () => app.post("/v1/traces", junk(7), traces(1))));
	assert.ok(junkResults.every((res) => res.status === 401));
	assert.equal(v.calls, 2);
});

test("404s, unparseable bodies and wrong content types never resolve keys", async (t) => {
	const v = await validator();
	const app = await start(v);
	t.after(async () => { await app.close(); await v.close(); });
	for (let i = 0; i < 50; i++) {
		assert.equal((await app.post("/v1/nope", junk(i), traces(1))).status, 404);
		assert.equal((await app.post("/v1/traces", junk(1000 + i), "{not json")).status, 400);
		assert.equal((await app.post("/v1/logs", junk(2000 + i), "x", { "content-type": "text/csv" })).status, 415);
		assert.equal((await app.post("/v1/profiles", junk(3000 + i), {})).status, 415);
		assert.equal((await app.post("/v1/browser", junk(4000 + i), "{bad", { "content-type": "text/plain" })).status, 400);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(v.calls, 0);
});

test("tenant limits count records, not just requests (sliding window, Retry-After)", async (t) => {
	const v = await validator();
	const app = await start(v, { rateLimitPerMinute: 1000, recordLimitPerMinute: 100 });
	t.after(async () => { await app.close(); await v.close(); });
	assert.equal((await app.post("/v1/traces", GOOD, traces(60))).status, 200);
	assert.equal((await app.post("/v1/traces", GOOD, traces(60))).status, 200, "budget left: let in, charged in full");
	const limited = await app.post("/v1/traces", GOOD, traces(1));
	assert.equal(limited.status, 429);
	assert.ok(Number(limited.headers.get("retry-after")) >= 1);
	// Another tenant is unaffected.
	assert.equal((await app.post("/v1/traces", SECOND, traces(60))).status, 200);
});

test("a flood of distinct junk keys does not reset a throttled tenant", async (t) => {
	const v = await validator();
	v.delayMs = 0;
	const app = await start(v, { rateLimitPerMinute: 3, ipUnknownKeyLookupsPerMinute: 10_000, unknownKeyLookupsPerMinute: 10_000 });
	t.after(async () => { await app.close(); await v.close(); });
	for (let i = 0; i < 3; i++) assert.equal((await app.post("/v1/traces", GOOD, traces(1))).status, 200);
	assert.equal((await app.post("/v1/traces", GOOD, traces(1))).status, 429);
	for (let i = 0; i < 300; i++) await (await app.post("/v1/traces", junk(i), traces(1))).arrayBuffer();
	assert.equal((await app.post("/v1/traces", GOOD, traces(1))).status, 429, "still throttled");
});

test("per-address request limit applies before the body or key is looked at", async (t) => {
	const v = await validator();
	const app = await start(v, { ipRateLimitPerMinute: 5, trustProxy: 1 });
	t.after(async () => { await app.close(); await v.close(); });
	for (let i = 0; i < 5; i++) await (await app.post("/v1/nope", junk(i), {}, { "x-forwarded-for": "203.0.113.1" })).arrayBuffer();
	const limited = await app.post("/v1/traces", GOOD, traces(1), { "x-forwarded-for": "203.0.113.1" });
	assert.equal(limited.status, 429);
	assert.ok(limited.headers.get("retry-after"));
	assert.equal(v.calls, 0, "refused before the key was resolved");
	// Another address (as the trusted proxy reports it) is unaffected.
	assert.equal((await app.post("/v1/traces", GOOD, traces(1), { "x-forwarded-for": "203.0.113.2" })).status, 200);
	// GETs (health checks) are never limited.
	for (let i = 0; i < 10; i++) assert.equal((await fetch(limited.url.replace("/v1/traces", "/healthz"))).status, 200);
});

test("without Redis, two replicas declared via AUTTER_INGESTER_REPLICAS split one tenant limit", async (t) => {
	const v = await validator();
	const replicas = [await start(v, { rateLimitPerMinute: 6, replicas: 2 }), await start(v, { rateLimitPerMinute: 6, replicas: 2 })];
	t.after(async () => { await Promise.all(replicas.map((r) => r.close())); await v.close(); });
	let accepted = 0;
	for (let i = 0; i < 10; i++) {
		for (const replica of replicas) if ((await replica.post("/v1/traces", GOOD, traces(1))).status === 200) accepted++;
	}
	assert.equal(accepted, 6);
});

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;

test("with Redis, replicas share one tenant limit and one unknown-key budget", { skip: !hasRedis && "redis-server not installed" }, async (t) => {
	const port = await new Promise<number>((resolve) => {
		const s = createNetServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as AddressInfo).port;
			s.close(() => resolve(p));
		});
	});
	const child = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: ["ignore", "pipe", "ignore"] });
	await new Promise<void>((resolve) => child.stdout!.on("data", (c: Buffer) => c.toString().includes("Ready to accept") && resolve()));
	t.after(() => child.kill("SIGKILL"));
	const v = await validator();
	v.delayMs = 0;
	const url = `redis://127.0.0.1:${port}`;
	const overrides = { rateLimitPerMinute: 6, ipUnknownKeyLookupsPerMinute: 8, unknownKeyLookupsPerMinute: 1000 };
	const replicas = [
		await start(v, overrides, new RedisLimitStore(connectRedis(url))),
		await start(v, overrides, new RedisLimitStore(connectRedis(url))),
		await start(v, overrides, new RedisLimitStore(connectRedis(url))),
	];
	t.after(async () => { await Promise.all(replicas.map((r) => r.close())); await v.close(); });
	let accepted = 0;
	for (let i = 0; i < 10; i++) {
		for (const replica of replicas) if ((await replica.post("/v1/traces", GOOD, traces(1))).status === 200) accepted++;
	}
	assert.equal(accepted, 6, "one limit across three replicas");
	// From another address: the good key's first lookup on each replica
	// already spent 3 of this address's budget, as it should.
	const before = v.calls;
	for (let i = 0; i < 30; i++) {
		await (await replicas[i % 3]!.post("/v1/traces", junk(i), traces(1), { "x-forwarded-for": "203.0.113.50" })).arrayBuffer();
	}
	assert.equal(v.calls - before, 8, "one unknown-key budget across three replicas");
	assert.equal(replicas.reduce((n, r) => n + r.ingester.limits.fallbackCount, 0), 0);
});
