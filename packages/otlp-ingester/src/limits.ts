import { createHash } from "node:crypto";
import type { Request } from "express";

/**
 * Rate limits (1.12.0). Every limit is a sliding window: the current
 * minute's count plus the previous minute's, weighted by how much of it is
 * still inside the window. Nothing resets on a minute boundary, so a burst
 * at 00:59 and another at 01:00 count together.
 *
 * A check asks "is there budget left?" and, when there is, charges the whole
 * cost. A request that carries 5,000 spans is let through while the tenant
 * has any record budget left, then charged 5,000: the overshoot is at most
 * one request, and a batch larger than the whole limit is still accepted
 * (once a window) instead of being refused forever. A refused request is not
 * charged, so a throttled tenant recovers as soon as the window slides.
 *
 * Where the counts live:
 * - With AUTTER_REDIS_URL, tenant limits, the unknown-key budgets and log
 *   promotion lookups are counted in Redis, shared by every replica. If
 *   Redis fails, that check falls back to this process's own count (logged
 *   at most once a minute) and is retried in Redis on the next request.
 * - Without it, counts are per process. AUTTER_INGESTER_REPLICAS (default 1)
 *   divides each shared limit across replicas, so N replicas behind an even
 *   load balancer still give a tenant about one limit, not N.
 * - The per-IP request limit is always per process: it runs on every request
 *   before the body is read, and must never wait on a network round trip.
 *
 * Memory is bounded: each in-process map keeps at most `maxKeys` entries
 * and evicts the least recently used one. Tenant maps only ever hold
 * tenants whose key resolved, so a flood of junk keys can't push a
 * throttled tenant out.
 */

export const WINDOW_MS = 60_000;

export interface LimitCheck {
	/** Identifies the counter. Checks in one `take` call must share a tenant (see RedisLimitStore). */
	key: string;
	/** Units this request uses: 1 for a request, the record count for records. */
	cost: number;
	/** Units per minute. */
	limit: number;
}

export interface LimitDecision {
	allowed: boolean;
	/** When refused: how long until the window has budget again (for Retry-After). */
	retryAfterMs: number;
}

export interface LimitStore {
	readonly kind: "memory" | "redis";
	/** Allowed only when every check has budget left; then all of them are charged. */
	take(checks: LimitCheck[]): Promise<LimitDecision>;
	close?(): Promise<void>;
}

/** A Map that evicts its least recently used entry past `max` entries. */
export class LruMap<K, V> {
	private readonly map = new Map<K, V>();

	constructor(readonly max: number) {}

	get size(): number {
		return this.map.size;
	}

	/** Read and mark as recently used. */
	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value === undefined) return undefined;
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	/** Read without changing the eviction order. */
	peek(key: K): V | undefined {
		return this.map.get(key);
	}

	has(key: K): boolean {
		return this.map.has(key);
	}

	set(key: K, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next().value as K;
			this.map.delete(oldest);
		}
	}

	delete(key: K): boolean {
		return this.map.delete(key);
	}
}

interface Window {
	/** Index of the current minute (now / WINDOW_MS). */
	bucket: number;
	current: number;
	previous: number;
}

/** Sliding-window estimate and refill time for one counter. Shared by both stores (the Lua script mirrors it). */
function slide(window: Window | undefined, now: number): Window {
	const bucket = Math.floor(now / WINDOW_MS);
	if (!window) return { bucket, current: 0, previous: 0 };
	if (window.bucket === bucket) return window;
	if (window.bucket === bucket - 1) return { bucket, current: 0, previous: window.current };
	return { bucket, current: 0, previous: 0 };
}

function estimate(window: Window, now: number): number {
	const elapsed = now - window.bucket * WINDOW_MS;
	return window.previous * ((WINDOW_MS - elapsed) / WINDOW_MS) + window.current;
}

/** Time until `estimate + 1 <= limit` (the next request would fit). */
function refillMs(window: Window, limit: number, now: number): number {
	const elapsed = now - window.bucket * WINDOW_MS;
	const untilNextBucket = WINDOW_MS - elapsed;
	if (window.current + 1 > limit) {
		// Even with the previous minute fully gone this minute is over: wait for
		// the next one, then for its own previous (this one) to slide out enough.
		const spill = window.current - (limit - 1);
		return untilNextBucket + Math.ceil((spill / Math.max(1, window.current)) * WINDOW_MS);
	}
	if (window.previous <= 0) return 0;
	// previous * (W - t) / W + current <= limit - 1  →  t >= W * (1 - (limit - 1 - current) / previous)
	const t = WINDOW_MS * (1 - (limit - 1 - window.current) / window.previous);
	return Math.max(0, Math.ceil(t - elapsed));
}

