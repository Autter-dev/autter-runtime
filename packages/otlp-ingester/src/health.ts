/**
 * Storage health for /healthz (readiness) and for requests that write
 * nothing.
 *
 * Before 1.12 /healthz answered ClickHouse's unauthenticated `/ping`, so a
 * wrong password, a dropped table or a missing grant reported "up" while
 * every ingest request answered 503. Readiness now comes from two sources:
 *
 * - a probe that does what ingest does: makes sure the schema exists and
 *   inserts one row (runtime_ingester_heartbeat) with the configured
 *   credentials. It runs at most once per PROBE_MAX_AGE_MS however often
 *   /healthz is called (the endpoint is public), and concurrent callers
 *   share one probe;
 * - the outcome of real ingest writes (WriteHealth), so a probe that
 *   passes while real inserts fail still reports the failure.
 *
 * ClickHouse failures are reduced to a fixed state — the health endpoint is
 * unauthenticated, so raw error text stays in server logs only.
 */

/** What is wrong with storage, as reported by /healthz. */
export type StorageState =
	/** The probe wrote a row and recent ingest writes succeeded. */
	| "up"
	/** CLICKHOUSE_URL is not set: every ingest request answers 503. */
	| "unconfigured"
	/** ClickHouse answered, but refused the credentials or the grant. Not
	 * fixed by retrying: the deployment's config must change. */
	| "auth_failed"
	/** A table or the database is missing and could not be recreated. */
	| "schema_missing"
	/** ClickHouse could not be reached, timed out, or failed the write. */
	| "down";

/** Fixed category of one ClickHouse failure. */
export type StorageErrorCategory = "auth" | "schema" | "unreachable" | "timeout" | "error";

/** ClickHouse server error codes, by category. */
const AUTH_CODES = new Set([
	"192", // UNKNOWN_USER
	"193", // WRONG_PASSWORD
	"194", // REQUIRED_PASSWORD
	"195", // IP_ADDRESS_NOT_ALLOWED
	"291", // DATABASE_ACCESS_DENIED
	"497", // ACCESS_DENIED
	"516", // AUTHENTICATION_FAILED
]);
const SCHEMA_CODES = new Set([
	"60", // UNKNOWN_TABLE
	"81", // UNKNOWN_DATABASE
]);

/** Categorise an error thrown by @clickhouse/client (or fetch underneath). */
export function storageErrorCategory(err: unknown): StorageErrorCategory {
	if (!err || typeof err !== "object") return "error";
	const e = err as { code?: unknown; type?: unknown; name?: unknown; message?: unknown; cause?: unknown };
	const code = typeof e.code === "string" || typeof e.code === "number" ? String(e.code) : "";
	if (AUTH_CODES.has(code)) return "auth";
	if (SCHEMA_CODES.has(code)) return "schema";
	const message = typeof e.message === "string" ? e.message : "";
	// A proxy in front of ClickHouse, or an older server, can answer 401/403
	// without a ClickHouse error body.
	if (/\b(401|403)\b.*(unauthori[sz]ed|forbidden)|authentication failed/i.test(message)) return "auth";
	if (e.name === "TimeoutError" || e.name === "AbortError" || /timeout/i.test(message)) return "timeout";
	if (
		/^E[A-Z]+$/.test(code) || // ECONNREFUSED, ECONNRESET, ENOTFOUND, …
		/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up/i.test(message)
	) {
		return "unreachable";
	}
	if (e.cause && e.cause !== err) {
		const inner = storageErrorCategory(e.cause);
		if (inner !== "error") return inner;
	}
	return "error";
}

/** The readiness state a failure category maps to. */
export function stateFor(category: StorageErrorCategory): Exclude<StorageState, "up" | "unconfigured"> {
	if (category === "auth") return "auth_failed";
	if (category === "schema") return "schema_missing";
	return "down";
}

/** Can a client fix this by retrying later (on its own), or does a person
 * have to change the deployment? */
export function retryable(state: StorageState): boolean {
	return state === "down";
}

export interface WriteHealthStats {
	/** Last successful ingest write (any table). */
	lastOkAt: string | null;
	/** Last failed ingest write (any table), and its category. */
	lastErrorAt: string | null;
	lastError: StorageErrorCategory | null;
	/** Failed writes since the last success, summed over the tables that
	 * are failing now. */
	consecutiveFailures: number;
	/** Tables whose most recent write failed (names, no tenant data). */
	failingTables: string[];
	/** Seconds since the last successful write while writes are failing
	 * (how far behind storage is); 0 when nothing is failing. */
	lagSeconds: number;
	okWrites: number;
	failedWrites: number;
}

interface TableHealth {
	lastOk: number;
	lastError: number;
	category: StorageErrorCategory | null;
	consecutive: number;
}

/**
 * Outcome of real ingest writes, per table. A success on one table says
 * nothing about another: one request writes several tables in parallel, and
 * a table that refuses every insert (a missing grant, a dropped table) must
 * keep the ingester unready even while its siblings keep succeeding.
 */
