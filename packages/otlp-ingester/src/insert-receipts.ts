import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Which tables an ingest request already wrote (1.12).
 *
 * One request fans out to several ClickHouse inserts with no transaction
 * across them. When one fails the request answers 503 and the exporter
 * retries the whole body — re-inserting the rows that did commit. For
 * runtime_metrics_1m (SummingMergeTree) and runtime_spans that inflated
 * request, error and regression counts.
 *
 * ClickHouse can drop a repeated block by its `insert_deduplication_token`
 * (clickhouse.ts sends one), but not for every deployment: ClickHouse 24.8
 * (the self-hosted production version) ignores the token for async inserts
 * into non-replicated MergeTree tables — the per-query token is only read by
 * ReplicatedMergeTree's async sink — and dedupes async inserts by default
 * only from 26.2. So the ingester keeps its own receipts:
 *
 * - in memory, per request digest: the tables whose insert committed. A
 *   retry skips them, and a retry that arrives while the first attempt is
 *   still writing waits for it (`coalesce`);
 * - in a journal file (INSERT_RECEIPTS_FILE, next to the sink outbox by
 *   default), appended right after each insert commits and reloaded at
 *   start, so a retry that arrives after a deploy or crash is still caught;
 * - in Redis (AUTTER_REDIS_URL) when set, so a retry that lands on another
 *   replica is caught too. A Redis failure falls back to this process's
 *   receipts.
 *
 * The digest covers the tenant, the route and the exact body, so only a
 * byte-identical re-send matches — two exports with equal content but
 * different timestamps never do. Bounded (oldest evicted) and short-lived
 * (OTLP exporters give up retrying within minutes).
 */

/** The subset of ioredis receipts use (limits.ts RedisLike satisfies it). */
export interface ReceiptRedis {
	eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface InsertReceiptsOptions {
	maxEntries?: number;
	ttlMs?: number;
	now?: () => number;
	/** Journal file; null = memory only. */
	file?: string | null;
	/** Shared receipts across replicas; may still be connecting. */
	redis?: ReceiptRedis | Promise<ReceiptRedis> | null;
	redisPrefix?: string;
	log?: (message: string) => void;
}

const MGET = "return redis.call('MGET', unpack(KEYS))";
const SETEX = "return redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])";

export class InsertReceipts {
	private readonly entries = new Map<string, { at: number; tables: Set<string> }>();
	private readonly inflight = new Map<string, Promise<unknown>>();
	private readonly maxEntries: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly file: string | null;
	private readonly redis: Promise<ReceiptRedis> | null;
	private readonly prefix: string;
	private readonly log: (message: string) => void;
	private journalLines = 0;
	private journalFailed = false;
	private lastRedisLog = Number.NEGATIVE_INFINITY;
	private redisFailures = 0;

	constructor(options: InsertReceiptsOptions = {}) {
		this.maxEntries = options.maxEntries ?? 10_000;
		this.ttlMs = options.ttlMs ?? 15 * 60_000;
		this.now = options.now ?? Date.now;
		this.file = options.file ?? null;
		this.redis = options.redis ? Promise.resolve(options.redis) : null;
		this.redis?.catch(() => {});
		this.prefix = options.redisPrefix ?? "autter:ir:";
		this.log = options.log ?? ((message) => console.warn(message));
		if (this.file) this.load(this.file);
	}

	/** Where receipts are kept: `memory`, `file`, `redis+file`, `redis`. */
	get mode(): string {
		return [this.redis ? "redis" : null, this.file && !this.journalFailed ? "file" : null].filter(Boolean).join("+") || "memory";
	}

	/**
	 * Of `tables`, those already written for this request digest: from this
	 * process (memory and journal), then Redis for the rest. Never throws.
	 */
	async committed(digest: string, tables: readonly string[] = []): Promise<ReadonlySet<string>> {
		const local = this.local(digest);
		const missing = tables.filter((table) => !local.has(table));
		if (!this.redis || missing.length === 0) return local;
		try {
			const redis = await this.redis;
			const found = (await redis.eval(MGET, missing.length, ...missing.map((t) => this.key(digest, t)))) as Array<string | null>;
			const all = new Set(local);
			missing.forEach((table, i) => {
				if (found?.[i]) {
					all.add(table);
					this.remember(digest, table);
				}
			});
			return all;
		} catch (err) {
			this.redisError(err);
			return local;
		}
	}

