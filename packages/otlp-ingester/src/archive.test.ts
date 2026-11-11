import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addDays,
	archiveConfigFromEnv,
	archiveObjectPath,
	archiveSchedulerMode,
	dayFromPartitionId,
	effectiveBackstopDays,
	hotCutoffDay,
	noTtlWarning,
	overdueDays,
	orgArchiveKey,
	parseTtlDays,
	planTableArchive,
	retentionTtlAction,
	RuntimeArchiver,
	s3Function,
	type ArchiveConfig,
	type ArchiveDb,
	type ArchiveLease,
	type ArchiveLogEntry,
	type ArchiveStep,
	type ArchiveTable,
	type PartitionRows,
} from "./archive.js";

/**
 * Tiered retention (archive.ts): partition planning, the "never drop a day
 * that is not archived" rule, TTL handling and the archive job against an
 * in-memory stand-in for ClickHouse + object storage (no S3 or ClickHouse
 * needed).
 */

const NOW = new Date("2026-11-09T10:00:00Z");

// ── Config ─────────────────────────────────────────────────────────────────

test("no archive URL or named collection: no archive (behaviour as before)", () => {
	assert.equal(archiveConfigFromEnv({}), null);
	assert.equal(archiveConfigFromEnv({ ARCHIVE_TABLES: "runtime_spans", ARCHIVE_RETENTION_DAYS: "90" }), null);
});

test("archive config: defaults, bounds, tables", () => {
	const config = archiveConfigFromEnv({ ARCHIVE_S3_URL: "https://bucket.s3.us-east-1.amazonaws.com/runtime/" });
	assert.ok(config);
	assert.equal(config.url, "https://bucket.s3.us-east-1.amazonaws.com/runtime");
	assert.deepEqual(config.tables, ["runtime_error_occurrences", "runtime_spans", "runtime_llm_calls", "runtime_logs"]);
	assert.equal(config.retentionDays, 365);
	assert.equal(config.backstopDays, "auto");
	assert.equal(config.overdueWarnDays, 2);
	assert.equal(config.intervalMinutes, 60);
	assert.equal(config.scheduler, "auto");
	const bounded = archiveConfigFromEnv({
		ARCHIVE_S3_URL: "https://storage.googleapis.com/bucket/runtime",
		ARCHIVE_S3_ACCESS_KEY_ID: "GOOG1E",
		ARCHIVE_S3_SECRET_ACCESS_KEY: "secret",
		ARCHIVE_RETENTION_DAYS: "5",
		ARCHIVE_TABLES: "runtime_spans, runtime_error_occurrences",
	});
	assert.equal(bounded?.retentionDays, 30);
	// Table order is fixed, whatever order they are listed in.
	assert.deepEqual(bounded?.tables, ["runtime_error_occurrences", "runtime_spans"]);
	assert.equal(archiveConfigFromEnv({ ARCHIVE_S3_NAMED_COLLECTION: "autter_archive" })?.namedCollection, "autter_archive");
});

test("archive config: inconsistent settings fail startup", () => {
	assert.throws(() => archiveConfigFromEnv({ ARCHIVE_S3_URL: "s3://bucket/x" }), /http\(s\)/);
	assert.throws(() => archiveConfigFromEnv({ ARCHIVE_S3_URL: "https://key:secret@bucket.example/x" }), /credentials/);
	assert.throws(() => archiveConfigFromEnv({ ARCHIVE_S3_URL: "https://b.example/x", ARCHIVE_S3_ACCESS_KEY_ID: "k" }), /both/);
	assert.throws(() => archiveConfigFromEnv({ ARCHIVE_S3_URL: "https://b.example/x", ARCHIVE_TABLES: "runtime_metrics_1m" }), /unknown table/);
	assert.throws(() => archiveConfigFromEnv({ ARCHIVE_S3_NAMED_COLLECTION: "bad-name" }), /identifier/);
	assert.throws(() => archiveConfigFromEnv({ ARCHIVE_S3_URL: "https://b.example/x", ARCHIVE_SCHEDULER: "maybe" }), /auto, on or off/);
});

// ── Paths and SQL ──────────────────────────────────────────────────────────

