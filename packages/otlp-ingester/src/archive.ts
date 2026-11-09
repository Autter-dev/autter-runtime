import { createHash, randomUUID } from "node:crypto";
import type { RedisLike } from "./limits.js";

/**
 * Tiered retention (1.14.0): hot rows in ClickHouse, then Parquet in object
 * storage (S3, GCS through its S3-compatible endpoint, MinIO, R2, …).
 *
 * Without ARCHIVE_S3_URL / ARCHIVE_S3_NAMED_COLLECTION nothing here runs and
 * every table keeps its TTL exactly as before.
 *
 * With an archive configured, each archived table gives up its delete TTL
 * except a backstop (ARCHIVE_BACKSTOP_DAYS, default the hot window + 7
 * days) that keeps the disk from filling if this job stops, and this job
 * becomes what normally removes rows from it. Once a day partition is
 * older than the table's hot window (OCCURRENCE_TTL_DAYS, SPAN_TTL_DAYS, …):
 *
 *   1. a log row `exporting` (table, day, generation) is written;
 *   2. the partition is moved, atomically, into `<table>_archive_stage`
 *      (`ALTER TABLE … MOVE PARTITION … TO TABLE`), so rows that arrive for
 *      that day later land in a fresh partition of the hot table instead of
 *      being deleted with the archived ones;
 *   3. the staged rows are written per org to
 *      `<base>/<table>/org=<org key>/date=<YYYY-MM-DD>/g<generation>.parquet`
 *      (overwriting the same object on a rerun) and each object is read back
 *      and its row count compared;
 *   4. the log row becomes `archived`, and only then is the staged partition
 *      dropped.
 *
 * A crash anywhere leaves either the hot partition or the staged one in
 * place, and the next pass resumes from the log: nothing is dropped before
 * its rows were read back from object storage. Late rows for an archived day
 * become a new generation (a second file next to the first). Partitions
 * older than ARCHIVE_RETENTION_DAYS (event age) are dropped without export,
 * as their TTL would have done. Objects are expired by the bucket's
 * lifecycle rule, not by this job.
 *
 * One process runs the job: the holder of a Redis lease when
 * AUTTER_REDIS_URL is set, else the only replica (AUTTER_INGESTER_REPLICAS=1)
 * or the one started with ARCHIVE_SCHEDULER=on.
 */

export const ARCHIVE_TABLES = [
	"runtime_error_occurrences",
	"runtime_spans",
	"runtime_llm_calls",
	"runtime_logs",
] as const;
export type ArchiveTable = (typeof ARCHIVE_TABLES)[number];

/** Partition column (every archived table is PARTITION BY toDate(it)) and
 * whether the engine needs FINAL to read each row once (runtime_logs is a
 * ReplacingMergeTree). */
export const ARCHIVE_TABLE_SPECS: Record<ArchiveTable, { timeColumn: string; final: boolean }> = {
	runtime_error_occurrences: { timeColumn: "occurred_at", final: false },
	runtime_spans: { timeColumn: "started_at", final: false },
	runtime_llm_calls: { timeColumn: "started_at", final: false },
	runtime_logs: { timeColumn: "occurred_at", final: true },
};

/** Object layout, recorded in each log row so readers can tell layouts apart. */
export const ARCHIVE_LAYOUT = "v1:{table}/org={org}/date={day}/g{generation}.parquet";

export type ArchiveSchedulerSetting = "auto" | "on" | "off";

export interface ArchiveConfig {
	/** Base URL of the archive, no trailing slash: https://bucket.s3.region.amazonaws.com/prefix,
	 * https://storage.googleapis.com/bucket/prefix, http://minio:9000/bucket/prefix. */
	url: string | null;
	/** A ClickHouse named collection holding url and credentials (preferred:
	 * credentials stay on the ClickHouse server). Object paths go in `filename`. */
	namedCollection: string | null;
	/** HMAC / access keys passed in the s3() call (when no named collection). */
	accessKeyId: string | null;
	secretAccessKey: string | null;
	tables: ArchiveTable[];
	/** Event age (days) after which rows are gone from the archive too (ARCHIVE_RETENTION_DAYS, 30–3650, default 365). */
	retentionDays: number;
	/**
	 * TTL kept on archived tables as a disk guard (ARCHIVE_BACKSTOP_DAYS):
	 * "auto" (the default) is each table's hot window + BACKSTOP_MARGIN_DAYS,
	 * a number is at least that, 0 is no TTL at all.
	 */
	backstopDays: number | "auto";
	/** Days a table may fall behind before each pass warns (ARCHIVE_OVERDUE_WARN_DAYS, default 2). */
	overdueWarnDays: number;
	intervalMinutes: number;
	/** Day partitions handled per table per pass (bounded work). */
	maxDaysPerPass: number;
	scheduler: ArchiveSchedulerSetting;
}