export class WriteHealth {
	private readonly tables = new Map<string, TableHealth>();
	private lastOk = 0;
	private lastError = 0;
	private lastCategory: StorageErrorCategory | null = null;
	private ok = 0;
	private failed = 0;

	constructor(private readonly now: () => number = Date.now) {}

	private table(name: string): TableHealth {
		let health = this.tables.get(name);
		if (!health) {
			health = { lastOk: 0, lastError: 0, category: null, consecutive: 0 };
			this.tables.set(name, health);
		}
		return health;
	}

	/** A write to `table` succeeded; without a table, every table is cleared. */
	recordOk(table?: string): void {
		const now = this.now();
		this.lastOk = now;
		this.ok += 1;
		const targets = table === undefined ? [...this.tables.values()] : [this.table(table)];
		for (const health of targets) {
			health.lastOk = now;
			health.consecutive = 0;
		}
	}

	recordFailure(category: StorageErrorCategory, table = ""): void {
		const now = this.now();
		this.lastError = now;
		this.lastCategory = category;
		this.failed += 1;
		const health = this.table(table);
		health.lastError = now;
		health.category = category;
		health.consecutive += 1;
	}

	/** Forget failures of `category` (e.g. "schema" once the tables were
	 * recreated). True when any table was cleared. */
	clearCategory(category: StorageErrorCategory): boolean {
		let cleared = false;
		for (const health of this.tables.values()) {
			if (health.consecutive > 0 && health.category === category) {
				health.consecutive = 0;
				cleared = true;
			}
		}
		return cleared;
	}

	/** Tables whose latest write failed within `windowMs`. */
	private failingTables(windowMs: number): Array<[string, TableHealth]> {
		const now = this.now();
		return [...this.tables].filter(([, health]) => health.consecutive > 0 && now - health.lastError <= windowMs);
	}

	/** True while some table's most recent write failed, recently: a probe
	 * that succeeds, or another table that accepts writes, must not hide
	 * real inserts that do not. */
	failing(windowMs: number): boolean {
		return this.failingTables(windowMs).length > 0;
	}

	/** The category of the most recent failure among the failing tables. */
	lastCategoryOrNull(windowMs = Number.POSITIVE_INFINITY): StorageErrorCategory | null {
		const failing = this.failingTables(windowMs).sort(([, a], [, b]) => b.lastError - a.lastError);
		return failing[0]?.[1].category ?? this.lastCategory;
	}

	stats(windowMs = Number.POSITIVE_INFINITY): WriteHealthStats {
		const now = this.now();
		const failing = this.failingTables(windowMs);
		const consecutive = failing.reduce((sum, [, health]) => sum + health.consecutive, 0);
		return {
			lastOkAt: this.lastOk ? new Date(this.lastOk).toISOString() : null,
			lastErrorAt: this.lastError ? new Date(this.lastError).toISOString() : null,
			lastError: this.lastCategory,
			consecutiveFailures: consecutive,
			failingTables: failing.map(([name]) => name.replace(/^[^.]*\./, "")).filter(Boolean).sort(),
			lagSeconds: consecutive > 0 && this.lastOk ? Math.round((now - this.lastOk) / 1000) : 0,
			okWrites: this.ok,
			failedWrites: this.failed,
		};
	}
}

export interface ProbeResult {
	state: StorageState;
	checkedAt: string;
	/** Probe round trip (schema check + heartbeat insert). */
	latencyMs: number | null;
}

/** Probes are cached this long: /healthz is public and polled often. */
export const PROBE_MAX_AGE_MS = 5_000;
/** A failed ingest write within this window makes the ingester unready. */
export const WRITE_FAILURE_WINDOW_MS = 60_000;

/** Run `probe` at most once per maxAgeMs; concurrent callers share one run. */
export class CachedProbe {
	private last: ProbeResult | null = null;
	private lastAt = 0;
	private running: Promise<ProbeResult> | null = null;

	constructor(
		private readonly probe: () => Promise<ProbeResult>,
		private readonly maxAgeMs: number = PROBE_MAX_AGE_MS,
		private readonly now: () => number = Date.now,
	) {}

	async get(): Promise<ProbeResult> {
		if (this.last && this.now() - this.lastAt < this.maxAgeMs) return this.last;
		if (!this.running) {
			this.running = this.probe()
				.then((result) => {
					this.last = result;
					this.lastAt = this.now();
					return result;
				})
				.finally(() => {
					this.running = null;
				});
		}
		return this.running;
	}

	/** Forget the cached result (a real write just failed or recovered). */
	invalidate(): void {
		this.last = null;
	}
}

/** Migration 0023 / baseline: one row per ingester instance, rewritten by
 * every readiness probe — proof that this deployment can write. */
export function heartbeatTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_ingester_heartbeat (
		instance_id String,
		version String DEFAULT '',
		checked_at DateTime64(3, 'UTC')
	) ENGINE = ReplacingMergeTree(checked_at)
	ORDER BY instance_id
	TTL toDateTime(checked_at) + INTERVAL 1 DAY`;
}