test("org keys: safe ids as they are, others readable plus a hash (pinned: the backend computes the same)", () => {
	assert.equal(orgArchiveKey("org_2abcXYZ-1"), "org_2abcXYZ-1");
	assert.equal(orgArchiveKey("a/b"), "a_b~c14cddc033f6");
	assert.equal(orgArchiveKey("acme.io"), "acme_io~187a3a5b1259");
	assert.equal(orgArchiveKey("Org Name/1"), "Org_Name_1~15aa86456cf0");
	// Two ids that read alike never share a folder.
	assert.notEqual(orgArchiveKey("a_b"), orgArchiveKey("a/b"));
	assert.equal(
		archiveObjectPath("runtime_spans", "org_1", "2026-10-01", 1793000000),
		"runtime_spans/org=org_1/date=2026-10-01/g1793000000.parquet",
	);
});

test("s3(): named collection, keys, or the server's own credentials; literals escaped", () => {
	const path = "runtime_spans/org=o/date=2026-10-01/g1.parquet";
	assert.equal(
		s3Function({ url: null, namedCollection: "autter_archive", accessKeyId: null, secretAccessKey: null }, path),
		`s3(autter_archive, filename = '${path}', format = 'Parquet')`,
	);
	assert.equal(
		s3Function({ url: "http://minio:9000/b", namedCollection: null, accessKeyId: "k", secretAccessKey: "s'x" }, path, "a String"),
		`s3('http://minio:9000/b/${path}', 'k', 's\\'x', 'Parquet', 'a String')`,
	);
	assert.equal(
		s3Function({ url: "https://b.s3.amazonaws.com/p", namedCollection: null, accessKeyId: null, secretAccessKey: null }, path),
		`s3('https://b.s3.amazonaws.com/p/${path}', 'Parquet')`,
	);
});

test("days and partition ids", () => {
	assert.equal(dayFromPartitionId("20261109"), "2026-11-09");
	assert.equal(dayFromPartitionId("20261340"), null);
	assert.equal(dayFromPartitionId("202611"), null);
	assert.equal(addDays("2026-03-01", -1), "2026-02-28");
	assert.equal(hotCutoffDay(NOW, 14), "2026-10-26");
});

// ── Planning ───────────────────────────────────────────────────────────────

const part = (day: string, rows = 10): PartitionRows => ({ day, rows });
const plan = (input: Partial<Parameters<typeof planTableArchive>[0]>): ArchiveStep[] =>
	planTableArchive({ now: NOW, hotDays: 14, retentionDays: 365, main: [], stage: [], log: [], maxSteps: 10, ...input });

test("plan: only days before the hot window are evicted, oldest first", () => {
	const steps = plan({ main: [part("2026-11-09"), part("2026-10-26"), part("2026-10-24"), part("2026-10-25")] });
	assert.deepEqual(
		steps.map((s) => [s.kind, s.day]),
		[
			["evict", "2026-10-24"],
			["evict", "2026-10-25"],
		],
	);
	// A new generation is newer than anything logged for the day.
	assert.ok(steps.every((s) => s.generation >= Math.floor(NOW.getTime() / 1000)));
});

test("plan: staged partitions are finished first and their day is not evicted in the same pass", () => {
	const log: ArchiveLogEntry[] = [
		{ day: "2026-10-20", generation: 100, status: "exporting", rows: 5 },
		{ day: "2026-10-21", generation: 200, status: "archived", rows: 7 },
	];
	const steps = plan({
		stage: [part("2026-10-21", 7), part("2026-10-20", 5)],
		main: [part("2026-10-20", 3), part("2026-10-22")],
		log,
	});
	assert.deepEqual(steps, [
		{ kind: "export-stage", day: "2026-10-20", generation: 100 },
		{ kind: "drop-stage", day: "2026-10-21", generation: 200 },
		{ kind: "evict", day: "2026-10-22", generation: steps[2]!.generation },
	]);
});