export class MemoryLimitStore implements LimitStore {
	readonly kind = "memory" as const;
	private readonly windows: LruMap<string, Window>;

	constructor(
		maxKeys = 100_000,
		private readonly now: () => number = Date.now,
	) {
		this.windows = new LruMap(maxKeys);
	}

	get size(): number {
		return this.windows.size;
	}

	takeSync(checks: LimitCheck[]): LimitDecision {
		const now = this.now();
		const slid = checks.map((check) => slide(this.windows.get(check.key), now));
		let retryAfterMs = 0;
		checks.forEach((check, index) => {
			const window = slid[index]!;
			if (estimate(window, now) + 1 > check.limit) {
				retryAfterMs = Math.max(retryAfterMs, refillMs(window, check.limit, now), 1);
			}
		});
		if (retryAfterMs > 0) {
			// Not charged; keep the slid windows so the map stays current.
			checks.forEach((check, index) => this.windows.set(check.key, slid[index]!));
			return { allowed: false, retryAfterMs };
		}
		checks.forEach((check, index) => {
			const window = slid[index]!;
			this.windows.set(check.key, { ...window, current: window.current + check.cost });
		});
		return { allowed: true, retryAfterMs: 0 };
	}

	async take(checks: LimitCheck[]): Promise<LimitDecision> {
		return this.takeSync(checks);
	}
}

/**
 * Every check of one call in one atomic script. Each counter is a hash
 * {b: minute index, c: current count, p: previous count} read and written
 * with the Redis server's clock (TIME), so replicas with skewed clocks agree.
 * Callers put the tenant in a `{hash tag}` so all keys of a call land in
 * one Redis Cluster slot.
 */
const TAKE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local bucket = math.floor(now / window)
local elapsed = now - bucket * window
local n = #KEYS
local cur = {}
local prev = {}
local retry = 0
for i = 1, n do
  local stored = redis.call('HMGET', KEYS[i], 'b', 'c', 'p')
  local b = tonumber(stored[1])
  local c = tonumber(stored[2]) or 0
  local p = tonumber(stored[3]) or 0
  if b == nil then c = 0; p = 0
  elseif b == bucket - 1 then p = c; c = 0
  elseif b ~= bucket then c = 0; p = 0 end
  cur[i] = c
  prev[i] = p
  local limit = tonumber(ARGV[1 + 2 * i])
  local estimate = p * (window - elapsed) / window + c
  if estimate + 1 > limit then
    local wait
    if c + 1 > limit then
      wait = (window - elapsed) + math.ceil(((c - (limit - 1)) / math.max(1, c)) * window)
    else
      wait = math.ceil(window * (1 - (limit - 1 - c) / p) - elapsed)
    end
    if wait < 1 then wait = 1 end
    if wait > retry then retry = wait end
  end
end
for i = 1, n do
  local c = cur[i]
  if retry == 0 then c = c + tonumber(ARGV[2 * i]) end
  redis.call('HSET', KEYS[i], 'b', bucket, 'c', c, 'p', prev[i])
  redis.call('PEXPIRE', KEYS[i], window * 2)
