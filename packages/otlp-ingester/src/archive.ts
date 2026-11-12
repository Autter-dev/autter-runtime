import { createHash, randomInt, randomUUID } from "node:crypto";
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
 *      and each object is read back and its row count compared. A rerun of
 *      the same generation counts the objects it already has; only a short
 *      object of a generation not yet archived is ever rewritten, and an
 *      archived generation's objects never are;
 *   4. the log row becomes `archived`; then, right before the staged
 *      partition is dropped, every org's object is read back again and must
 *      hold the rows the stage and the log say.
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
 * or the one started with ARCHIVE_SCHEDULER=on. On top of that, a pass
 * holds a lock in ClickHouse itself (ClickHouseArchiveLock), checked before
 * every change, so two runners never work at once even when the lease is
 * lost or two replicas are set to run the job.
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
	/** Added to new generations (RuntimeArchiver: random per runner, 0–9999). */
	generationOffset?: number;
}

function latestByDay(log: ArchiveLogEntry[]): Map<string, ArchiveLogEntry> {
	const out = new Map<string, ArchiveLogEntry>();
	for (const entry of log) {
		const current = out.get(entry.day);
		if (!current || entry.generation > current.generation) out.set(entry.day, entry);
	}
	return out;
}

/**
 * A generation newer than any logged for the day: seconds since the epoch,
 * plus the runner's offset (0–9999) so two runners never pick the same one.
 */
function newGeneration(now: Date, latest: ArchiveLogEntry | undefined, offset = 0): number {
	return Math.max(Math.floor(now.getTime() / 1000) + offset, (latest?.generation ?? 0) + 1);
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
		else steps.push({ kind: "export-stage", day: part.day, generation: newGeneration(input.now, entry, input.generationOffset) });
	}
	for (const part of [...input.main].sort((a, b) => a.day.localeCompare(b.day))) {
		if (part.day >= cutoff || staged.has(part.day) || part.rows <= 0) continue;
		const entry = latest.get(part.day);
		if (part.day < expiry) {
			steps.push({ kind: "expire", day: part.day, generation: newGeneration(input.now, entry, input.generationOffset) });
			continue;
		}
		// Always a new generation: objects are written once, so a move never
		// adds rows to a generation that may already have objects.
		steps.push({ kind: "evict", day: part.day, generation: newGeneration(input.now, entry, input.generationOffset) });
	}
	return steps.slice(0, Math.max(1, input.maxSteps));
}

// ── TTL (pure) ─────────────────────────────────────────────────────────────

/** One element of a table's TTL list, as system.tables prints it. */
export interface TtlRule {
	/** The element's text, kept verbatim when the list is rewritten (MODIFY TTL replaces the whole list). */
	text: string;
	/** A delete rule (no TO VOLUME / TO DISK / RECOMPRESS / GROUP BY action), or another kind. */
	kind: "delete" | "other";
	/** Delete rules: the interval in days (months count 30, years 365). */
	days?: number;
}

export type ParsedTtl =
	/** No TTL clause at all. */
	| { kind: "none" }
	/** A TTL this code does not understand: it is left exactly as it is. */
	| { kind: "unrecognised"; reason: string; text: string }
	/** The TTL list; deleteDays is null when it has no delete rule (only moves / recompression). */
	| { kind: "rules"; rules: TtlRule[]; deleteDays: number | null; text: string };

/** Where `keyword` (upper case, words separated by one space) starts at the top level of `text`, or -1. */
function topLevelKeyword(text: string, keyword: string, from = 0): number {
	const words = keyword.split(" ");
	let depth = 0;
	let quote: string | null = null;
	for (let i = from; i < text.length; i++) {
		const c = text[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === "`" || c === '"') quote = c;
		else if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth--;
		else if (depth === 0 && /[A-Z]/.test(c) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]!))) {
			let j = i;
			let matched = true;
			for (const [n, word] of words.entries()) {
				if (n > 0) {
					if (!/\s/.test(text[j] ?? "")) {
						matched = false;
						break;
					}
					while (/\s/.test(text[j] ?? "")) j++;
				}
				if (text.slice(j, j + word.length) !== word) {
					matched = false;
					break;
				}
				j += word.length;
			}
			if (matched && !/[A-Za-z0-9_]/.test(text[j] ?? "")) return i;
		}
	}
	return -1;
}

/** `text` split at top-level occurrences of `separator` (outside brackets and quotes). */
function splitTopLevel(text: string, separator: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === "`" || c === '"') quote = c;
		else if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth--;
		else if (depth === 0 && c === separator) {
			out.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(text.slice(start).trim());
	return out;
}

const INTERVAL_DAYS: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };

/** Days of `<time column> + <interval> [+ <interval> …]`, or null when it is anything else. */
function deleteExpressionDays(expression: string): number | null {
	const terms = splitTopLevel(expression, "+");
	if (terms.length < 2) return null;
	if (!/^(?:(?:toDateTime|toDate|toDateTime64)\(\s*`?[A-Za-z_][A-Za-z0-9_]*`?\s*\)|`?[A-Za-z_][A-Za-z0-9_]*`?)$/.test(terms[0]!)) return null;
	let days = 0;
	for (const term of terms.slice(1)) {
		const fn = /^toInterval(Day|Week|Month|Year)\(\s*(\d+)\s*\)$/i.exec(term);
		const kw = /^INTERVAL\s+'?(\d+)'?\s+(DAY|WEEK|MONTH|YEAR)S?$/i.exec(term);
		if (fn) days += Number(fn[2]) * INTERVAL_DAYS[fn[1]!.toUpperCase()]!;
		else if (kw) days += Number(kw[1]) * INTERVAL_DAYS[kw[2]!.toUpperCase()]!;
		else return null;
	}
	return days > 0 ? days : null;
}

/**
 * The TTL list of a system.tables engine_full. Delete rules are told from
 * move (TO VOLUME / TO DISK), RECOMPRESS and GROUP BY rules; a delete rule
 * must be a time column plus day/week/month/year intervals. A conditional
 * delete (WHERE), two delete rules, or any other expression makes the whole
 * TTL unrecognised, and unrecognised TTLs are never changed.
 */
export function parseTtl(engineFull: string): ParsedTtl {
	const at = topLevelKeyword(engineFull, "TTL");
	if (at < 0) return { kind: "none" };
	const settings = topLevelKeyword(engineFull, "SETTINGS", at);
	const text = engineFull.slice(at + 3, settings < 0 ? undefined : settings).trim();
	if (!text) return { kind: "unrecognised", reason: "empty TTL", text };
	const rules: TtlRule[] = [];
	let deleteDays: number | null = null;
	for (const element of splitTopLevel(text, ",")) {
		const actions = ["TO VOLUME", "TO DISK", "RECOMPRESS", "GROUP BY"].map((k) => topLevelKeyword(element, k)).filter((i) => i >= 0);
		if (actions.length > 0) {
			rules.push({ text: element, kind: "other" });
			continue;
		}
		if (topLevelKeyword(element, "WHERE") >= 0) return { kind: "unrecognised", reason: "a conditional delete (WHERE)", text };
		const del = topLevelKeyword(element, "DELETE");
		const expression = (del >= 0 ? element.slice(0, del) : element).trim();
		if (del >= 0 && element.slice(del + "DELETE".length).trim()) return { kind: "unrecognised", reason: `unexpected text after DELETE in ${element}`, text };
		const days = deleteExpressionDays(expression);
		if (days === null) return { kind: "unrecognised", reason: `delete rule ${element}`, text };
		if (deleteDays !== null) return { kind: "unrecognised", reason: "more than one delete rule", text };
		deleteDays = days;
		rules.push({ text: element, kind: "delete", days });
	}
	return { kind: "rules", rules, deleteDays, text };
}

/** Days of the delete TTL in a system.tables engine_full: null when it has none, "unrecognised" when it cannot be read. */
export function parseTtlDays(engineFull: string): number | null | "unrecognised" {
	const parsed = parseTtl(engineFull);
	if (parsed.kind === "none") return null;
	if (parsed.kind === "unrecognised") return "unrecognised";
	return parsed.deleteDays;
}

/** The TTL list with the delete rule set to `days` (or removed: null), every other rule kept as it was. */
export function ttlRulesWithDelete(rules: readonly TtlRule[], column: string, days: number | null): string[] {
	const others = rules.filter((r) => r.kind !== "delete").map((r) => r.text);
	return days === null ? others : [...others, `toDateTime(${column}) + INTERVAL ${days} DAY`];
}

/** The statement that gives `qualified` exactly these TTL rules (REMOVE TTL when there are none). */
export function ttlStatement(qualified: string, rules: readonly string[]): string {
	return rules.length > 0 ? `ALTER TABLE ${qualified} MODIFY TTL ${rules.join(", ")}` : `ALTER TABLE ${qualified} REMOVE TTL`;
}

/** Settings for every TTL change: never rewrite existing parts on the spot (TTL applies at merges). */
export const TTL_ALTER_SETTINGS = { materialize_ttl_after_modify: 0 } as const;

export type TtlPlan =
	| { action: "none"; warning?: string }
	/** Run `sql` (with TTL_ALTER_SETTINGS). */
	| { action: "alter"; sql: string; message: string }
	/** The change would delete rows that are not archived: not now (the archive job re-checks after each pass). */
	| { action: "wait"; warning: string };

/**
 * The TTL change a table needs, if any. Only the delete rule is ever touched;
 * move and recompress rules are kept.
 *
 * - Archived: the backstop (ARCHIVE_BACKSTOP_DAYS, default hot window + 7
 *   days), or no delete rule at all for 0.
 * - Not archived: runtime_logs follows LOG_TTL_DAYS when it is set
 *   (followHotDays); every other TTL is left as it is, and a table with no
 *   delete rule never gets one (the caller warns with noTtlWarning).
 *
 * A change that only keeps rows longer (a longer TTL, or removing the
 * delete rule) is made at once. One that deletes rows (adding a delete rule
 * or shortening it) waits until no day older than the new TTL is left in the
 * table: for an archived table, until the job has archived those days; for
 * runtime_logs without an archive, the operator is told the statement
 * instead.
 */