test("plan: a logged `exporting` with nothing staged reuses its generation; an archived day gets a new one", () => {
	const later = Math.floor(NOW.getTime() / 1000) + 50;
	const steps = plan({
		main: [part("2026-10-01"), part("2026-10-02")],
		log: [
			{ day: "2026-10-01", generation: 42, status: "exporting", rows: 10 },
			{ day: "2026-10-02", generation: later, status: "archived", rows: 10 },
		],
	});
	assert.deepEqual(steps[0], { kind: "evict", day: "2026-10-01", generation: 42 });
	// Late rows for an archived day: a second generation, never the first one's object.
	assert.deepEqual(steps[1], { kind: "evict", day: "2026-10-02", generation: later + 1 });
});

test("plan: days past the retention are expired without export; bounded per pass", () => {
	const steps = plan({ main: [part("2025-01-01"), part("2026-10-01"), part("2026-10-02")], maxSteps: 2 });
	assert.deepEqual(
		steps.map((s) => [s.kind, s.day]),
		[
			["expire", "2025-01-01"],
			["evict", "2026-10-01"],
		],
	);
});

test("plan invariant: never touches the hot window, never drops a staged day that is not logged archived", () => {
	let seed = 7;
	const rand = (n: number) => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed % n;
	};
	const statuses = ["exporting", "archived", "expired"] as const;
	for (let i = 0; i < 500; i++) {
		const hotDays = 1 + rand(30);
		const retentionDays = 30 + rand(400);
		const days = Array.from({ length: 1 + rand(12) }, () => addDays("2026-11-09", -rand(500)));
		const main = [...new Set(days)].map((d) => part(d, rand(3)));
		const stage = [...new Set(days.filter(() => rand(4) === 0))].map((d) => part(d));
		const log: ArchiveLogEntry[] = days
			.filter(() => rand(2) === 0)
			.map((d) => ({ day: d, generation: 1 + rand(5), status: statuses[rand(3)]!, rows: 1 }));
		const steps = planTableArchive({ now: NOW, hotDays, retentionDays, main, stage, log, maxSteps: 50 });
		const cutoff = hotCutoffDay(NOW, hotDays);
		const latest = new Map<string, ArchiveLogEntry>();
		for (const e of log) if (!latest.has(e.day) || e.generation > latest.get(e.day)!.generation) latest.set(e.day, e);
		for (const step of steps) {
			if (step.kind === "evict" || step.kind === "expire") {
				assert.ok(step.day < cutoff, `evicted ${step.day} inside the hot window (cutoff ${cutoff})`);
				assert.ok(!stage.some((s) => s.day === step.day), "evicted a day that is still staged");
			}
			if (step.kind === "expire") assert.ok(step.day < addDays("2026-11-09", -Math.max(retentionDays, hotDays)));
			if (step.kind === "drop-stage") {
				const entry = latest.get(step.day);
				assert.equal(entry?.status, "archived");
				assert.equal(entry?.generation, step.generation);
			}
		}
	}
});

// ── TTL ────────────────────────────────────────────────────────────────────

test("TTL without an archive: as before (runtime_logs follows LOG_TTL_DAYS, other tables keep theirs)", () => {
	const base = { hotDays: 14, archived: false, backstopDays: 0 };
	assert.deepEqual(retentionTtlAction({ ...base, current: 14, alwaysApply: true }), { action: "none" });
	assert.deepEqual(retentionTtlAction({ ...base, current: 30, alwaysApply: true }), { action: "modify", days: 14 });
	assert.deepEqual(retentionTtlAction({ ...base, current: 30, alwaysApply: false }), { action: "none" });
	assert.deepEqual(retentionTtlAction({ ...base, current: "unrecognised", alwaysApply: true }), { action: "none" });
});

test("TTL without an archive: a table that has no TTL never gets one (it would delete the rows older than it)", () => {
	// 1.14.0 added the hot-window TTL here, on the first boot after an upgrade.
	for (const hotDays of [7, 14, 90]) {
		for (const alwaysApply of [false, true]) {
			for (const backstopDays of [0, 30, "auto"] as const) {
				assert.deepEqual(
					retentionTtlAction({ current: null, hotDays, archived: false, backstopDays, alwaysApply }),
					{ action: "none" },
					`hotDays ${hotDays}, alwaysApply ${alwaysApply}, backstop ${backstopDays}`,
				);
			}
		}
	}
	// The operator is told, with the statement that adds one.
	const warning = noTtlWarning({ db: "autter_runtime", table: "runtime_spans", hotDays: 7 });
	assert.match(warning, /runtime_spans has no delete TTL/);
	assert.match(warning, /ALTER TABLE autter_runtime\.runtime_spans MODIFY TTL toDateTime\(started_at\) \+ INTERVAL 7 DAY$/);
	assert.match(
		noTtlWarning({ db: "autter_runtime", table: "runtime_logs", hotDays: 14 }),
		/MODIFY TTL toDateTime\(occurred_at\) \+ INTERVAL 14 DAY$/,
	);
});