	/** Record that `table` committed for this digest, everywhere receipts are kept. */
	async add(digest: string, table: string): Promise<void> {
		this.remember(digest, table);
		if (this.file && !this.journalFailed) this.append(this.file, digest, table);
		if (!this.redis) return;
		try {
			const redis = await this.redis;
			await redis.eval(SETEX, 1, this.key(digest, table), Math.ceil(this.ttlMs / 1000));
		} catch (err) {
			this.redisError(err);
		}
	}

	/**
	 * Run `write` for this digest after any write already in flight for the
	 * same digest settles, so a re-send that overtakes a slow first attempt
	 * sees its receipts instead of writing the same rows concurrently.
	 */
	async coalesce<T>(digest: string, write: () => Promise<T>): Promise<T> {
		const prior = this.inflight.get(digest);
		const run = (async () => {
			if (prior) await prior.catch(() => {});
			return write();
		})();
		this.inflight.set(digest, run);
		try {
			return await run;
		} finally {
			if (this.inflight.get(digest) === run) this.inflight.delete(digest);
		}
	}

	get size(): number {
		return this.entries.size;
	}

	stats(): { mode: string; entries: number; redisFailures: number; journalFailed: boolean } {
		return { mode: this.mode, entries: this.entries.size, redisFailures: this.redisFailures, journalFailed: this.journalFailed };
	}

	private local(digest: string): Set<string> {
		const entry = this.entries.get(digest);
		if (!entry) return new Set();
		if (this.now() - entry.at > this.ttlMs) {
			this.entries.delete(digest);
			return new Set();
		}
		return new Set(entry.tables);
	}

	private remember(digest: string, table: string, at = this.now()): void {
		const entry = this.entries.get(digest);
		if (entry) {
			entry.tables.add(table);
			return;
		}
		this.entries.set(digest, { at, tables: new Set([table]) });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	private key(digest: string, table: string): string {
		return `${this.prefix}${digest}:${table}`;
	}

	/** Lines are `<ms> <digest> <table>`; expired and malformed lines are skipped. */
	private load(file: string): void {
		try {
			if (!existsSync(file)) return;
			const cutoff = this.now() - this.ttlMs;
			for (const line of readFileSync(file, "utf8").split("\n")) {
				const [at, digest, table] = line.split(" ");
				const ms = Number(at);
				if (!digest || !table || !Number.isFinite(ms) || ms < cutoff) continue;
				this.remember(digest, table, ms);
			}
			this.compact(file);
		} catch (err) {
			this.journalFailed = true;
			this.log(`insert receipts journal ${file} unreadable (${(err as Error).message}) — receipts kept in memory only`);
		}
	}

	private append(file: string, digest: string, table: string): void {
		try {
			appendFileSync(file, `${this.now()} ${digest} ${table}\n`);
			this.journalLines += 1;
			// Rewrite with live entries only once it holds far more than them.
			if (this.journalLines > this.maxEntries * 4) this.compact(file);
		} catch (err) {
			this.journalFailed = true;
			this.log(`insert receipts journal ${file} not writable (${(err as Error).message}) — receipts kept in memory only`);
		}
	}

	private compact(file: string): void {
		const cutoff = this.now() - this.ttlMs;
		const lines: string[] = [];
		for (const [digest, entry] of this.entries) {
			if (entry.at < cutoff) continue;
			for (const table of entry.tables) lines.push(`${entry.at} ${digest} ${table}`);
		}
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "");
		renameSync(tmp, file);
		this.journalLines = lines.length;
	}

	private redisError(err: unknown): void {
		this.redisFailures += 1;
		if (this.now() - this.lastRedisLog < 60_000) return;
		this.lastRedisLog = this.now();
		this.log(`insert receipts redis error (using this process's receipts): ${(err as Error)?.message ?? err}`);
	}
}

/** Digest of one ingest request: tenant, route and the exact body. */
export function requestDigest(
	tenant: { orgId: string; repositoryId: string },
	path: string,
	body: unknown,
): string {
	const hash = createHash("sha256");
	hash.update(`${tenant.orgId}\u0000${tenant.repositoryId}\u0000${path.toLowerCase()}\u0000`);
	if (Buffer.isBuffer(body)) hash.update(body);
	else if (typeof body === "string") hash.update(body);
	else hash.update(JSON.stringify(body ?? null));
	return hash.digest("hex").slice(0, 40);
}