export function planRetentionTtl(input: {
	database: string;
	table: ArchiveTable;
	engineFull: string;
	hotDays: number;
	archived: boolean;
	backstopDays: number | "auto";
	/** runtime_logs with LOG_TTL_DAYS set: its delete TTL follows hotDays. */
	followHotDays: boolean;
	/** Oldest day partition of the table that still has rows (null: empty). */
	oldestDay: string | null;
	now: Date;
	maxDaysPerPass?: number;
}): TtlPlan {
	const qualified = `${input.database}.${input.table}`;
	const column = ARCHIVE_TABLE_SPECS[input.table].timeColumn;
	const parsed = parseTtl(input.engineFull);
	if (parsed.kind === "unrecognised") {
		return { action: "none", warning: `${input.table} TTL not recognised (${parsed.reason}), retention left as it is: TTL ${parsed.text}` };
	}
	const rules = parsed.kind === "rules" ? parsed.rules : [];
	const current = parsed.kind === "rules" ? parsed.deleteDays : null;
	let target: number | null;
	if (input.archived) {
		target = effectiveBackstopDays(input.backstopDays, input.hotDays);
	} else if (current === null) {
		return { action: "none", warning: noTtlWarning({ db: input.database, table: input.table, hotDays: input.hotDays, rules }) };
	} else if (input.followHotDays) {
		target = input.hotDays;
	} else {
		return { action: "none" };
	}
	if (target === current) return { action: "none" };
	const sql = ttlStatement(qualified, ttlRulesWithDelete(rules, column, target));
	if (target === null) {
		return { action: "alter", sql, message: `${input.table}: delete TTL removed (other TTL rules kept) — the runtime archive drops days once they are exported` };
	}
	const change = current === null ? `added (${target} days)` : `changed from ${current} to ${target} days`;
	if (current !== null && target > current) return { action: "alter", sql, message: `${input.table} delete TTL ${change}` };
	// Adding or shortening deletes every row older than the new TTL.
	const firstKept = addDays(utcDay(input.now), 1 - target);
	if (input.oldestDay === null || input.oldestDay >= firstKept) return { action: "alter", sql, message: `${input.table} delete TTL ${change}` };
	if (input.archived) {
		return {
			action: "wait",
			warning:
				`runtime archive: ${input.table} keeps its delete TTL (${current === null ? "none" : `${current} days`}) instead of the ${target}-day backstop ` +
				`until every day before ${firstKept} is archived (the oldest in the table is ${input.oldestDay}); ` +
				`the archive job works through them${input.maxDaysPerPass ? `, ${input.maxDaysPerPass} days per pass,` : ""} and sets the TTL after the pass that finishes`,
		};
	}
	return {
		action: "wait",
		warning:
			`${input.table}: LOG_TTL_DAYS=${target} is shorter than its ${current}-day delete TTL and the table has rows from ${input.oldestDay}: ` +
			`the ingester does not shorten a TTL while that would delete rows. To shorten it anyway, run: ${sql} SETTINGS materialize_ttl_after_modify = 0`,
	};
}

/**
 * What to log for a table that has no delete TTL and is not archived: the
 * ingester leaves it alone (also after an archive that removed it is turned
 * off), and this is the statement that adds one, keeping its other rules.
 */