test("TTL with an archive never deletes inside hot window + export: removed, or a backstop a week past the hot window", () => {
	const base = { hotDays: 14, archived: true, alwaysApply: false };
	assert.deepEqual(retentionTtlAction({ ...base, current: 14, backstopDays: 0 }), { action: "remove" });
	assert.deepEqual(retentionTtlAction({ ...base, current: null, backstopDays: 0 }), { action: "none" });
	assert.deepEqual(retentionTtlAction({ ...base, current: 14, backstopDays: 10 }), { action: "modify", days: 21 });
	assert.deepEqual(retentionTtlAction({ ...base, current: 60, backstopDays: 60 }), { action: "none" });
	assert.equal(effectiveBackstopDays(0, 7), null);
	assert.equal(effectiveBackstopDays(90, 7), 90);
});

test("backstop TTL is on by default: each table's hot window + 7 days; 0 turns it off", () => {
	const base = { archived: true, alwaysApply: false, backstopDays: "auto" as const };
	assert.deepEqual(retentionTtlAction({ ...base, hotDays: 7, current: 7 }), { action: "modify", days: 14 });
	assert.deepEqual(retentionTtlAction({ ...base, hotDays: 14, current: null }), { action: "modify", days: 21 });
	assert.deepEqual(retentionTtlAction({ ...base, hotDays: 90, current: 97 }), { action: "none" });
	assert.equal(effectiveBackstopDays("auto", 14), 21);
	const url = "https://bucket.s3.us-east-1.amazonaws.com/runtime";
	assert.equal(archiveConfigFromEnv({ ARCHIVE_S3_URL: url, ARCHIVE_BACKSTOP_DAYS: "auto" })?.backstopDays, "auto");
	assert.equal(archiveConfigFromEnv({ ARCHIVE_S3_URL: url, ARCHIVE_BACKSTOP_DAYS: "0" })?.backstopDays, 0);
	assert.equal(archiveConfigFromEnv({ ARCHIVE_S3_URL: url, ARCHIVE_BACKSTOP_DAYS: "60" })?.backstopDays, 60);
	assert.throws(() => archiveConfigFromEnv({ ARCHIVE_S3_URL: url, ARCHIVE_BACKSTOP_DAYS: "soon" }), /ARCHIVE_BACKSTOP_DAYS/);
});

test("overdue days: 0 while hourly passes keep up, climbing a day per day the job does not run", () => {
	const now = new Date("2026-11-20T12:00:00Z");
	// Hot window 7: the cutoff is 2026-11-13, so 2026-11-12 is the day that just left it.
	assert.equal(overdueDays({ now, hotDays: 7, main: [{ day: "2026-11-13", rows: 5 }], stage: [] }), 0);
	assert.equal(overdueDays({ now, hotDays: 7, main: [{ day: "2026-11-12", rows: 5 }], stage: [] }), 0);
	assert.equal(overdueDays({ now, hotDays: 7, main: [{ day: "2026-11-10", rows: 5 }, { day: "2026-11-12", rows: 1 }], stage: [] }), 2);
	// A day stuck in the stage table counts; empty partitions do not.
	assert.equal(overdueDays({ now, hotDays: 7, main: [{ day: "2026-11-01", rows: 0 }], stage: [{ day: "2026-11-09", rows: 3 }] }), 3);
});

test("TTL parsing from engine_full", () => {
	assert.equal(parseTtlDays("MergeTree PARTITION BY toDate(occurred_at) ORDER BY x TTL toDateTime(occurred_at) + toIntervalDay(14) SETTINGS index_granularity = 8192"), 14);
	assert.equal(parseTtlDays("MergeTree PARTITION BY toDate(occurred_at) ORDER BY x SETTINGS ttl_only_drop_parts = 0"), null);
	assert.equal(parseTtlDays("MergeTree ORDER BY x TTL occurred_at + toIntervalMonth(1)"), "unrecognised");
});

