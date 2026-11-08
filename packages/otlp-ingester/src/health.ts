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
	/** Last successful ingest write. */
	lastOkAt: string | null;
	/** Last failed ingest write, and its category. */
	lastErrorAt: string | null;
	lastError: StorageErrorCategory | null;
	/** Failed writes since the last success. */
	consecutiveFailures: number;
	/** Seconds since the last successful write while writes are failing
	 * (how far behind storage is); 0 when the last write succeeded. */
	lagSeconds: number;
	okWrites: number;
	failedWrites: number;
}

/** Outcome of real ingest writes. */
export class WriteHealth {
	private lastOk = 0;
	private lastError = 0;
	private lastCategory: StorageErrorCategory | null = null;
	private consecutive = 0;
	private ok = 0;
	private failed = 0;

	constructor(private readonly now: () => number = Date.now) {}

	recordOk(): void {
		this.lastOk = this.now();
		this.consecutive = 0;
		this.ok += 1;
	}

	recordFailure(category: StorageErrorCategory): void {
		this.lastError = this.now();
		this.lastCategory = category;
		this.consecutive += 1;
		this.failed += 1;
	}

	/** True while the most recent write failed and it is recent: a probe
	 * that succeeds must not hide real inserts that do not. */
	failing(windowMs: number): boolean {
		return this.consecutive > 0 && this.now() - this.lastError <= windowMs;
	}

	lastCategoryOrNull(): StorageErrorCategory | null {
		return this.lastCategory;
	}

	stats(): WriteHealthStats {
		const now = this.now();
		return {
			lastOkAt: this.lastOk ? new Date(this.lastOk).toISOString() : null,
			lastErrorAt: this.lastError ? new Date(this.lastError).toISOString() : null,
			lastError: this.lastCategory,
			consecutiveFailures: this.consecutive,
			lagSeconds: this.consecutive > 0 && this.lastOk ? Math.round((now - this.lastOk) / 1000) : 0,
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