end
if retry == 0 then return {1, 0} end
return {0, retry}
`;

/** The subset of ioredis this store uses (lets tests pass a stand-in). */
export interface RedisLike {
	eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
	evalsha(sha: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
	quit(): Promise<unknown>;
	/** Drop the connection now and stop reconnecting. */
	disconnect(): void;
}

const TAKE_SCRIPT_SHA = createHash("sha1").update(TAKE_SCRIPT).digest("hex");

export class RedisLimitStore implements LimitStore {
	readonly kind = "redis" as const;
	private readonly client: Promise<RedisLike>;

	/** `redis` may still be connecting: checks made before it is ready (or if it never is) fall back. */
	constructor(
		redis: RedisLike | Promise<RedisLike>,
		private readonly prefix = "autter:rl:",
	) {
		this.client = Promise.resolve(redis);
		// A failed connect is reported by each take() (and logged by RateLimits), not as an unhandled rejection.
		this.client.catch(() => {});
	}

	async take(checks: LimitCheck[]): Promise<LimitDecision> {
		if (checks.length === 0) return { allowed: true, retryAfterMs: 0 };
		const keys = checks.map((check) => this.prefix + check.key);
		const args: Array<string | number> = [WINDOW_MS];
		for (const check of checks) args.push(Math.max(0, Math.ceil(check.cost)), check.limit);
		const redis = await this.client;
		let result: [number, number];
		try {
			result = (await redis.evalsha(TAKE_SCRIPT_SHA, keys.length, ...keys, ...args)) as [number, number];
		} catch (err) {
			// First call on this Redis (or after a restart / SCRIPT FLUSH): send the script itself.
			if (!(err instanceof Error) || !err.message.includes("NOSCRIPT")) throw err;
			result = (await redis.eval(TAKE_SCRIPT, keys.length, ...keys, ...args)) as [number, number];
		}
		return { allowed: Number(result[0]) === 1, retryAfterMs: Number(result[1]) };
	}

	async close(): Promise<void> {
		const redis = await this.client.catch(() => null);
		if (!redis) return;
		// QUIT when connected; either way stop reconnecting so shutdown isn't held open.
		await Promise.race([redis.quit().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500).unref())]);
		redis.disconnect();
	}
}

/** Connect to Redis for shared limits. Commands fail fast (no offline queue) so a Redis outage falls back instead of stalling ingest. */
export async function connectRedis(url: string): Promise<RedisLike> {
	const { Redis } = await import("ioredis");
	const client = new Redis(url, {
		enableOfflineQueue: false,
		maxRetriesPerRequest: 1,
		commandTimeout: 250,
		connectTimeout: 2_000,
		// Keep reconnecting in the background, at most every 5 s.
		retryStrategy: (times) => Math.min(times * 200, 5_000),
	});
	let lastLog = 0;
	client.on("error", (err: Error) => {
		if (Date.now() - lastLog < 60_000) return;
		lastLog = Date.now();
		console.warn(`rate limit redis error (limits fall back to this process): ${err.message}`);
	});
	// Commands sent before the connection is ready fail (no offline queue):
	// wait for it, up to the connect timeout. Checks made meanwhile fall back.
	await new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			client.off("ready", done);
			resolve();
		};
		const timer = setTimeout(done, 2_000);
		timer.unref();
		client.once("ready", done);
	});
	return client;
}

export interface RateLimitsOptions {
	/** Shared store (Redis), or null for per-process counting. */
	shared: LimitStore | null;
	/** Replicas the per-process fallback divides limits across. */
	replicas: number;
	now?: () => number;
	log?: (message: string) => void;
}

/**
 * Tenant-level limits: shared when a store is configured, per process
 * (divided by replicas) otherwise or while the shared store is failing.
 */
export class RateLimits {
	private readonly local: MemoryLimitStore;
	private readonly replicas: number;
	private readonly log: (message: string) => void;
	private lastFallbackLog = 0;
	private fallbacks = 0;

	constructor(private readonly options: RateLimitsOptions) {
		this.local = new MemoryLimitStore(100_000, options.now);
		this.replicas = Math.max(1, Math.floor(options.replicas));
		this.log = options.log ?? ((message) => console.warn(message));
	}

	get mode(): "redis" | "memory" {
		return this.options.shared ? "redis" : "memory";
	}

	/** Checks that fell back to the process's own count because the shared store failed. */
	get fallbackCount(): number {
		return this.fallbacks;
	}

	async take(checks: LimitCheck[]): Promise<LimitDecision> {
		const shared = this.options.shared;
		if (shared) {
			try {
				return await shared.take(checks);
			} catch (err) {
				this.fallbacks += 1;
				const now = Date.now();
				if (now - this.lastFallbackLog >= 60_000) {
					this.lastFallbackLog = now;
					this.log(
						`rate limit store unavailable, counting in this process until it is back: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
		return this.local.takeSync(checks.map((check) => ({ ...check, limit: this.localLimit(check.limit) })));
	}

	private localLimit(limit: number): number {
		return Math.max(1, Math.ceil(limit / this.replicas));
	}

	async close(): Promise<void> {
		await this.options.shared?.close?.();
	}
}

/**
 * The address a per-IP limit counts against: Express's `req.ip` (which
 * honours TRUST_PROXY), with IPv6 addresses grouped by /64 (one host
 * usually owns a whole /64, so per-address limits would not hold).
 */
export function clientAddress(req: Request): string {
	const ip = req.ip ?? req.socket.remoteAddress ?? "";
	return addressGroup(ip);
}

export function addressGroup(ip: string): string {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) return mapped[1]!;
	if (!ip.includes(":")) return ip;
	const [head = "", tail = ""] = ip.toLowerCase().split("::", 2) as [string, string?];
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const missing = Math.max(0, 8 - left.length - right.length);
	const groups = ip.includes("::") ? [...left, ...Array(missing).fill("0"), ...right] : left;
	return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Seconds for a Retry-After header (at least 1). */
export function retryAfterSeconds(ms: number): string {
	return String(Math.max(1, Math.ceil(ms / 1000)));
}