// ── Single instance ────────────────────────────────────────────────────────

test("scheduler: Redis lease, the only replica, or the instance told to; never two replicas without a lease", () => {
	assert.deepEqual(archiveSchedulerMode({ scheduler: "auto", hasRedis: true, replicas: 4 }), { mode: "redis" });
	assert.deepEqual(archiveSchedulerMode({ scheduler: "auto", hasRedis: false, replicas: 1 }), { mode: "local" });
	assert.equal(archiveSchedulerMode({ scheduler: "auto", hasRedis: false, replicas: 3 }).mode, "none");
	assert.deepEqual(archiveSchedulerMode({ scheduler: "on", hasRedis: false, replicas: 3 }), { mode: "local" });
	assert.equal(archiveSchedulerMode({ scheduler: "off", hasRedis: true, replicas: 1 }).mode, "none");
});

// ── The job, against a stand-in ClickHouse + bucket ────────────────────────

interface Row {
	org_id: string;
}

/** Just enough of ClickHouse (system.parts, MOVE/DROP PARTITION, the log, s3()) for the archive job's statements. */
class FakeClickHouse implements ArchiveDb {
	parts = new Map<string, Map<string, Row[]>>();
	log: Array<{ table_name: string; day: string; generation: number; status: string; rows: number; seq: number }> = [];
	objects = new Map<string, number>();
	statements: string[] = [];
	/** Throw on the first statement matching this (crash injection). */
	failOnce: RegExp | null = null;
	/** Rows the bucket "loses" on write (read-back check). */
	corruptWrites = false;
	private seq = 0;

	add(table: string, day: string, orgs: Record<string, number>): void {
		const days = this.parts.get(table) ?? new Map<string, Row[]>();
		const rows = days.get(day) ?? [];
		for (const [org, n] of Object.entries(orgs)) for (let i = 0; i < n; i++) rows.push({ org_id: org });
		days.set(day, rows);
		this.parts.set(table, days);
	}

	days(table: string): string[] {
		return [...(this.parts.get(table)?.keys() ?? [])].sort();
	}

	private check(sql: string): void {
		this.statements.push(sql);
		if (this.failOnce && this.failOnce.test(sql)) {
			this.failOnce = null;
			throw new Error("injected failure");
		}
	}

	private static day(pid: string): string {
		return `${pid.slice(0, 4)}-${pid.slice(4, 6)}-${pid.slice(6, 8)}`;
	}

