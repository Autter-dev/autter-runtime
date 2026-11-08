import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { limitsWarning } from "./config.js";
import {
	addressGroup,
	connectRedis,
	LruMap,
	MemoryLimitStore,
	RateLimits,
	RedisLimitStore,
	WINDOW_MS,
	type LimitStore,
} from "./limits.js";

/** A clock the test moves by hand, starting at a minute boundary. */
function clock(start = 1_000 * WINDOW_MS) {
	let now = start;
	return { now: () => now, set: (ms: number) => (now = start + ms) };
}

test("sliding window: a full minute does not reset at the boundary (fixed-window burst)", () => {
	const time = clock();
	const store = new MemoryLimitStore(100, time.now);
	const check = [{ key: "t", cost: 1, limit: 10 }];
	time.set(59_000);
	for (let i = 0; i < 10; i++) assert.equal(store.takeSync(check).allowed, true, `request ${i}`);
	assert.equal(store.takeSync(check).allowed, false);
	// A fixed window would give 10 more right after the boundary.
	time.set(61_000);
	assert.equal(store.takeSync(check).allowed, false, "previous minute still counts");
	// Half the previous minute has slid out: about 5 fit.
	time.set(90_000);
	let allowed = 0;
	for (let i = 0; i < 10; i++) if (store.takeSync(check).allowed) allowed++;
	assert.ok(allowed >= 4 && allowed <= 5, `allowed ${allowed}`);
});

test("refused requests are not charged, and Retry-After points at real budget", () => {
	const time = clock();
	const store = new MemoryLimitStore(100, time.now);
	const check = [{ key: "t", cost: 1, limit: 3 }];
	for (let i = 0; i < 3; i++) store.takeSync(check);
	const refused = store.takeSync(check);
	assert.equal(refused.allowed, false);
	assert.ok(refused.retryAfterMs > 0);
	for (let i = 0; i < 100; i++) store.takeSync(check);
	time.set(refused.retryAfterMs + WINDOW_MS);
	assert.equal(store.takeSync(check).allowed, true, "100 refusals did not extend the wait");
});

test("records, not requests: one tenant can't send 300 × 5000 spans under a request limit", () => {
	const time = clock();
	const store = new MemoryLimitStore(100, time.now);
	const request = (records: number) =>
		store.takeSync([
			{ key: "t:requests", cost: 1, limit: 300 },
			{ key: "t:records", cost: records, limit: 10_000 },
		]).allowed;
	assert.equal(request(5000), true);
	assert.equal(request(5000), true);
	// Budget spent (10,000 records) after 2 of 300 requests.
	assert.equal(request(5000), false);
	assert.equal(request(1), false);
	// A batch bigger than the whole limit still gets in once a window.
	const big = new MemoryLimitStore(100, time.now);
	assert.equal(big.takeSync([{ key: "b", cost: 50_000, limit: 10_000 }]).allowed, true);
	assert.equal(big.takeSync([{ key: "b", cost: 1, limit: 10_000 }]).allowed, false);
});

test("a refused check charges none of the request's counters", () => {
	const store = new MemoryLimitStore(100, clock().now);
	assert.equal(store.takeSync([{ key: "r", cost: 1, limit: 5 }, { key: "n", cost: 10, limit: 10 }]).allowed, true);
	// records refuse; the request counter must not move.
	for (let i = 0; i < 20; i++) store.takeSync([{ key: "r", cost: 1, limit: 5 }, { key: "n", cost: 10, limit: 10 }]);
	assert.equal(store.takeSync([{ key: "r", cost: 1, limit: 5 }]).allowed, true);
});

test("LRU eviction: flooding distinct keys evicts the coldest, never clears a throttled tenant", () => {
	const time = clock();
	const store = new MemoryLimitStore(1_000, time.now);
	const tenant = [{ key: "victim", cost: 1, limit: 2 }];
	store.takeSync(tenant);
	store.takeSync(tenant);
	assert.equal(store.takeSync(tenant).allowed, false);
	// The old limiter cleared its whole map past 50k keys. Interleave a flood
	// of 60,000 distinct keys with the throttled tenant's own retries.
	for (let i = 0; i < 60_000; i++) {
		store.takeSync([{ key: `junk-${i}`, cost: 1, limit: 2 }]);
		if (i % 500 === 0) assert.equal(store.takeSync(tenant).allowed, false, `still throttled after ${i} junk keys`);
	}
	assert.equal(store.takeSync(tenant).allowed, false);
	assert.equal(store.size, 1_000, "bounded");

	const lru = new LruMap<string, number>(3);
	lru.set("a", 1);
	lru.set("b", 2);
	lru.set("c", 3);
	lru.get("a");
	lru.set("d", 4);
	assert.equal(lru.has("b"), false, "least recently used left");
	assert.deepEqual(["a", "c", "d"].map((k) => lru.has(k)), [true, true, true]);
});

test("without a shared store, each of N replicas enforces limit / N", async () => {
	const replicas = [0, 1, 2].map(() => new RateLimits({ shared: null, replicas: 3, now: clock().now }));
	let allowed = 0;
	for (let i = 0; i < 20; i++) {
		for (const replica of replicas) if ((await replica.take([{ key: "t", cost: 1, limit: 30 }])).allowed) allowed++;
	}
	assert.equal(allowed, 30, "three replicas together let one limit through, not three");
	assert.equal(replicas[0]!.mode, "memory");
});