/** Days past the hot window the backstop TTL waits: time to notice and fix a stopped archive job. */
export const BACKSTOP_MARGIN_DAYS = 7;

function parseBackstop(raw: string | undefined): number | "auto" {
	const value = raw?.trim().toLowerCase() ?? "";
	if (value === "" || value === "auto") return "auto";
	const days = Number(value);
	if (!Number.isInteger(days) || days < 0) {
		throw new Error("ARCHIVE_BACKSTOP_DAYS must be auto, 0 (no TTL) or a number of days");
	}
	return Math.min(3650, days);
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/**
 * The archive settings, or null when no archive is configured (the default:
 * behaviour exactly as before). Inconsistent settings fail startup loudly
 * rather than run half an archive.
 */
export function archiveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ArchiveConfig | null {
	const rawUrl = env.ARCHIVE_S3_URL?.trim() || "";
	const namedCollection = env.ARCHIVE_S3_NAMED_COLLECTION?.trim() || null;
	if (!rawUrl && !namedCollection) return null;
	let url: string | null = null;
	if (rawUrl) {
		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch {
			throw new Error(`ARCHIVE_S3_URL is not a URL: ${rawUrl}`);
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new Error("ARCHIVE_S3_URL must be an http(s) URL (the bucket's S3 endpoint plus an optional prefix)");
		}
		if (parsed.username || parsed.password || parsed.search || /[{}*?']/.test(rawUrl)) {
			throw new Error("ARCHIVE_S3_URL must not carry credentials, a query string, quotes or glob characters");
		}
		url = rawUrl.replace(/\/+$/, "");
	}
	if (namedCollection && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(namedCollection)) {
		throw new Error(`ARCHIVE_S3_NAMED_COLLECTION is not a valid identifier: ${namedCollection}`);
	}
	const accessKeyId = env.ARCHIVE_S3_ACCESS_KEY_ID?.trim() || null;
	const secretAccessKey = env.ARCHIVE_S3_SECRET_ACCESS_KEY?.trim() || null;
	if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
		throw new Error("Set both ARCHIVE_S3_ACCESS_KEY_ID and ARCHIVE_S3_SECRET_ACCESS_KEY, or neither");
	}
	if (namedCollection && accessKeyId) {
		throw new Error("ARCHIVE_S3_NAMED_COLLECTION holds the credentials; unset ARCHIVE_S3_ACCESS_KEY_ID / ARCHIVE_S3_SECRET_ACCESS_KEY");
	}
	let tables: ArchiveTable[] = [...ARCHIVE_TABLES];
	const rawTables = env.ARCHIVE_TABLES?.trim();
	if (rawTables) {
		const listed = rawTables.split(",").map((t) => t.trim()).filter(Boolean);
		for (const table of listed) {
			if (!(ARCHIVE_TABLES as readonly string[]).includes(table)) {
				throw new Error(`ARCHIVE_TABLES: unknown table ${table}; expected some of ${ARCHIVE_TABLES.join(", ")}`);
			}
		}
		tables = ARCHIVE_TABLES.filter((t) => listed.includes(t));
	}
	const scheduler = (env.ARCHIVE_SCHEDULER?.trim().toLowerCase() || "auto") as ArchiveSchedulerSetting;
	if (!["auto", "on", "off"].includes(scheduler)) {
		throw new Error("ARCHIVE_SCHEDULER must be auto, on or off");
	}
	return {
		url,
		namedCollection,
		accessKeyId,
		secretAccessKey,
		tables,
		retentionDays: boundedInt(env.ARCHIVE_RETENTION_DAYS, 365, 30, 3650),
		backstopDays: parseBackstop(env.ARCHIVE_BACKSTOP_DAYS),
		overdueWarnDays: boundedInt(env.ARCHIVE_OVERDUE_WARN_DAYS, 2, 1, 30),
		intervalMinutes: boundedInt(env.ARCHIVE_INTERVAL_MINUTES, 60, 5, 1440),
		maxDaysPerPass: boundedInt(env.ARCHIVE_MAX_DAYS_PER_PASS, 4, 1, 31),
		scheduler,
	};
}

/** Where the archive is, for the log (never a credential). */
export function archiveLocation(config: Pick<ArchiveConfig, "url" | "namedCollection">): string {
	return config.namedCollection ? `named_collection:${config.namedCollection}` : (config.url ?? "");
}

// ── SQL helpers ────────────────────────────────────────────────────────────

/** A ClickHouse string literal. */
export function chString(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The path segment for an org: the id itself when it is made of
 * [A-Za-z0-9_-] (every Autter org id), else a readable form plus a hash so
 * two ids never share a folder. The backend computes the same key
 * (runtime-archive.ts); the vectors in archive.test.ts pin it.
 */
export function orgArchiveKey(orgId: string): string {
	if (/^[A-Za-z0-9_-]{1,128}$/.test(orgId)) return orgId;
	const readable = orgId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
	const hash = createHash("sha256").update(orgId).digest("hex").slice(0, 12);
	return `${readable}~${hash}`;
}

/** Object path (relative to the archive base) of one org's rows for one day and generation. */
export function archiveObjectPath(table: ArchiveTable, orgId: string, day: string, generation: number): string {
	return `${table}/org=${orgArchiveKey(orgId)}/date=${day}/g${generation}.parquet`;
}

/** An s3() table function over `path`, in the configured way of reaching the bucket. */
export function s3Function(
	config: Pick<ArchiveConfig, "url" | "namedCollection" | "accessKeyId" | "secretAccessKey">,
	path: string,
	structure?: string,
): string {
	if (config.namedCollection) {
		return `s3(${config.namedCollection}, filename = ${chString(path)}, format = 'Parquet'${structure ? `, structure = ${chString(structure)}` : ""})`;
	}
	if (!config.url) throw new Error("archive has no URL");
	const url = chString(`${config.url}/${path}`);
	const creds = config.accessKeyId && config.secretAccessKey ? `, ${chString(config.accessKeyId)}, ${chString(config.secretAccessKey)}` : "";
	return `s3(${url}${creds}, 'Parquet'${structure ? `, ${chString(structure)}` : ""})`;
}

export function archiveLogTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_archive_log (
		table_name     LowCardinality(String),
		day            Date,
		generation     UInt32,
		status         LowCardinality(String),
		rows           UInt64 DEFAULT 0,
		orgs           UInt32 DEFAULT 0,
		location       String DEFAULT '',
		layout         String DEFAULT '',
		hot_days       UInt16 DEFAULT 0,
		retention_days UInt16 DEFAULT 0,
		updated_at     DateTime64(3, 'UTC') DEFAULT now64(3)
	)
	ENGINE = ReplacingMergeTree(updated_at)
	ORDER BY (table_name, day, generation)`;
}

export function stageTableName(table: ArchiveTable): string {
	return `${table}_archive_stage`;
}

// ── Days and partitions ────────────────────────────────────────────────────

/** YYYY-MM-DD (UTC). */
export function utcDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return utcDay(date);
}

/** toDate partitions have ids like 20261109. */
export function dayFromPartitionId(partitionId: string): string | null {
	const m = /^(\d{4})(\d{2})(\d{2})$/.exec(partitionId);
	if (!m) return null;
	const day = `${m[1]}-${m[2]}-${m[3]}`;
	const date = new Date(`${day}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && utcDay(date) === day ? day : null;
}

export function partitionIdForDay(day: string): string {
	return day.replaceAll("-", "");
}

/** The first day still in the hot window: partitions of earlier days are archived. */
export function hotCutoffDay(now: Date, hotDays: number): string {
	return addDays(utcDay(now), -hotDays);
}

// ── Planning (pure) ────────────────────────────────────────────────────────

export interface PartitionRows {
	day: string;
	rows: number;
}

export type ArchiveStatus = "exporting" | "archived" | "expired";

export interface ArchiveLogEntry {
	day: string;
	generation: number;
	status: ArchiveStatus;
	rows: number;
}

export type ArchiveStep =
	/** Move the hot partition to the stage table, then export it. */
	| { kind: "evict"; day: string; generation: number }
	/** A staged partition left by an earlier pass: export it again (same generation, same objects). */
	| { kind: "export-stage"; day: string; generation: number }
	/** A staged partition whose generation is logged archived: only the drop is left. */
	| { kind: "drop-stage"; day: string; generation: number }
	/** Older than the archive's retention: drop without export, as its TTL would. */
	| { kind: "expire"; day: string; generation: number };

export interface ArchivePlanInput {
	now: Date;
	hotDays: number;
	retentionDays: number;
	/** Active partitions of the hot table. */
	main: PartitionRows[];
	/** Active partitions of the stage table. */
	stage: PartitionRows[];
	/** Latest status of every (day, generation) logged for the table. */
	log: ArchiveLogEntry[];
	maxSteps: number;
}

function latestByDay(log: ArchiveLogEntry[]): Map<string, ArchiveLogEntry> {
	const out = new Map<string, ArchiveLogEntry>();
	for (const entry of log) {
		const current = out.get(entry.day);
		if (!current || entry.generation > current.generation) out.set(entry.day, entry);
	}
	return out;
}

/** A generation newer than any logged for the day: seconds since the epoch. */
function newGeneration(now: Date, latest: ArchiveLogEntry | undefined): number {
	return Math.max(Math.floor(now.getTime() / 1000), (latest?.generation ?? 0) + 1);
}

/**
 * What one pass does for one table. Staged partitions are finished first,
 * oldest day first; then hot partitions older than the hot window are
 * evicted, oldest first; a day still staged is never evicted in the same
 * pass (its rows would mix two generations). Nothing inside the hot window
 * is ever touched, and the only drops are of staged rows whose generation is
 * logged `archived` and of days older than the retention.
 */
export function planTableArchive(input: ArchivePlanInput): ArchiveStep[] {
	const latest = latestByDay(input.log);
	const cutoff = hotCutoffDay(input.now, input.hotDays);
	const expiry = addDays(utcDay(input.now), -Math.max(input.retentionDays, input.hotDays));
	const steps: ArchiveStep[] = [];
	const staged = new Set<string>();
	for (const part of [...input.stage].sort((a, b) => a.day.localeCompare(b.day))) {
		staged.add(part.day);
		const entry = latest.get(part.day);
		if (entry?.status === "archived") steps.push({ kind: "drop-stage", day: part.day, generation: entry.generation });
		else if (entry?.status === "exporting") steps.push({ kind: "export-stage", day: part.day, generation: entry.generation });
		else steps.push({ kind: "export-stage", day: part.day, generation: newGeneration(input.now, entry) });
	}
	for (const part of [...input.main].sort((a, b) => a.day.localeCompare(b.day))) {
		if (part.day >= cutoff || staged.has(part.day) || part.rows <= 0) continue;
		const entry = latest.get(part.day);
		if (part.day < expiry) {
			steps.push({ kind: "expire", day: part.day, generation: newGeneration(input.now, entry) });
			continue;
		}
		// `exporting` with nothing staged: the last pass stopped before its move.
		const generation = entry?.status === "exporting" ? entry.generation : newGeneration(input.now, entry);
		steps.push({ kind: "evict", day: part.day, generation });
	}
	return steps.slice(0, Math.max(1, input.maxSteps));
}

// ── TTL (pure) ─────────────────────────────────────────────────────────────

/** Days of the delete TTL in a system.tables engine_full, null when it has no TTL. */
export function parseTtlDays(engineFull: string): number | null | "unrecognised" {
	if (!/\bTTL\b/.test(engineFull)) return null;
	const current = /\bTTL\b[^]*?toIntervalDay\((\d+)\)/.exec(engineFull);
	return current ? Number(current[1]) : "unrecognised";
}

export type TtlAction = { action: "none" } | { action: "modify"; days: number } | { action: "remove" };

/**
 * The TTL a table should have. Archived: none, or a backstop past the hot
 * window, so the TTL never deletes a day the archiver has not exported.
 * Not archived: the hot window (tables other than runtime_logs keep their
 * creation-time TTL as before; one whose TTL an archive removed gets it back).
 */
export function retentionTtlAction(input: {
	current: number | null | "unrecognised";
	hotDays: number;
	archived: boolean;
	backstopDays: number | "auto";
	/** runtime_logs: LOG_TTL_DAYS is applied to existing tables at every boot. */
	alwaysApply: boolean;
}): TtlAction {
	if (input.current === "unrecognised") return { action: "none" };
	if (input.archived) {
		const backstop = effectiveBackstopDays(input.backstopDays, input.hotDays);
		if (backstop === null) return input.current === null ? { action: "none" } : { action: "remove" };
		return input.current === backstop ? { action: "none" } : { action: "modify", days: backstop };
	}
	if (input.current === input.hotDays) return { action: "none" };
	if (input.alwaysApply || input.current === null) return { action: "modify", days: input.hotDays };
	return { action: "none" };
}

/** The backstop TTL, at least a week past the hot window; null = no TTL (ARCHIVE_BACKSTOP_DAYS=0). */
export function effectiveBackstopDays(backstopDays: number | "auto", hotDays: number): number | null {
	if (backstopDays === "auto") return hotDays + BACKSTOP_MARGIN_DAYS;
	if (backstopDays <= 0) return null;
	return Math.max(backstopDays, hotDays + BACKSTOP_MARGIN_DAYS);
}

/**
 * How many days late the table's archiving is: 0 while the oldest day still
 * in ClickHouse (hot or staged) is at most the one that left the hot window
 * last, 1 when a day has waited a day past that, and so on. Hourly passes
 * keep it at 0; it climbs when passes stop or fail.
 */
export function overdueDays(input: { now: Date; hotDays: number; main: PartitionRows[]; stage: PartitionRows[] }): number {
	const cutoff = hotCutoffDay(input.now, input.hotDays);
	let oldest: string | null = null;
	for (const part of [...input.main, ...input.stage]) {
		if (part.rows > 0 && part.day < cutoff && (oldest === null || part.day < oldest)) oldest = part.day;
	}
	if (oldest === null) return 0;
	const days = Math.round((Date.parse(`${cutoff}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000);
	return Math.max(0, days - 1);
}

// ── Single instance ────────────────────────────────────────────────────────

export interface ArchiveLease {
	readonly kind: "redis" | "local";
	/** Take or extend the lease; false when another process holds it (or Redis is unreachable). */
	acquire(): Promise<boolean>;
	release(): Promise<void>;
}

export type ArchiveSchedulerMode = { mode: "redis" | "local" } | { mode: "none"; reason: string };

/** Which processes run the archive job. */
export function archiveSchedulerMode(input: {
	scheduler: ArchiveSchedulerSetting;
	hasRedis: boolean;
	replicas: number;
}): ArchiveSchedulerMode {
	if (input.scheduler === "off") return { mode: "none", reason: "ARCHIVE_SCHEDULER=off" };
	if (input.hasRedis) return { mode: "redis" };
	if (input.scheduler === "on" || input.replicas <= 1) return { mode: "local" };
	return {
		mode: "none",
		reason:
			`AUTTER_INGESTER_REPLICAS=${input.replicas} and no AUTTER_REDIS_URL: set AUTTER_REDIS_URL (a lease picks one replica) ` +
			"or ARCHIVE_SCHEDULER=on on exactly one instance. Until then no partition is archived or dropped and the archived tables grow",
	};
}

export class LocalArchiveLease implements ArchiveLease {
	readonly kind = "local" as const;
	async acquire(): Promise<boolean> {
		return true;
	}
	async release(): Promise<void> {}
}

const LEASE_ACQUIRE = `local v = redis.call('GET', KEYS[1])
if not v then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
if v == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
return 0`;
const LEASE_RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export class RedisArchiveLease implements ArchiveLease {
	readonly kind = "redis" as const;
	private readonly token = randomUUID();
	constructor(
		private readonly redis: Promise<RedisLike>,
		private readonly key: string,
		private readonly ttlMs = 20 * 60_000,
	) {}

	async acquire(): Promise<boolean> {
		try {
			const client = await this.redis;
			return Number(await client.eval(LEASE_ACQUIRE, 1, this.key, this.token, this.ttlMs)) === 1;
		} catch (err) {
			console.warn(`archive lease: redis unavailable, skipping this pass: ${err instanceof Error ? err.message : err}`);
			return false;
		}
	}

	async release(): Promise<void> {
		try {
			const client = await this.redis;
			await client.eval(LEASE_RELEASE, 1, this.key, this.token);
		} catch {
			// The lease expires on its own.
		}
	}
}

// ── The job ────────────────────────────────────────────────────────────────

/** The ClickHouse calls the job makes (tests pass a stand-in). */
export interface ArchiveDb {
	query<T>(sql: string): Promise<T[]>;
	command(sql: string): Promise<void>;
}

export interface ArchivePassTableResult {
	table: ArchiveTable;
	steps: number;
	archivedDays: string[];
	expiredDays: string[];
	/** How late this table's archiving was when the pass began (see overdueDays). */
	overdueDays?: number;
	error?: string;
}

export interface ArchivePassResult {
	skipped?: "lease" | "running";
	tables: ArchivePassTableResult[];
}

export interface RuntimeArchiverOptions {
	db: ArchiveDb;
	database: string;
	config: ArchiveConfig;
	hotDays: Record<ArchiveTable, number>;
	lease: ArchiveLease;
	now?: () => Date;
}

export class RuntimeArchiver {
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<ArchivePassResult> | null = null;
	private stopped = false;
	private readonly now: () => Date;
	lastPass: { at: Date; result: ArchivePassResult } | null = null;

	constructor(private readonly opts: RuntimeArchiverOptions) {
		this.now = opts.now ?? (() => new Date());
	}

	/** First pass a minute after start, then every ARCHIVE_INTERVAL_MINUTES. */
	start(): void {
		if (this.timer || this.stopped) return;
		const tick = () => {
			if (this.stopped) return;
			void this.runOnce().catch((err) => console.error("archive pass failed:", err instanceof Error ? err.message : err));
		};
		const first = setTimeout(tick, 60_000);
		first.unref();
		this.timer = setInterval(tick, this.opts.config.intervalMinutes * 60_000);
		this.timer.unref();
		console.log(
			`runtime archive: started (${this.opts.lease.kind} lease) for ${this.opts.config.tables.join(", ")} → ${archiveLocation(this.opts.config)}, every ${this.opts.config.intervalMinutes} min`,
		);
	}

	/**
	 * Stop scheduling passes. A pass in progress is not awaited (an export can
	 * outlast the shutdown grace period); it stops between steps, and its
	 * lease is left to expire so no other process starts on the same staged
	 * partition while this one may still be writing it.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (!this.running) await this.opts.lease.release();
	}

	runOnce(): Promise<ArchivePassResult> {
		if (this.running) return Promise.resolve({ skipped: "running", tables: [] });
		this.running = this.pass().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private t(name: string): string {
		return `${this.opts.database}.${name}`;
	}

	private async pass(): Promise<ArchivePassResult> {
		if (!(await this.opts.lease.acquire())) return { skipped: "lease", tables: [] };
		const { db } = this.opts;
		await db.command(archiveLogTableDDL(this.opts.database));
		const tables: ArchivePassTableResult[] = [];
		for (const table of this.opts.config.tables) {
			if (this.stopped) break;
			const result: ArchivePassTableResult = { table, steps: 0, archivedDays: [], expiredDays: [] };
			try {
				await this.tablePass(table, result);
			} catch (err) {
				result.error = err instanceof Error ? err.message : String(err);
				console.error(`runtime archive: ${table} pass stopped (resumes next pass): ${result.error}`);
			}
			tables.push(result);
		}
		const out = { tables };
		this.lastPass = { at: this.now(), result: out };
		return out;
	}

	private async partitions(table: string): Promise<PartitionRows[]> {
		const rows = await this.opts.db.query<{ partition_id: string; rows: string | number }>(
			`SELECT partition_id, sum(rows) AS rows FROM system.parts
			WHERE database = ${chString(this.opts.database)} AND table = ${chString(table)} AND active
			GROUP BY partition_id`,
		);
		const out: PartitionRows[] = [];
		for (const row of rows) {
			const day = dayFromPartitionId(String(row.partition_id));
			if (day) out.push({ day, rows: Number(row.rows) || 0 });
		}
		return out;
	}

	private async logEntries(table: ArchiveTable): Promise<ArchiveLogEntry[]> {
		const rows = await this.opts.db.query<{ day: string; generation: string | number; status: string; rows: string | number }>(
			`SELECT toString(day) AS day, generation, argMax(status, updated_at) AS status, argMax(rows, updated_at) AS rows
			FROM ${this.t("runtime_archive_log")}
			WHERE table_name = ${chString(table)}
			GROUP BY day, generation`,
		);
		return rows.map((r) => ({
			day: r.day,
			generation: Number(r.generation),
			status: (["exporting", "archived", "expired"].includes(r.status) ? r.status : "exporting") as ArchiveStatus,
			rows: Number(r.rows) || 0,
		}));
	}

	private async writeLog(table: ArchiveTable, day: string, generation: number, status: ArchiveStatus, rows: number, orgs: number): Promise<void> {
		const { config } = this.opts;
		await this.opts.db.command(
			`INSERT INTO ${this.t("runtime_archive_log")} (table_name, day, generation, status, rows, orgs, location, layout, hot_days, retention_days, updated_at)
			VALUES (${chString(table)}, ${chString(day)}, ${generation}, ${chString(status)}, ${Math.max(0, Math.round(rows))}, ${orgs},
				${chString(archiveLocation(config))}, ${chString(ARCHIVE_LAYOUT)}, ${this.opts.hotDays[table]}, ${config.retentionDays}, now64(3))`,
		);
	}

	/** The stage table exists, has no TTL, and (when empty) matches the hot table's columns. */
	private async ensureStage(table: ArchiveTable, stageEmpty: boolean): Promise<void> {
		const { db } = this.opts;
		const stage = stageTableName(table);
		await db.command(`CREATE TABLE IF NOT EXISTS ${this.t(stage)} AS ${this.t(table)}`);
		if (stageEmpty) {
			const columns = await db.query<{ table: string; sig: string }>(
				`SELECT table, arrayStringConcat(arrayMap(c -> c.2, arraySort(groupArray((position, concat(name, ' ', type))))), ', ') AS sig
				FROM system.columns
				WHERE database = ${chString(this.opts.database)} AND table IN (${chString(table)}, ${chString(stage)})
				GROUP BY table`,
			);
			const sig = new Map(columns.map((c) => [c.table, c.sig]));
			if (sig.get(table) !== sig.get(stage)) {
				// A migration changed the hot table: MOVE PARTITION needs identical structures.
				await db.command(`DROP TABLE IF EXISTS ${this.t(stage)} SYNC`);
				await db.command(`CREATE TABLE ${this.t(stage)} AS ${this.t(table)}`);
				console.log(`runtime archive: recreated ${stage} to match ${table}`);
			}
		}
		const [engine] = await db.query<{ engine_full: string }>(
			`SELECT engine_full FROM system.tables WHERE database = ${chString(this.opts.database)} AND name = ${chString(stage)}`,
		);
		if (engine && parseTtlDays(engine.engine_full) !== null) {
			// Staged rows are past the hot window: a copied TTL would delete them before export.
			await db.command(`ALTER TABLE ${this.t(stage)} REMOVE TTL`);
		}
	}

	private async tablePass(table: ArchiveTable, result: ArchivePassTableResult): Promise<void> {
		const stage = stageTableName(table);
		const [main, staged, log] = await Promise.all([this.partitions(table), this.partitions(stage), this.logEntries(table)]);
		result.overdueDays = overdueDays({ now: this.now(), hotDays: this.opts.hotDays[table], main, stage: staged });
		if (result.overdueDays >= this.opts.config.overdueWarnDays) {
			const backstop = effectiveBackstopDays(this.opts.config.backstopDays, this.opts.hotDays[table]);
			console.warn(
				`runtime archive: ${table} is behind: its oldest day left the ${this.opts.hotDays[table]}-day hot window ${result.overdueDays + 1} days ago and is not archived yet` +
					(backstop === null ? " (no backstop TTL: the disk keeps filling until it is)" : ` (the ${backstop}-day backstop TTL deletes days that wait longer)`),
			);
		}
		const steps = planTableArchive({
			now: this.now(),
			hotDays: this.opts.hotDays[table],
			retentionDays: this.opts.config.retentionDays,
			main,
			stage: staged,
			log,
			maxSteps: this.opts.config.maxDaysPerPass,
		});
		if (steps.length === 0) return;
		await this.ensureStage(table, staged.length === 0);
		let stageChecked = staged.length === 0;
		for (const step of steps) {
			if (this.stopped) return;
			if (!(await this.opts.lease.acquire())) throw new Error("lost the archive lease");
			if (step.kind === "evict" && !stageChecked) {
				// Staged days were finished above: the stage is empty, check its columns again.
				await this.ensureStage(table, true);
				stageChecked = true;
			}
			await this.runStep(table, step, main.find((p) => p.day === step.day)?.rows ?? 0);
			result.steps += 1;
			if (step.kind === "expire") result.expiredDays.push(step.day);
			else result.archivedDays.push(step.day);
		}
	}

	private async runStep(table: ArchiveTable, step: ArchiveStep, hotRows: number): Promise<void> {
		const { db } = this.opts;
		const partition = chString(partitionIdForDay(step.day));
		switch (step.kind) {
			case "expire":
				await db.command(`ALTER TABLE ${this.t(table)} DROP PARTITION ID ${partition}`);
				await this.writeLog(table, step.day, step.generation, "expired", hotRows, 0);
				console.log(`runtime archive: ${table} ${step.day} is older than ARCHIVE_RETENTION_DAYS; dropped without export`);
				return;
			case "drop-stage":
				await db.command(`ALTER TABLE ${this.t(stageTableName(table))} DROP PARTITION ID ${partition}`);
				return;
			case "evict":
				await this.writeLog(table, step.day, step.generation, "exporting", hotRows, 0);
				await db.command(`ALTER TABLE ${this.t(table)} MOVE PARTITION ID ${partition} TO TABLE ${this.t(stageTableName(table))}`);
				await this.exportStaged(table, step.day, step.generation);
				return;
			case "export-stage":
				await this.writeLog(table, step.day, step.generation, "exporting", 0, 0);
				await this.exportStaged(table, step.day, step.generation);
				return;
		}
	}

	/** Staged rows → one Parquet object per org, each read back and counted, then logged and dropped. */
	private async exportStaged(table: ArchiveTable, day: string, generation: number): Promise<void> {
		const { db, config } = this.opts;
		const stage = this.t(stageTableName(table));
		const final = ARCHIVE_TABLE_SPECS[table].final ? " FINAL" : "";
		const partition = chString(partitionIdForDay(day));
		const orgs = await db.query<{ org_id: string; rows: string | number }>(
			`SELECT org_id, count() AS rows FROM ${stage}${final} WHERE _partition_id = ${partition} GROUP BY org_id ORDER BY org_id`,
		);
		let total = 0;
		for (const org of orgs) {
			if (!(await this.opts.lease.acquire())) throw new Error("lost the archive lease");
			const expected = Number(org.rows) || 0;
			const target = s3Function(config, archiveObjectPath(table, org.org_id, day, generation));
			await db.command(
				`INSERT INTO FUNCTION ${target}
				SELECT * FROM ${stage}${final} WHERE _partition_id = ${partition} AND org_id = ${chString(org.org_id)}
				SETTINGS s3_truncate_on_insert = 1, output_format_parquet_compression_method = 'zstd'`,
			);
			const [readBack] = await db.query<{ rows: string | number }>(`SELECT count() AS rows FROM ${target}`);
			const got = Number(readBack?.rows ?? -1);
			if (got !== expected) {
				throw new Error(`${table} ${day} org ${org.org_id}: wrote ${expected} rows but read back ${got}; the staged partition is kept`);
			}
			total += expected;
		}
		await this.writeLog(table, day, generation, "archived", total, orgs.length);
		await db.command(`ALTER TABLE ${stage} DROP PARTITION ID ${partition}`);
		console.log(`runtime archive: ${table} ${day} → ${orgs.length} org object(s), ${total} rows (generation ${generation})`);
	}
}