	async command(sql: string): Promise<void> {
		this.check(sql);
		let m: RegExpExecArray | null;
		if (/^CREATE TABLE IF NOT EXISTS db\.runtime_archive_log/.test(sql.trim())) return;
		if ((m = /CREATE TABLE (?:IF NOT EXISTS )?db\.(\w+) AS db\.\w+/.exec(sql))) {
			if (!this.parts.has(m[1]!)) this.parts.set(m[1]!, new Map());
			return;
		}
		if ((m = /ALTER TABLE db\.(\w+) MOVE PARTITION ID '(\d+)' TO TABLE db\.(\w+)/.exec(sql))) {
			const day = FakeClickHouse.day(m[2]!);
			const rows = this.parts.get(m[1]!)?.get(day) ?? [];
			this.parts.get(m[1]!)?.delete(day);
			const target = this.parts.get(m[3]!)!;
			target.set(day, [...(target.get(day) ?? []), ...rows]);
			return;
		}
		if ((m = /ALTER TABLE db\.(\w+) DROP PARTITION ID '(\d+)'/.exec(sql))) {
			this.parts.get(m[1]!)?.delete(FakeClickHouse.day(m[2]!));
			return;
		}
		if ((m = /INSERT INTO db\.runtime_archive_log[^]*VALUES \('(\w+)', '([\d-]+)', (\d+), '(\w+)', (\d+)/.exec(sql))) {
			this.log.push({ table_name: m[1]!, day: m[2]!, generation: Number(m[3]), status: m[4]!, rows: Number(m[5]), seq: this.seq++ });
			return;
		}
		if ((m = /INSERT INTO FUNCTION s3\('mem:\/\/b\/([^']+)', 'Parquet'\)\s+SELECT \* FROM db\.(\w+) WHERE _partition_id = '(\d+)' AND org_id = '([^']+)'/.exec(sql))) {
			const rows = (this.parts.get(m[2]!)?.get(FakeClickHouse.day(m[3]!)) ?? []).filter((r) => r.org_id === m![4]);
			this.objects.set(m[1]!, rows.length - (this.corruptWrites ? 1 : 0));
			return;
		}
		if (/^DROP TABLE/.test(sql.trim())) return;
		throw new Error(`fake ClickHouse: unexpected command ${sql}`);
	}

	async query<T>(sql: string): Promise<T[]> {
		this.check(sql);
		let m: RegExpExecArray | null;
		if ((m = /FROM system\.parts\s+WHERE database = 'db' AND table = '(\w+)'/.exec(sql))) {
			return [...(this.parts.get(m[1]!) ?? new Map<string, Row[]>()).entries()]
				.filter(([, rows]) => rows.length > 0)
				.map(([day, rows]) => ({ partition_id: day.replaceAll("-", ""), rows: String(rows.length) })) as T[];
		}
		if ((m = /FROM db\.runtime_archive_log\s+WHERE table_name = '(\w+)'/.exec(sql))) {
			const latest = new Map<string, (typeof this.log)[number]>();
			for (const e of this.log.filter((e) => e.table_name === m![1])) {
				const key = `${e.day}|${e.generation}`;
				if (!latest.has(key) || latest.get(key)!.seq < e.seq) latest.set(key, e);
			}
			return [...latest.values()].map((e) => ({ day: e.day, generation: String(e.generation), status: e.status, rows: String(e.rows) })) as T[];
		}
		if (/FROM system\.columns/.test(sql)) return [] as T[];
		if (/SELECT engine_full FROM system\.tables/.test(sql)) return [{ engine_full: "MergeTree ORDER BY x" }] as T[];
		if ((m = /SELECT org_id, count\(\) AS rows FROM db\.(\w+) WHERE _partition_id = '(\d+)'/.exec(sql))) {
			const counts = new Map<string, number>();
			for (const r of this.parts.get(m[1]!)?.get(FakeClickHouse.day(m[2]!)) ?? []) counts.set(r.org_id, (counts.get(r.org_id) ?? 0) + 1);
			return [...counts.entries()].sort().map(([org_id, rows]) => ({ org_id, rows: String(rows) })) as T[];
		}
		if ((m = /SELECT count\(\) AS rows FROM s3\('mem:\/\/b\/([^']+)', 'Parquet'\)/.exec(sql))) {
			const rows = this.objects.get(m[1]!);
			if (rows === undefined) throw new Error("NoSuchKey");
			return [{ rows: String(rows) }] as T[];
		}
		throw new Error(`fake ClickHouse: unexpected query ${sql}`);
	}
}

const ARCHIVE: ArchiveConfig = {
	url: "mem://b",
	namedCollection: null,
	accessKeyId: null,
	secretAccessKey: null,
	tables: ["runtime_spans"],
	retentionDays: 365,
	backstopDays: 0,
	overdueWarnDays: 2,
	intervalMinutes: 60,
	maxDaysPerPass: 4,
	scheduler: "auto",
};

const HOT: Record<ArchiveTable, number> = {
	runtime_error_occurrences: 14,
	runtime_spans: 7,
	runtime_llm_calls: 90,
	runtime_logs: 14,
};

function archiver(fake: FakeClickHouse, lease: ArchiveLease = { kind: "local", acquire: async () => true, release: async () => {} }, now = NOW) {
	return new RuntimeArchiver({ db: fake, database: "db", config: ARCHIVE, hotDays: HOT, lease, now: () => now });
}

function archivedRows(fake: FakeClickHouse, day: string): number {
	return [...fake.objects.entries()].filter(([path]) => path.includes(`/date=${day}/`)).reduce((sum, [, n]) => sum + n, 0);
}

test("archive pass: old days go to one object per org, the hot window stays, the log says archived", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3, org_b: 2 });
	fake.add("runtime_spans", "2026-10-31", { org_a: 1 });
	fake.add("runtime_spans", "2026-11-02", { org_a: 5 }); // inside the 7-day hot window
	const result = await archiver(fake).runOnce();
	assert.deepEqual(result.tables[0]?.archivedDays, ["2026-10-30", "2026-10-31"]);
	assert.deepEqual(fake.days("runtime_spans"), ["2026-11-02"]);
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), []);
	assert.equal(archivedRows(fake, "2026-10-30"), 5);
	assert.equal(archivedRows(fake, "2026-10-31"), 1);
	const paths = [...fake.objects.keys()].sort();
	assert.match(paths[0]!, /^runtime_spans\/org=org_a\/date=2026-10-30\/g\d+\.parquet$/);
	assert.equal(paths.length, 3);
	const statuses = fake.log.filter((e) => e.status === "archived").map((e) => [e.day, e.rows]);
	assert.deepEqual(statuses, [
		["2026-10-30", 5],
		["2026-10-31", 1],
	]);
	// A second pass has nothing to do.
	const again = await archiver(fake).runOnce();
	assert.equal(again.tables[0]?.steps, 0);
});