export function noTtlWarning(input: { db: string; table: ArchiveTable; hotDays: number; rules?: readonly TtlRule[] }): string {
	const column = ARCHIVE_TABLE_SPECS[input.table].timeColumn;
	const statement = ttlStatement(`${input.db}.${input.table}`, ttlRulesWithDelete(input.rules ?? [], column, input.hotDays));
	return (
		`${input.table} has no delete TTL and no archive is configured for it: rows stay until you delete them. ` +
		`The ingester does not add a TTL, since that would delete rows older than it (an archive with ARCHIVE_BACKSTOP_DAYS=0 removes it, and turning the archive off does not put it back). ` +
		`To expire rows after ${input.hotDays} days, run: ${statement}`
	);
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

// ── ClickHouse access ──────────────────────────────────────────────────────

/** The ClickHouse calls the job makes (tests pass a stand-in). */
export interface ArchiveDb {
	query<T>(sql: string): Promise<T[]>;
	command(sql: string, settings?: Record<string, string | number>): Promise<void>;
}

/** Day partitions with rows, per table, for `tables` (one system.parts read). */
async function partitionsByTable(db: ArchiveDb, database: string, tables: readonly string[]): Promise<Map<string, PartitionRows[]>> {
	const out = new Map<string, PartitionRows[]>(tables.map((t) => [t, []]));
	if (tables.length === 0) return out;
	const rows = await db.query<{ table: string; partition_id: string; rows: string | number }>(
		`SELECT table, partition_id, sum(rows) AS rows FROM system.parts
		WHERE database = ${chString(database)} AND active AND table IN (${tables.map(chString).join(", ")})
		GROUP BY table, partition_id`,
	);
	for (const row of rows) {
		const day = dayFromPartitionId(String(row.partition_id));
		const n = Number(row.rows) || 0;
		if (day && n > 0) out.get(row.table)?.push({ day, rows: n });
	}
	return out;
}

function oldestDay(parts: readonly PartitionRows[]): string | null {
	let oldest: string | null = null;
	for (const p of parts) if (p.rows > 0 && (oldest === null || p.day < oldest)) oldest = p.day;
	return oldest;
}

export interface RetentionTtlOptions {
	db: ArchiveDb;
	database: string;
	archive: ArchiveConfig | null;
	hotDays: Record<ArchiveTable, number>;
	/** LOG_TTL_DAYS was set: runtime_logs' delete TTL follows it. Unset, an existing TTL is left alone. */
	logTtlExplicit: boolean;
	now: Date;
	/** Only these tables (the archive job re-checks the ones it archives after each pass). */
	tables?: readonly ArchiveTable[];
}

/**
 * Bring each table's delete TTL in line (planRetentionTtl) and return what
 * was planned. Every ALTER runs with materialize_ttl_after_modify = 0.
 * Without an archive, a stage table left with rows is reported with the
 * statement that puts them back.
 */
export async function reconcileRetentionTtls(opts: RetentionTtlOptions): Promise<Array<{ table: ArchiveTable; plan: TtlPlan }>> {
	const { db, database, archive } = opts;
	const tables = (opts.tables ?? ARCHIVE_TABLES).filter((t) => (ARCHIVE_TABLES as readonly string[]).includes(t));
	const engines = await db.query<{ name: string; engine_full: string }>(
		`SELECT name, engine_full FROM system.tables WHERE database = ${chString(database)} AND name IN (${tables.map(chString).join(", ")})`,
	);
	const parts = await partitionsByTable(db, database, [...tables, ...tables.map(stageTableName)]);
	const out: Array<{ table: ArchiveTable; plan: TtlPlan }> = [];
	for (const table of tables) {
		const engine = engines.find((e) => e.name === table);
		if (!engine) continue;
		const archived = Boolean(archive?.tables.includes(table));
		const plan = planRetentionTtl({
			database,
			table,
			engineFull: engine.engine_full,
			hotDays: opts.hotDays[table],
			archived,
			backstopDays: archive?.backstopDays ?? 0,
			followHotDays: table === "runtime_logs" && opts.logTtlExplicit,
			oldestDay: oldestDay(parts.get(table) ?? []),
			now: opts.now,
			maxDaysPerPass: archive?.maxDaysPerPass,
		});
		out.push({ table, plan });
		if (plan.action === "alter") {
			await db.command(plan.sql, TTL_ALTER_SETTINGS);
			console.log(plan.message);
		} else if (plan.warning) {
			console.warn(plan.warning);
		}
		const staged = parts.get(stageTableName(table)) ?? [];
		if (!archived && staged.length > 0) console.warn(leftoverStageWarning(database, table, staged));
	}
	return out;
}

/** A stage table that still holds rows while no archive covers its table (the archive was turned off mid-export). */
export function leftoverStageWarning(database: string, table: ArchiveTable, staged: readonly PartitionRows[]): string {
	const days = [...staged].sort((a, b) => a.day.localeCompare(b.day));
	const rows = days.reduce((sum, p) => sum + p.rows, 0);
	const first = days[0]!;
	return (
		`${stageTableName(table)} holds ${rows} rows of ${days.length} day(s) (${days.map((d) => d.day).join(", ")}) that were moved out of ${table} for export ` +
		`and never archived, and no archive is configured for ${table}. They are not lost, but no query reads them. To put them back, run per day: ` +
		`ALTER TABLE ${database}.${stageTableName(table)} MOVE PARTITION ID ${chString(partitionIdForDay(first.day))} TO TABLE ${database}.${table}`
	);
}

// ── The ClickHouse lock ────────────────────────────────────────────────────

export const ARCHIVE_LOCK_TABLE = "runtime_archive_lock";
/** A lock not refreshed for this long belongs to a runner that is gone: longer than one statement may run (max_execution_time 3600 s). */
export const ARCHIVE_LOCK_STALE_SECONDS = 2 * 3600;

export interface ArchiveRunLock {
	/** Take the lock, or confirm this runner still holds it (and refresh it); false when another runner holds it. */
	hold(): Promise<boolean>;
	release(): Promise<void>;
}

/** The ClickHouse error code and type travel as properties (@clickhouse/client), not always in the message. */
function errorText(err: unknown): string {
	const e = err as { message?: unknown; code?: unknown; type?: unknown };
	return [err instanceof Error ? err.message : String(err), e?.code !== undefined ? `Code: ${e.code}` : "", e?.type ?? ""].join(" ");
}

function isAlreadyExists(err: unknown): boolean {
	return /TABLE_ALREADY_EXISTS|Code: 57\b|already exists/i.test(errorText(err));
}

export function isUnknownTable(err: unknown): boolean {
	return /UNKNOWN_TABLE|Code: 60\b|Unknown table|does not exist|doesn't exist/i.test(errorText(err));
}

/**
 * Mutual exclusion between archive runners in ClickHouse itself, whatever
 * the Redis lease says (it can be lost while its holder still runs, and
 * ARCHIVE_SCHEDULER=on may be set on two replicas). The lock is a table:
 * `CREATE TABLE <db>.runtime_archive_lock … COMMENT '<token>'` succeeds for
 * exactly one runner (a second CREATE fails with TABLE_ALREADY_EXISTS), the
 * comment names the holder, and each hold() inserts a heartbeat row. The job
 * calls hold() before every partition move, object write and drop, so a
 * runner that lost the lock stops before its next statement. A lock with no
 * heartbeat for ARCHIVE_LOCK_STALE_SECONDS is taken over.
 */
export class ClickHouseArchiveLock implements ArchiveRunLock {
	constructor(
		private readonly db: ArchiveDb,
		private readonly database: string,
		readonly token: string = randomUUID(),
		private readonly staleSeconds = ARCHIVE_LOCK_STALE_SECONDS,
	) {}

	private get table(): string {
		return `${this.database}.${ARCHIVE_LOCK_TABLE}`;
	}

	private async holder(): Promise<{ holder: string; idleSeconds: number } | null> {
		const [row] = await this.db.query<{ holder: string; idle_seconds: string | number }>(
			`SELECT comment AS holder, dateDiff('second', greatest(metadata_modification_time, (SELECT toDateTime(max(at)) FROM ${this.table})), now()) AS idle_seconds
			FROM system.tables WHERE database = ${chString(this.database)} AND name = ${chString(ARCHIVE_LOCK_TABLE)}`,
		).catch((err: unknown) => {
			// No lock table (or dropped meanwhile): nobody holds it.
			if (isUnknownTable(err)) return [];
			throw err;
		});
		return row ? { holder: String(row.holder), idleSeconds: Number(row.idle_seconds) || 0 } : null;
	}

	private async beat(): Promise<void> {
		await this.db.command(`INSERT INTO ${this.table} (token) VALUES (${chString(this.token)})`);
	}

	private async create(): Promise<boolean> {
		try {
			await this.db.command(
				`CREATE TABLE ${this.table} (at DateTime64(3, 'UTC') DEFAULT now64(3), token String) ENGINE = MergeTree ORDER BY at COMMENT ${chString(this.token)}`,
			);
		} catch (err) {
			if (isAlreadyExists(err)) return false;
			throw err;
		}
		await this.beat();
		return true;
	}

	async hold(): Promise<boolean> {
		const current = await this.holder();
		if (!current) return this.create();
		if (current.holder === this.token) {
			await this.beat();
			// Taken over between the read and the heartbeat: the heartbeat landed in the new holder's table.
			return (await this.holder())?.holder === this.token;
		}
		if (current.idleSeconds < this.staleSeconds) return false;
		console.warn(`runtime archive: taking over the archive lock from ${current.holder} (no heartbeat for ${current.idleSeconds} s)`);
		await this.db.command(`DROP TABLE IF EXISTS ${this.table} SYNC`);
		return this.create();
	}

	async release(): Promise<void> {
		const current = await this.holder();
		if (current?.holder === this.token) await this.db.command(`DROP TABLE IF EXISTS ${this.table} SYNC`);
	}
}

// ── Pass records and status ────────────────────────────────────────────────

/**
 * One row per finished pass (kind `pass`, ok = no table failed) and one per
 * process with an archive configured, at start and hourly (kind
 * `configured`), so "configured but no pass" is visible from ClickHouse alone.
 */
export function archivePassesTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_archive_passes (
		at               DateTime64(3, 'UTC') DEFAULT now64(3),
		kind             LowCardinality(String),
		instance         String DEFAULT '',
		ok               UInt8 DEFAULT 0,
		runs_job         UInt8 DEFAULT 0,
		interval_minutes UInt16 DEFAULT 0,
		detail           String DEFAULT ''
	)
	ENGINE = MergeTree
	ORDER BY (kind, at)
	TTL toDateTime(at) + INTERVAL 30 DAY`;
}

/** Hours without a successful pass after which it is overdue: three intervals, at least 3 hours. */
export function archivePassWarnHours(intervalMinutes: number): number {
	return Math.max(3, Math.ceil((3 * intervalMinutes) / 60));
}

/**
 * Is a successful pass overdue? Counted from the last one, or from the first
 * `configured` row when there has been none (a new archive gets its grace).
 */
export function archivePassOverdue(input: {
	nowMs: number;
	lastOkPassMs: number | null;
	firstConfiguredMs: number | null;
	intervalMinutes: number;
}): { overdue: boolean; sinceMs: number | null; warnHours: number } {
	const warnHours = archivePassWarnHours(input.intervalMinutes);
	const since = Math.max(input.lastOkPassMs ?? 0, input.firstConfiguredMs ?? 0);
	if (since <= 0) return { overdue: false, sinceMs: null, warnHours };
	return { overdue: input.nowMs - since > warnHours * 3_600_000, sinceMs: since, warnHours };
}

export interface ArchiveStatusSnapshot {
	configured: true;
	/** This process runs the job; every process reports the passes recorded in ClickHouse. */
	runsJob: boolean;
	lastPassAt: string | null;
	lastSuccessfulPassAt: string | null;
	/** No pass without errors for passWarnHours (from the last one, or since the archive was configured). */
	passOverdue: boolean;
	passWarnHours: number;
	checkedAt: string | null;
	error?: string;
}

/**
 * Records that this process has an archive configured, reads the last pass
 * any process recorded, warns when none succeeded for passWarnHours, and
 * keeps the result for /healthz. Runs in every process with an archive, so
 * a job that never runs (no lease holder, every replica ARCHIVE_SCHEDULER=off)
 * is reported too.
 */
export class ArchiveStatusReporter {
	private timer: NodeJS.Timeout | null = null;
	private state: ArchiveStatusSnapshot;
	private readonly instance = randomUUID();
	private readonly now: () => Date;

	constructor(
		private readonly opts: { db: ArchiveDb; database: string; config: ArchiveConfig; runsJob: boolean; now?: () => Date },
	) {
		this.now = opts.now ?? (() => new Date());
		this.state = {
			configured: true,
			runsJob: opts.runsJob,
			lastPassAt: null,
			lastSuccessfulPassAt: null,
			passOverdue: false,
			passWarnHours: archivePassWarnHours(opts.config.intervalMinutes),
			checkedAt: null,
		};
	}

	snapshot(): ArchiveStatusSnapshot {
		return { ...this.state };
	}

	/** Report now, then every hour. */
	start(): void {
		if (this.timer) return;
		const tick = () => void this.report().catch(() => {});
		tick();
		this.timer = setInterval(tick, 60 * 60_000);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async report(): Promise<ArchiveStatusSnapshot> {
		const { db, database, config } = this.opts;
		try {
			await db.command(archivePassesTableDDL(database));
			await db.command(
				`INSERT INTO ${database}.runtime_archive_passes (kind, instance, runs_job, interval_minutes) VALUES ('configured', ${chString(this.instance)}, ${this.opts.runsJob ? 1 : 0}, ${config.intervalMinutes})`,
			);
			const [row] = await db.query<{ last_ok_ms: string | number; last_ms: string | number; first_configured_ms: string | number; now_ms: string | number }>(
				`SELECT toUnixTimestamp64Milli(maxIf(at, kind = 'pass' AND ok = 1)) AS last_ok_ms, toUnixTimestamp64Milli(maxIf(at, kind = 'pass')) AS last_ms,
					toUnixTimestamp64Milli(minIf(at, kind = 'configured')) AS first_configured_ms, toUnixTimestamp64Milli(now64(3)) AS now_ms
				FROM ${database}.runtime_archive_passes`,
			);
			const ms = (v: unknown) => (Number(v) > 0 ? Number(v) : null);
			const lastOk = ms(row?.last_ok_ms);
			const last = ms(row?.last_ms);
			const nowMs = ms(row?.now_ms) ?? this.now().getTime();
			const due = archivePassOverdue({ nowMs, lastOkPassMs: lastOk, firstConfiguredMs: ms(row?.first_configured_ms), intervalMinutes: config.intervalMinutes });
			this.state = {
				configured: true,
				runsJob: this.opts.runsJob,
				lastPassAt: last ? new Date(last).toISOString() : null,
				lastSuccessfulPassAt: lastOk ? new Date(lastOk).toISOString() : null,
				passOverdue: due.overdue,
				passWarnHours: due.warnHours,
				checkedAt: this.now().toISOString(),
			};
			if (due.overdue) console.warn(archivePassOverdueWarning(this.state, config.intervalMinutes));
		} catch (err) {
			this.state = { ...this.state, checkedAt: this.now().toISOString(), error: err instanceof Error ? err.message : String(err) };
			console.warn(`runtime archive: status check failed: ${this.state.error}`);
		}
		return this.snapshot();
	}
}

export function archivePassOverdueWarning(state: ArchiveStatusSnapshot, intervalMinutes: number): string {
	return (
		`runtime archive: an archive is configured but no archive pass has finished without errors ` +
		(state.lastSuccessfulPassAt ? `since ${state.lastSuccessfulPassAt}` : "since it was configured") +
		` (more than ${state.passWarnHours} hours; passes run every ${intervalMinutes} min). Old days are not being archived. ` +
		`Check that exactly one process runs the job (AUTTER_REDIS_URL with Redis reachable, or AUTTER_INGESTER_REPLICAS=1, or ARCHIVE_SCHEDULER=on on one instance) ` +
		`and the ingester log for "runtime archive: … pass stopped"`
	);
}

// ── The job ────────────────────────────────────────────────────────────────

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
	skipped?: "lease" | "running" | "lock";
	tables: ArchivePassTableResult[];
}

export interface RuntimeArchiverOptions {
	db: ArchiveDb;
	database: string;
	config: ArchiveConfig;
	hotDays: Record<ArchiveTable, number>;
	lease: ArchiveLease;
	/** Default: a ClickHouseArchiveLock on `db`. */
	lock?: ArchiveRunLock;
	/** Added to new generations; default random 0–9999 per runner. */
	generationOffset?: number;
	now?: () => Date;
}

/** An s3() INSERT refused because the object exists (objects are written once, never replaced). */
function isObjectExists(err: unknown): boolean {
	return /already exists/i.test(errorText(err));
}

export class RuntimeArchiver {
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<ArchivePassResult> | null = null;
	private stopped = false;
	private readonly now: () => Date;
	private readonly lock: ArchiveRunLock;
	private readonly generationOffset: number;
	lastPass: { at: Date; result: ArchivePassResult } | null = null;

	constructor(private readonly opts: RuntimeArchiverOptions) {
		this.now = opts.now ?? (() => new Date());
		this.lock = opts.lock ?? new ClickHouseArchiveLock(opts.db, opts.database);
		this.generationOffset = opts.generationOffset ?? randomInt(0, 10_000);
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
	 * leases are left to expire so no other process starts on the same staged
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

	/** Still the one runner: the Redis (or local) lease and the ClickHouse lock. Before every change. */
	private async fence(): Promise<void> {
		if (!(await this.opts.lease.acquire())) throw new Error("lost the archive lease");
		if (!(await this.lock.hold())) throw new Error("another runner holds the archive lock");
	}

	private async pass(): Promise<ArchivePassResult> {
		if (!(await this.opts.lease.acquire())) return { skipped: "lease", tables: [] };
		const { db } = this.opts;
		await db.command(archiveLogTableDDL(this.opts.database));
		await db.command(archivePassesTableDDL(this.opts.database));
		if (!(await this.lock.hold())) {
			console.log("runtime archive: another runner holds the archive lock (runtime_archive_lock); skipping this pass");
			return { skipped: "lock", tables: [] };
		}
		const tables: ArchivePassTableResult[] = [];
		try {
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
			if (!this.stopped) {
				// A backstop that waited for old days to be archived (planRetentionTtl) is set once they are.
				try {
					await this.fence();
					await reconcileRetentionTtls({
						db,
						database: this.opts.database,
						archive: this.opts.config,
						hotDays: this.opts.hotDays,
						logTtlExplicit: false,
						now: this.now(),
						tables: this.opts.config.tables,
					});
				} catch (err) {
					console.warn(`runtime archive: TTL check skipped: ${err instanceof Error ? err.message : err}`);
				}
				const failed = tables.filter((t) => t.error).map((t) => t.table);
				const detail = JSON.stringify({
					archived: tables.reduce((n, t) => n + t.archivedDays.length, 0),
					expired: tables.reduce((n, t) => n + t.expiredDays.length, 0),
					failed,
				});
				await db
					.command(
						`INSERT INTO ${this.t("runtime_archive_passes")} (kind, ok, runs_job, interval_minutes, detail) VALUES ('pass', ${failed.length === 0 ? 1 : 0}, 1, ${this.opts.config.intervalMinutes}, ${chString(detail)})`,
					)
					.catch((err) => console.warn(`runtime archive: pass not recorded: ${err instanceof Error ? err.message : err}`));
			}
		} finally {
			// A stopped pass may still be writing: its lock is left to go stale.
			if (!this.stopped) await this.lock.release().catch(() => {});
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

	private async logEntries(table: ArchiveTable, day?: string): Promise<ArchiveLogEntry[]> {
		const rows = await this.opts.db.query<{ day: string; generation: string | number; status: string; rows: string | number }>(
			`SELECT toString(day) AS day, generation, argMax(status, updated_at) AS status, argMax(rows, updated_at) AS rows
			FROM ${this.t("runtime_archive_log")}
			WHERE table_name = ${chString(table)}${day ? ` AND day = ${chString(day)}` : ""}
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
		if (engine && parseTtl(engine.engine_full).kind !== "none") {
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
			generationOffset: this.generationOffset,
		});
		if (steps.length === 0) return;
		await this.fence();
		await this.ensureStage(table, staged.length === 0);
		let stageChecked = staged.length === 0;
		for (const step of steps) {
			if (this.stopped) return;
			await this.fence();
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
				await this.dropStaged(table, step.day, step.generation);
				return;
			case "evict":
			case "export-stage": {
				// Never reopen a generation that is logged archived: its objects are final.
				const entry = (await this.logEntries(table, step.day)).find((e) => e.generation === step.generation);
				if (entry?.status === "archived") throw new Error(`${table} ${step.day} generation ${step.generation} is already archived; the next pass plans again`);
				// A generation already logged `exporting` is not logged again: a late
				// `exporting` row would hide an `archived` one written meanwhile.
				await this.fence();
				if (entry?.status !== "exporting") await this.writeLog(table, step.day, step.generation, "exporting", step.kind === "evict" ? hotRows : 0, 0);
				if (step.kind === "evict") {
					await this.fence();
					await db.command(`ALTER TABLE ${this.t(table)} MOVE PARTITION ID ${partition} TO TABLE ${this.t(stageTableName(table))}`);
				}
				await this.exportStaged(table, step.day, step.generation);
				return;
			}
		}
	}

	private async stagedOrgs(table: ArchiveTable, day: string): Promise<Array<{ org_id: string; rows: number }>> {
		const final = ARCHIVE_TABLE_SPECS[table].final ? " FINAL" : "";
		const rows = await this.opts.db.query<{ org_id: string; rows: string | number }>(
			`SELECT org_id, count() AS rows FROM ${this.t(stageTableName(table))}${final} WHERE _partition_id = ${chString(partitionIdForDay(day))} GROUP BY org_id ORDER BY org_id`,
		);
		return rows.map((r) => ({ org_id: r.org_id, rows: Number(r.rows) || 0 }));
	}

	private async objectRows(table: ArchiveTable, orgId: string, day: string, generation: number): Promise<number> {
		const [readBack] = await this.opts.db.query<{ rows: string | number }>(
			`SELECT count() AS rows FROM ${s3Function(this.opts.config, archiveObjectPath(table, orgId, day, generation))}`,
		);
		return Number(readBack?.rows ?? -1);
	}

	/**
	 * Staged rows → one Parquet object per org, each read back and counted,
	 * then logged and dropped. The first INSERT never replaces an object
	 * (s3_truncate_on_insert = 0: ClickHouse refuses when it exists), so an
	 * object an earlier attempt at this generation wrote is only counted; a
	 * short one is rewritten only while the generation is not archived.
	 */
	private async exportStaged(table: ArchiveTable, day: string, generation: number): Promise<void> {
		const { db, config } = this.opts;
		const stage = this.t(stageTableName(table));
		const final = ARCHIVE_TABLE_SPECS[table].final ? " FINAL" : "";
		const partition = chString(partitionIdForDay(day));
		const orgs = await this.stagedOrgs(table, day);
		if (orgs.length === 0) {
			// Nothing staged (the move found no partition): nothing to archive, and an
			// `archived` row with no rows would hide the day's other generations.
			console.warn(`runtime archive: ${table} ${day}: nothing staged for generation ${generation}; nothing archived`);
			return;
		}
		let total = 0;
		for (const org of orgs) {
			await this.fence();
			const path = archiveObjectPath(table, org.org_id, day, generation);
			const write = (replace: boolean) =>
				db.command(
					`INSERT INTO FUNCTION ${s3Function(config, path)}
					SELECT * FROM ${stage}${final} WHERE _partition_id = ${partition} AND org_id = ${chString(org.org_id)}
					SETTINGS s3_truncate_on_insert = ${replace ? 1 : 0}, s3_create_new_file_on_insert = 0, output_format_parquet_compression_method = 'zstd'`,
				);
			try {
				await write(false);
			} catch (err) {
				// An earlier attempt at this generation wrote it: counted below.
				if (!isObjectExists(err)) throw err;
			}
			let got = await this.objectRows(table, org.org_id, day, generation);
			if (got !== org.rows) {
				// A short object of a generation that is not archived (a failed
				// write) is rewritten once, under the lock. An archived
				// generation's objects are never replaced.
				const entry = (await this.logEntries(table, day)).find((e) => e.generation === generation);
				if (entry?.status !== "archived") {
					await this.fence();
					await write(true);
					got = await this.objectRows(table, org.org_id, day, generation);
				}
			}
			if (got !== org.rows) {
				throw new Error(`${table} ${day} org ${org.org_id}: wrote ${org.rows} rows but read back ${got}; the staged partition is kept`);
			}
			total += org.rows;
		}
		await this.fence();
		await this.writeLog(table, day, generation, "archived", total, orgs.length);
		await this.dropStaged(table, day, generation);
		console.log(`runtime archive: ${table} ${day} → ${orgs.length} org object(s), ${total} rows (generation ${generation})`);
	}

	/**
	 * Drop a staged day only when its generation is logged archived with as
	 * many rows as the stage holds and every org's object reads back with its
	 * rows, checked right before the drop.
	 */
	private async dropStaged(table: ArchiveTable, day: string, generation: number): Promise<void> {
		await this.fence();
		const entry = (await this.logEntries(table, day)).find((e) => e.generation === generation);
		const orgs = await this.stagedOrgs(table, day);
		const staged = orgs.reduce((sum, o) => sum + o.rows, 0);
		if (entry?.status !== "archived" || entry.rows !== staged) {
			throw new Error(
				`${table} ${day}: the stage holds ${staged} rows but generation ${generation} is logged ${entry?.status ?? "nowhere"} with ${entry?.rows ?? 0}; the staged partition is kept`,
			);
		}
		for (const org of orgs) {
			const got = await this.objectRows(table, org.org_id, day, generation);
			if (got !== org.rows) {
				throw new Error(`${table} ${day} org ${org.org_id}: generation ${generation} reads back ${got} rows, the stage holds ${org.rows}; the staged partition is kept`);
			}
		}
		await this.fence();
		await this.opts.db.command(`ALTER TABLE ${this.t(stageTableName(table))} DROP PARTITION ID ${chString(partitionIdForDay(day))}`);
	}
}