test("a failing shared store falls back to the process's own count and logs once a minute", async () => {
	const logs: string[] = [];
	const broken: LimitStore = { kind: "redis", take: async () => { throw new Error("ECONNREFUSED"); } };
	const limits = new RateLimits({ shared: broken, replicas: 2, now: clock().now, log: (m) => logs.push(m) });
	let allowed = 0;
	for (let i = 0; i < 20; i++) if ((await limits.take([{ key: "t", cost: 1, limit: 10 }])).allowed) allowed++;
	assert.equal(allowed, 5, "fallback divides by replicas");
	assert.equal(limits.fallbackCount, 20);
	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /ECONNREFUSED/);
});

test("startup warning: several replicas without Redis", () => {
	assert.equal(limitsWarning({ redisUrl: null, replicas: 1 }), null);
	assert.equal(limitsWarning({ redisUrl: "redis://r:6379", replicas: 4 }), null);
	assert.match(limitsWarning({ redisUrl: null, replicas: 4 })!, /AUTTER_INGESTER_REPLICAS=4 but AUTTER_REDIS_URL is not set.*1\/4/);
});

test("client addresses: IPv6 grouped by /64, IPv4-mapped unwrapped", () => {
	assert.equal(addressGroup("203.0.113.9"), "203.0.113.9");
	assert.equal(addressGroup("::ffff:203.0.113.9"), "203.0.113.9");
	assert.equal(addressGroup("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
	assert.equal(addressGroup("2001:db8:1:2::1"), "2001:db8:1:2::/64");
	assert.equal(addressGroup("2001:db8::1"), "2001:db8:0:0::/64");
	assert.equal(addressGroup("2001:0db8:0001:0002:ffff::"), "2001:db8:1:2::/64");
});

// ── Redis (skipped when redis-server is not installed) ──────────────────────

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
	});
}

async function startRedis(): Promise<{ url: string; stop: () => void }> {
	const port = await freePort();
	const child: ChildProcess = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("redis-server did not start")), 5_000);
		child.stdout!.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("Ready to accept connections")) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	return { url: `redis://127.0.0.1:${port}`, stop: () => child.kill("SIGKILL") };
}

test("Redis: two replicas share one tenant limit (requests and records)", { skip: !hasRedis && "redis-server not installed" }, async (t) => {
	const redis = await startRedis();
	t.after(redis.stop);
	const stores = [new RedisLimitStore(connectRedis(redis.url)), new RedisLimitStore(connectRedis(redis.url))];
	t.after(() => Promise.all(stores.map((s) => s.close())));
	// Replicas declared, but the shared store makes the division unnecessary.
	const replicas = stores.map((shared) => new RateLimits({ shared, replicas: 2 }));
	let allowed = 0;
	for (let i = 0; i < 10; i++) {
		for (const replica of replicas) if ((await replica.take([{ key: "{t}:requests", cost: 1, limit: 6 }])).allowed) allowed++;
	}
	assert.equal(allowed, 6, "one limit across both replicas");
	assert.equal(replicas[0]!.fallbackCount + replicas[1]!.fallbackCount, 0);

	const records = (store: RedisLimitStore, cost: number) =>
		store.take([{ key: "{r}:requests", cost: 1, limit: 100 }, { key: "{r}:records", cost, limit: 1_000 }]);
	assert.equal((await records(stores[0]!, 900)).allowed, true);
	assert.equal((await records(stores[1]!, 900)).allowed, true, "budget left: let in, charged in full");
	const refused = await records(stores[0]!, 1);
	assert.equal(refused.allowed, false);
	assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 2 * WINDOW_MS, String(refused.retryAfterMs));
});

test("Redis: the script is reloaded after SCRIPT FLUSH, and an outage falls back", { skip: !hasRedis && "redis-server not installed" }, async (t) => {
	const redis = await startRedis();
	let stopped = false;
	t.after(() => {
		if (!stopped) redis.stop();
	});
	const client = await connectRedis(redis.url);
	const store = new RedisLimitStore(client);
	t.after(() => store.close());
	assert.equal((await store.take([{ key: "{f}:x", cost: 1, limit: 5 }])).allowed, true);
	await (client as unknown as { script(cmd: string): Promise<unknown> }).script("FLUSH");
	assert.equal((await store.take([{ key: "{f}:x", cost: 1, limit: 5 }])).allowed, true, "NOSCRIPT handled");

	const logs: string[] = [];
	const limits = new RateLimits({ shared: store, replicas: 1, log: (m) => logs.push(m) });
	redis.stop();
	stopped = true;
	await new Promise((resolve) => setTimeout(resolve, 200));
	const decision = await limits.take([{ key: "{f}:x", cost: 1, limit: 5 }]);
	assert.equal(decision.allowed, true, "counted locally while Redis is down");
	assert.equal(limits.fallbackCount, 1);
	assert.equal(logs.length, 1);
});