test("archive pass: a failure after the move keeps the staged rows; the next pass resumes with the same objects", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3, org_b: 2 });
	fake.failOnce = /INSERT INTO FUNCTION s3\('mem:\/\/b\/runtime_spans\/org=org_b/;
	const first = await archiver(fake).runOnce();
	assert.match(first.tables[0]?.error ?? "", /injected/);
	// Nothing was dropped: the rows wait in the stage table.
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), ["2026-10-30"]);
	assert.ok(!fake.log.some((e) => e.status === "archived"));
	const generation = fake.log[0]!.generation;
	await archiver(fake).runOnce();
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), []);
	assert.equal(archivedRows(fake, "2026-10-30"), 5);
	// Same generation: the rerun overwrote the first object rather than adding a copy.
	assert.ok([...fake.objects.keys()].every((p) => p.endsWith(`/g${generation}.parquet`)));
	assert.equal(fake.objects.size, 2);
});

test("archive pass: an object that reads back short is never followed by a drop", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3 });
	fake.corruptWrites = true;
	const result = await archiver(fake).runOnce();
	assert.match(result.tables[0]?.error ?? "", /read back 2/);
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), ["2026-10-30"]);
	fake.corruptWrites = false;
	await archiver(fake).runOnce();
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), []);
	assert.equal(archivedRows(fake, "2026-10-30"), 3);
});

test("archive pass: a crash after `archived` was logged only has the drop left", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3 });
	fake.failOnce = /ALTER TABLE db\.runtime_spans_archive_stage DROP PARTITION/;
	await archiver(fake).runOnce();
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), ["2026-10-30"]);
	const writes = fake.statements.filter((s) => s.startsWith("INSERT INTO FUNCTION")).length;
	await archiver(fake).runOnce();
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), []);
	assert.equal(fake.statements.filter((s) => s.startsWith("INSERT INTO FUNCTION")).length, writes, "no second export");
});

test("archive pass: rows that arrive late for an archived day become a second generation", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3 });
	await archiver(fake).runOnce();
	fake.add("runtime_spans", "2026-10-30", { org_a: 2 });
	await archiver(fake, undefined, new Date(NOW.getTime() + 3_600_000)).runOnce();
	assert.equal(fake.objects.size, 2);
	assert.equal(archivedRows(fake, "2026-10-30"), 5);
});

test("archive pass: without the lease nothing is read or changed", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3 });
	const result = await archiver(fake, { kind: "redis", acquire: async () => false, release: async () => {} }).runOnce();
	assert.equal(result.skipped, "lease");
	assert.equal(fake.statements.length, 0);
	assert.deepEqual(fake.days("runtime_spans"), ["2026-10-30"]);
});

test("archive pass: days past the retention are dropped without export and logged expired", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2024-01-01", { org_a: 3 });
	const result = await archiver(fake).runOnce();
	assert.deepEqual(result.tables[0]?.expiredDays, ["2024-01-01"]);
	assert.equal(fake.objects.size, 0);
	assert.equal(fake.log[0]?.status, "expired");
});
