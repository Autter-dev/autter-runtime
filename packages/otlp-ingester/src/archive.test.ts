import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addDays,
	archiveConfigFromEnv,
	archiveObjectPath,
	archivePassOverdue,
	archivePassWarnHours,
	archiveSchedulerMode,
	ArchiveStatusReporter,
	ClickHouseArchiveLock,
	dayFromPartitionId,
	effectiveBackstopDays,
	hotCutoffDay,
	isUnknownTable,
	noTtlWarning,
	overdueDays,
	orgArchiveKey,
	parseTtl,
	parseTtlDays,
	planRetentionTtl,
	planTableArchive,
	reconcileRetentionTtls,
	RuntimeArchiver,
	s3Function,
	type ArchiveConfig,
	type ArchiveDb,
	type ArchiveLease,
	type ArchiveLogEntry,
	type ArchiveRunLock,
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

test("plan: every move takes a new generation, newer than any logged for the day", () => {
	const later = Math.floor(NOW.getTime() / 1000) + 50;
	const steps = plan({
		main: [part("2026-10-01"), part("2026-10-02")],
		log: [
			{ day: "2026-10-01", generation: 42, status: "exporting", rows: 10 },
			{ day: "2026-10-02", generation: later, status: "archived", rows: 10 },
		],
	});
	// `exporting` with nothing staged (the last pass stopped before its move): a new generation, so a
	// move never adds rows to a generation that may already have objects.
	assert.deepEqual(steps[0], { kind: "evict", day: "2026-10-01", generation: Math.floor(NOW.getTime() / 1000) });
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

const ENGINE = {
	spans: "MergeTree PARTITION BY toDate(started_at) ORDER BY (org_id, repository_id, trace_id, started_at) TTL toDateTime(started_at) + toIntervalDay(7) SETTINGS index_granularity = 8192",
	noTtl: "MergeTree PARTITION BY toDate(started_at) ORDER BY (org_id, repository_id, trace_id, started_at) SETTINGS index_granularity = 8192",
	logs: (days: number) =>
		`ReplacingMergeTree PARTITION BY toDate(occurred_at) ORDER BY (org_id, repository_id, occurred_at, event_id) TTL toDateTime(occurred_at) + toIntervalDay(${days}) SETTINGS index_granularity = 8192`,
};

const ttlPlan = (input: Partial<Parameters<typeof planRetentionTtl>[0]>) =>
	planRetentionTtl({
		database: "autter_runtime",
		table: "runtime_spans",
		engineFull: ENGINE.spans,
		hotDays: 7,
		archived: false,
		backstopDays: "auto",
		followHotDays: false,
		oldestDay: null,
		now: NOW,
		...input,
	});

test("TTL parsing: real engine_full strings (MergeTree, ReplacingMergeTree, ReplicatedMergeTree, SharedMergeTree)", () => {
	const cases: Array<[string, string, ReturnType<typeof parseTtlDays>, string[]?]> = [
		["MergeTree, one delete rule", ENGINE.spans, 7],
		["MergeTree, no TTL (a setting named ttl_… is not one)", "MergeTree PARTITION BY toDate(occurred_at) ORDER BY x SETTINGS ttl_only_drop_parts = 0, index_granularity = 8192", null],
		["ReplacingMergeTree", ENGINE.logs(14), 14],
		[
			"ReplicatedMergeTree: a move to a cold volume, then delete",
			"ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') PARTITION BY toDate(occurred_at) ORDER BY (org_id, repository_id, fingerprint, occurred_at) TTL toDateTime(occurred_at) + toIntervalDay(3) TO VOLUME 'cold', toDateTime(occurred_at) + toIntervalDay(180) SETTINGS storage_policy = 'tiered', index_granularity = 8192",
			180,
			["other", "delete"],
		],
		[
			"SharedMergeTree: months plus days",
			"SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') PARTITION BY toDate(started_at) ORDER BY (org_id, repository_id, started_at) TTL toDateTime(started_at) + toIntervalMonth(12) + toIntervalDay(1) SETTINGS index_granularity = 8192",
			361,
		],
		[
			"MergeTree: only a move (no delete rule)",
			"MergeTree PARTITION BY toDate(started_at) ORDER BY (org_id, started_at) TTL toDateTime(started_at) + toIntervalDay(7) TO VOLUME 'cold' SETTINGS storage_policy = 'tiered', index_granularity = 8192",
			null,
			["other"],
		],
		[
			"ReplicatedMergeTree: only recompression (no delete rule)",
			"ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') PARTITION BY toDate(started_at) ORDER BY (org_id, started_at) TTL toDateTime(started_at) + toIntervalDay(7) RECOMPRESS CODEC(ZSTD(17)) SETTINGS index_granularity = 8192",
			null,
			["other"],
		],
		["MergeTree: a move to a disk and weeks", "MergeTree PARTITION BY toDate(started_at) ORDER BY x TTL started_at + toIntervalWeek(2), started_at + toIntervalDay(1) TO DISK 's3'", 14, ["delete", "other"]],
		["years", "MergeTree ORDER BY x TTL toDateTime(started_at) + toIntervalYear(1)", 365],
		["INTERVAL syntax and an explicit DELETE", "MergeTree ORDER BY x TTL toDateTime(started_at) + INTERVAL 30 DAY DELETE", 30],
		["INTERVAL months", "MergeTree ORDER BY x TTL started_at + INTERVAL 2 MONTH + INTERVAL 3 DAY", 63],
		["a conditional delete is not understood", "MergeTree ORDER BY x TTL toDateTime(started_at) + toIntervalDay(30) WHERE status = 'ok'", "unrecognised"],
		["hours are not understood", "MergeTree ORDER BY x TTL toDateTime(started_at) + toIntervalHour(36)", "unrecognised"],
		["an expression is not understood", "MergeTree ORDER BY x TTL if(a, toDateTime(b), toDateTime(c)) + toIntervalDay(3)", "unrecognised"],
		["two delete rules are not understood", "MergeTree ORDER BY x TTL started_at + toIntervalDay(3), started_at + toIntervalDay(9)", "unrecognised"],
		["GROUP BY rule kept as another rule", "MergeTree ORDER BY (org_id, started_at) TTL toDateTime(started_at) + toIntervalDay(30) GROUP BY org_id SET duration_ms = max(duration_ms), toDateTime(started_at) + toIntervalDay(90)", 90, ["other", "delete"]],
		["a quoted comma or TTL inside a string is not a separator", "MergeTree ORDER BY x TTL toDateTime(started_at) + toIntervalDay(7) TO VOLUME 'a, TTL b', toDateTime(started_at) + toIntervalDay(40)", 40, ["other", "delete"]],
	];
	for (const [name, engine, days, kinds] of cases) {
		assert.equal(parseTtlDays(engine), days, name);
		if (kinds) {
			const parsed = parseTtl(engine);
			assert.equal(parsed.kind, "rules", name);
			if (parsed.kind === "rules") assert.deepEqual(parsed.rules.map((r) => r.kind), kinds, name);
		}
	}
});

test("TTL: a move or recompress rule alone never gets a delete rule added without an archive (it is warned about, rules kept)", () => {
	const moveOnly = "MergeTree PARTITION BY toDate(started_at) ORDER BY x TTL toDateTime(started_at) + toIntervalDay(7) TO VOLUME 'cold' SETTINGS index_granularity = 8192";
	const result = ttlPlan({ engineFull: moveOnly });
	assert.equal(result.action, "none");
	assert.match(
		(result as { warning: string }).warning,
		/MODIFY TTL toDateTime\(started_at\) \+ toIntervalDay\(7\) TO VOLUME 'cold', toDateTime\(started_at\) \+ INTERVAL 7 DAY$/,
	);
});

test("TTL: changing the delete rule keeps move and recompress rules (MODIFY TTL replaces the list); backstop 0 removes only the delete rule", () => {
	const tiered =
		"ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') PARTITION BY toDate(started_at) ORDER BY x TTL toDateTime(started_at) + toIntervalDay(3) TO VOLUME 'cold', toDateTime(started_at) + toIntervalDay(10) SETTINGS index_granularity = 8192";
	assert.deepEqual(ttlPlan({ engineFull: tiered, archived: true }), {
		action: "alter",
		sql: "ALTER TABLE autter_runtime.runtime_spans MODIFY TTL toDateTime(started_at) + toIntervalDay(3) TO VOLUME 'cold', toDateTime(started_at) + INTERVAL 14 DAY",
		message: "runtime_spans delete TTL changed from 10 to 14 days",
	});
	const removed = ttlPlan({ engineFull: tiered, archived: true, backstopDays: 0 });
	assert.equal(removed.action, "alter");
	assert.equal((removed as { sql: string }).sql, "ALTER TABLE autter_runtime.runtime_spans MODIFY TTL toDateTime(started_at) + toIntervalDay(3) TO VOLUME 'cold'");
	// No other rule: REMOVE TTL.
	assert.equal((ttlPlan({ archived: true, backstopDays: 0 }) as { sql: string }).sql, "ALTER TABLE autter_runtime.runtime_spans REMOVE TTL");
	// Already as wanted / unrecognised: nothing.
	assert.deepEqual(ttlPlan({ engineFull: ENGINE.noTtl, archived: true, backstopDays: 0 }), { action: "none" });
	const odd = ttlPlan({ engineFull: "MergeTree ORDER BY x TTL toDateTime(started_at) + toIntervalHour(36)", archived: true });
	assert.equal(odd.action, "none");
	assert.match((odd as { warning: string }).warning, /not recognised/);
});

test("TTL without an archive: a table that has no TTL never gets one, and other tables keep theirs", () => {
	for (const hotDays of [7, 14, 90]) {
		for (const followHotDays of [false, true]) {
			for (const backstopDays of [0, 30, "auto"] as const) {
				const result = ttlPlan({ engineFull: ENGINE.noTtl, hotDays, followHotDays, backstopDays });
				assert.equal(result.action, "none", `hotDays ${hotDays}, follow ${followHotDays}, backstop ${backstopDays}`);
			}
		}
	}
	assert.deepEqual(ttlPlan({ hotDays: 14 }), { action: "none" });
	const warning = noTtlWarning({ db: "autter_runtime", table: "runtime_spans", hotDays: 7 });
	assert.match(warning, /runtime_spans has no delete TTL/);
	assert.match(warning, /ARCHIVE_BACKSTOP_DAYS=0/);
	assert.match(warning, /ALTER TABLE autter_runtime\.runtime_spans MODIFY TTL toDateTime\(started_at\) \+ INTERVAL 7 DAY$/);
	assert.match(noTtlWarning({ db: "autter_runtime", table: "runtime_logs", hotDays: 14 }), /MODIFY TTL toDateTime\(occurred_at\) \+ INTERVAL 14 DAY$/);
});

test("D3: turning the archive on never deletes a day before it is archived (no TTL, or a longer one)", () => {
	// Spans, hot window 7 → backstop 14: the first day the backstop keeps whole is 2026-10-27.
	const base = { archived: true, backstopDays: "auto" as const, hotDays: 7 };
	// A table with no TTL and a year of rows: the backstop waits until the job has archived them.
	const waiting = ttlPlan({ ...base, engineFull: ENGINE.noTtl, oldestDay: "2025-11-20" });
	assert.equal(waiting.action, "wait");
	assert.match((waiting as { warning: string }).warning, /until every day before 2026-10-27 is archived \(the oldest in the table is 2025-11-20\)/);
	// A 90-day TTL is not cut to 14 while older days are still in the table.
	const ninety = ENGINE.spans.replace("toIntervalDay(7)", "toIntervalDay(90)");
	assert.equal(ttlPlan({ ...base, engineFull: ninety, oldestDay: "2026-08-20" }).action, "wait");
	assert.equal(ttlPlan({ ...base, engineFull: ninety, oldestDay: "2026-10-26" }).action, "wait");
	// Once the oldest day left is inside the backstop (the job archived the rest): set.
	for (const oldestDay of ["2026-10-27", "2026-11-01", null]) {
		const ready = ttlPlan({ ...base, engineFull: ninety, oldestDay });
		assert.equal(ready.action, "alter", String(oldestDay));
		assert.equal((ready as { sql: string }).sql, "ALTER TABLE autter_runtime.runtime_spans MODIFY TTL toDateTime(started_at) + INTERVAL 14 DAY");
	}
	assert.equal(ttlPlan({ ...base, engineFull: ENGINE.noTtl, oldestDay: "2026-11-02" }).action, "alter");
	// Lengthening (the hot-window TTL out to the backstop) deletes nothing: at once, whatever is in the table.
	assert.deepEqual(ttlPlan({ ...base, oldestDay: "2020-01-01" }), {
		action: "alter",
		sql: "ALTER TABLE autter_runtime.runtime_spans MODIFY TTL toDateTime(started_at) + INTERVAL 14 DAY",
		message: "runtime_spans delete TTL changed from 7 to 14 days",
	});
	assert.equal(effectiveBackstopDays(0, 7), null);
	assert.equal(effectiveBackstopDays(90, 7), 90);
	assert.equal(effectiveBackstopDays(10, 14), 21);
});

test("backstop TTL is on by default: each table's hot window + 7 days; 0 turns it off", () => {
	assert.equal(effectiveBackstopDays("auto", 14), 21);
	const url = "https://bucket.s3.us-east-1.amazonaws.com/runtime";
	assert.equal(archiveConfigFromEnv({ ARCHIVE_S3_URL: url, ARCHIVE_BACKSTOP_DAYS: "auto" })?.backstopDays, "auto");
	assert.equal(archiveConfigFromEnv({ ARCHIVE_S3_URL: url, ARCHIVE_BACKSTOP_DAYS: "0" })?.backstopDays, 0);
	assert.equal(archiveConfigFromEnv({ ARCHIVE_S3_URL: url, ARCHIVE_BACKSTOP_DAYS: "60" })?.backstopDays, 60);
	assert.throws(() => archiveConfigFromEnv({ ARCHIVE_S3_URL: url, ARCHIVE_BACKSTOP_DAYS: "soon" }), /ARCHIVE_BACKSTOP_DAYS/);
});

test("runtime_logs: LOG_TTL_DAYS is applied only when set; a shorter one only when no older rows would be deleted", () => {
	const logs = { table: "runtime_logs" as const, engineFull: ENGINE.logs(90), hotDays: 14 };
	// Unset (followHotDays false): an operator's 90 days stay.
	assert.deepEqual(ttlPlan({ ...logs, followHotDays: false, oldestDay: "2026-08-15" }), { action: "none" });
	// Set longer: at once.
	assert.equal(ttlPlan({ ...logs, engineFull: ENGINE.logs(14), hotDays: 30, followHotDays: true, oldestDay: "2026-10-27" }).action, "alter");
	// Set shorter with older rows in the table: not shortened, the statement is given.
	const shorter = ttlPlan({ ...logs, followHotDays: true, oldestDay: "2026-08-15" });
	assert.equal(shorter.action, "wait");
	assert.match(
		(shorter as { warning: string }).warning,
		/LOG_TTL_DAYS=14 is shorter than its 90-day delete TTL[^]*run: ALTER TABLE autter_runtime\.runtime_logs MODIFY TTL toDateTime\(occurred_at\) \+ INTERVAL 14 DAY SETTINGS materialize_ttl_after_modify = 0$/,
	);
	// Set shorter, nothing older than it: shortened.
	assert.equal(ttlPlan({ ...logs, followHotDays: true, oldestDay: "2026-10-28" }).action, "alter");
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
	/** Unique per inserted row, so tests can tell a lost or duplicated row. */
	id: number;
}

let nextRowId = 1;

/**
 * Just enough of ClickHouse (system.parts, MOVE/DROP PARTITION, the log, the
 * lock table, s3()) for the archive job's statements. Objects keep the rows
 * they were written with; like ClickHouse, an INSERT into an s3() object that
 * exists fails unless s3_truncate_on_insert = 1.
 */
class FakeClickHouse implements ArchiveDb {
	parts = new Map<string, Map<string, Row[]>>();
	log: Array<{ table_name: string; day: string; generation: number; status: string; rows: number; seq: number }> = [];
	objects = new Map<string, Row[]>();
	statements: string[] = [];
	/** Settings passed with each TTL ALTER. */
	ttlSettings: Array<Record<string, unknown> | undefined> = [];
	/** Tables created by CREATE TABLE … COMMENT (the archive lock), by name. */
	tables = new Map<string, { comment: string; createdAt: number; beats: number[] }>();
	passes: Array<{ kind: string; ok: number; at: number }> = [];
	/** engine_full per table (system.tables); a table not listed has no TTL. */
	engines: Record<string, string> = {};
	/** Seconds on the fake server clock (lock heartbeats). */
	clock = 0;
	/** Throw on the first statement matching this (crash injection). */
	failOnce: RegExp | null = null;
	/** Rows the bucket "loses" on write (read-back check). */
	corruptWrites = false;
	private seq = 0;

	add(table: string, day: string, orgs: Record<string, number>): Row[] {
		const days = this.parts.get(table) ?? new Map<string, Row[]>();
		const rows = days.get(day) ?? [];
		const added: Row[] = [];
		for (const [org, n] of Object.entries(orgs)) for (let i = 0; i < n; i++) added.push({ org_id: org, id: nextRowId++ });
		rows.push(...added);
		days.set(day, rows);
		this.parts.set(table, days);
		return added;
	}

	days(table: string): string[] {
		return [...(this.parts.get(table)?.entries() ?? [])].filter(([, rows]) => rows.length > 0).map(([day]) => day).sort();
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

	async command(sql: string, settings?: Record<string, unknown>): Promise<void> {
		this.check(sql);
		if (/ TTL/.test(sql) && /^ALTER/.test(sql.trim())) this.ttlSettings.push(settings);
		let m: RegExpExecArray | null;
		const trimmed = sql.trim();
		if (/^CREATE TABLE IF NOT EXISTS db\.runtime_archive_(log|passes)\b/.test(trimmed)) return;
		if ((m = /^CREATE TABLE db\.(runtime_archive_lock)\b[^]*COMMENT '([^']*)'$/.exec(trimmed))) {
			if (this.tables.has(m[1]!)) throw new Error(`Code: 57. DB::Exception: Table db.${m[1]} already exists. (TABLE_ALREADY_EXISTS)`);
			this.tables.set(m[1]!, { comment: m[2]!, createdAt: this.clock, beats: [] });
			return;
		}
		if ((m = /^INSERT INTO db\.(runtime_archive_lock) \(token\) VALUES \('([^']*)'\)$/.exec(trimmed))) {
			const lock = this.tables.get(m[1]!);
			if (!lock) throw new Error(`Code: 60. DB::Exception: Table db.${m[1]} does not exist. (UNKNOWN_TABLE)`);
			lock.beats.push(this.clock);
			return;
		}
		if ((m = /^DROP TABLE IF EXISTS db\.(runtime_archive_lock)/.exec(trimmed))) {
			this.tables.delete(m[1]!);
			return;
		}
		if ((m = /^INSERT INTO db\.runtime_archive_passes \(kind, (?:instance, )?(ok, )?[^)]*\) VALUES \('(\w+)', (?:'[^']*', )?(\d)?/.exec(trimmed))) {
			this.passes.push({ kind: m[2]!, ok: m[1] ? Number(m[3]) : 0, at: this.clock });
			return;
		}
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
		if ((m = /INSERT INTO FUNCTION s3\('mem:\/\/b\/([^']+)', 'Parquet'\)\s+SELECT \* FROM db\.(\w+)(?: FINAL)? WHERE _partition_id = '(\d+)' AND org_id = '([^']+)'/.exec(sql))) {
			if (this.objects.has(m[1]!) && !/s3_truncate_on_insert = 1/.test(sql)) {
				throw new Error(`Code: 36. DB::Exception: Object in bucket b with key ${m[1]} already exists. If you want to overwrite it, enable setting s3_truncate_on_insert. (BAD_ARGUMENTS)`);
			}
			const rows = (this.parts.get(m[2]!)?.get(FakeClickHouse.day(m[3]!)) ?? []).filter((r) => r.org_id === m![4]);
			this.objects.set(m[1]!, this.corruptWrites ? rows.slice(1) : [...rows]);
			return;
		}
		if (/^DROP TABLE/.test(trimmed)) return;
		if ((m = /^ALTER TABLE db\.(\w+) (REMOVE TTL|MODIFY TTL (.*))$/.exec(trimmed))) {
			const base = (this.engines[m[1]!] ?? "MergeTree ORDER BY x").replace(/ TTL .*$/, "");
			this.engines[m[1]!] = m[3] ? `${base} TTL ${m[3]}` : base;
			return;
		}
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
		if ((m = /FROM db\.runtime_archive_log\s+WHERE table_name = '(\w+)'(?: AND day = '([\d-]+)')?/.exec(sql))) {
			const latest = new Map<string, (typeof this.log)[number]>();
			for (const e of this.log.filter((e) => e.table_name === m![1] && (!m![2] || e.day === m![2]))) {
				const key = `${e.day}|${e.generation}`;
				if (!latest.has(key) || latest.get(key)!.seq < e.seq) latest.set(key, e);
			}
			return [...latest.values()].map((e) => ({ day: e.day, generation: String(e.generation), status: e.status, rows: String(e.rows) })) as T[];
		}
		if ((m = /SELECT comment AS holder[^]*FROM system\.tables\s+WHERE database = 'db' AND name = '(\w+)'/.exec(sql))) {
			const lock = this.tables.get(m[1]!);
			if (!lock) return [] as T[];
			const last = lock.beats.length ? Math.max(...lock.beats) : lock.createdAt;
			return [{ holder: lock.comment, idle_seconds: String(this.clock - last) }] as T[];
		}
		if ((m = /SELECT table, partition_id, sum\(rows\) AS rows FROM system\.parts\s+WHERE database = 'db' AND active AND table IN \(([^)]*)\)/.exec(sql))) {
			const names = m[1]!.split(",").map((n) => n.trim().replace(/'/g, ""));
			return names.flatMap((table) =>
				[...(this.parts.get(table) ?? new Map<string, Row[]>()).entries()]
					.filter(([, rows]) => rows.length > 0)
					.map(([day, rows]) => ({ table, partition_id: day.replaceAll("-", ""), rows: String(rows.length) })),
			) as T[];
		}
		if (/FROM system\.columns/.test(sql)) return [] as T[];
		if ((m = /SELECT (?:name, )?engine_full FROM system\.tables WHERE database = 'db' AND name (?:= '(\w+)'|IN \(([^)]*)\))/.exec(sql))) {
			const names = m[1] ? [m[1]] : m[2]!.split(",").map((n) => n.trim().replace(/'/g, ""));
			return names.map((name) => ({ name, engine_full: this.engines[name] ?? "MergeTree ORDER BY x" })) as T[];
		}
		if (/FROM db\.runtime_archive_passes/.test(sql)) {
			const ms = (at: number | undefined) => (at === undefined ? 0 : at * 1000);
			const max = (rows: Array<{ at: number }>) => (rows.length ? Math.max(...rows.map((r) => r.at)) : undefined);
			const configured = this.passes.filter((p) => p.kind === "configured");
			return [
				{
					last_ok_ms: String(ms(max(this.passes.filter((p) => p.kind === "pass" && p.ok === 1)))),
					last_ms: String(ms(max(this.passes.filter((p) => p.kind === "pass")))),
					first_configured_ms: String(configured.length ? ms(Math.min(...configured.map((p) => p.at))) : 0),
					now_ms: String(this.clock * 1000),
				},
			] as T[];
		}
		if ((m = /SELECT org_id, count\(\) AS rows FROM db\.(\w+)(?: FINAL)? WHERE _partition_id = '(\d+)'/.exec(sql))) {
			const counts = new Map<string, number>();
			for (const r of this.parts.get(m[1]!)?.get(FakeClickHouse.day(m[2]!)) ?? []) counts.set(r.org_id, (counts.get(r.org_id) ?? 0) + 1);
			return [...counts.entries()].sort().map(([org_id, rows]) => ({ org_id, rows: String(rows) })) as T[];
		}
		if ((m = /SELECT count\(\) AS rows FROM s3\('mem:\/\/b\/([^']+)', 'Parquet'\)/.exec(sql))) {
			const rows = this.objects.get(m[1]!);
			if (rows === undefined) throw new Error("NoSuchKey");
			return [{ rows: String(rows.length) }] as T[];
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

function archiver(fake: FakeClickHouse, lease: ArchiveLease = { kind: "local", acquire: async () => true, release: async () => {} }, now = NOW, config = ARCHIVE) {
	return new RuntimeArchiver({ db: fake, database: "db", config, hotDays: HOT, lease, now: () => now, generationOffset: 0 });
}

function archivedRows(fake: FakeClickHouse, day: string): number {
	return [...fake.objects.entries()].filter(([path]) => path.includes(`/date=${day}/`)).reduce((sum, [, rows]) => sum + rows.length, 0);
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

// ── Two runners at once (D1) ───────────────────────────────────────────────

/** An ArchiveDb over a shared fake that stops before its `pauseAt`-th call until released. */
class GatedDb implements ArchiveDb {
	calls = 0;
	private resume: (() => void) | null = null;
	readonly paused: Promise<void>;
	private onPaused!: () => void;
	constructor(
		private readonly fake: FakeClickHouse,
		private pauseAt = Number.POSITIVE_INFINITY,
	) {
		this.paused = new Promise((resolve) => (this.onPaused = resolve));
	}
	private async gate(): Promise<void> {
		if (this.calls++ !== this.pauseAt) return;
		await new Promise<void>((resolve) => {
			this.resume = resolve;
			this.onPaused();
		});
	}
	release(): void {
		this.pauseAt = Number.POSITIVE_INFINITY;
		this.resume?.();
		this.resume = null;
	}
	async query<T>(sql: string): Promise<T[]> {
		await this.gate();
		return this.fake.query<T>(sql);
	}
	async command(sql: string, settings?: Record<string, unknown>): Promise<void> {
		await this.gate();
		return this.fake.command(sql, settings);
	}
}

const ALWAYS: ArchiveLease = { kind: "redis", acquire: async () => true, release: async () => {} };

/** A lock that always says yes: what two runners would do with no lock at all. */
const NO_LOCK: ArchiveRunLock = { hold: async () => true, release: async () => {} };

function runnerOn(db: ArchiveDb, now = NOW, lock?: ArchiveRunLock, generationOffset?: number) {
	return new RuntimeArchiver({ db, database: "db", config: ARCHIVE, hotDays: HOT, lease: ALWAYS, now: () => now, lock, generationOffset });
}

/** Days whose log has an `archived` generation with rows: the backend reads every g*.parquet object of those days. */
function readableDays(fake: FakeClickHouse): Set<string> {
	const latest = new Map<string, (typeof fake.log)[number]>();
	for (const e of fake.log) {
		const key = `${e.table_name}|${e.day}|${e.generation}`;
		if (!latest.has(key) || latest.get(key)!.seq < e.seq) latest.set(key, e);
	}
	return new Set([...latest.values()].filter((e) => e.status === "archived" && e.rows > 0).map((e) => e.day));
}

/** Where each row id is: the hot table, the stage table, or a readable archive object. */
function rowLocations(fake: FakeClickHouse): Map<number, string[]> {
	const where = new Map<number, string[]>();
	const put = (id: number, at: string) => where.set(id, [...(where.get(id) ?? []), at]);
	for (const [table, days] of fake.parts) for (const [day, rows] of days) for (const r of rows) put(r.id, `${table}:${day}`);
	const readable = readableDays(fake);
	for (const [path, rows] of fake.objects) {
		const day = /date=([\d-]+)/.exec(path)![1]!;
		if (readable.has(day)) for (const r of rows) put(r.id, path);
	}
	return where;
}

/**
 * Two archive runners on one ClickHouse (a lost Redis lease, or
 * ARCHIVE_SCHEDULER=on on two replicas), interleaved at every pair of
 * statements: A runs `a` statements, B runs `b`, then A finishes, then B.
 * A third pass then finishes whatever is left. Every row must end up exactly
 * once in the table or in a readable archive object.
 */
async function interleave(a: number, b: number, lock?: ArchiveRunLock): Promise<{ lost: number[]; duplicated: number[]; fake: FakeClickHouse }> {
	const fake = new FakeClickHouse();
	const ids = [
		...fake.add("runtime_spans", "2026-10-30", { org_a: 3, org_b: 2 }),
		...fake.add("runtime_spans", "2026-10-31", { org_a: 1 }),
	].map((r) => r.id);
	const dbA = new GatedDb(fake, a);
	const dbB = new GatedDb(fake, b);
	const passA = runnerOn(dbA, NOW, lock, 11).runOnce();
	await Promise.race([dbA.paused, passA]);
	const passB = runnerOn(dbB, NOW, lock, 22).runOnce();
	await Promise.race([dbB.paused, passB]);
	dbA.release();
	await passA;
	dbB.release();
	await passB;
	for (let i = 0; i < 3; i++) await runnerOn(fake, new Date(NOW.getTime() + (i + 1) * 3_600_000)).runOnce();
	const where = rowLocations(fake);
	return {
		lost: ids.filter((id) => !where.has(id)),
		duplicated: ids.filter((id) => (where.get(id)?.length ?? 0) > 1),
		fake,
	};
}

test("D1: two runners interleaved at every step never lose or duplicate a row", async () => {
	// How many statements one pass makes on its own.
	const solo = new GatedDb(new FakeClickHouse());
	(solo as unknown as { fake: FakeClickHouse }).fake.add("runtime_spans", "2026-10-30", { org_a: 3, org_b: 2 });
	(solo as unknown as { fake: FakeClickHouse }).fake.add("runtime_spans", "2026-10-31", { org_a: 1 });
	await runnerOn(solo).runOnce();
	const steps = solo.calls + 1;
	const failures: string[] = [];
	for (let a = 0; a <= steps; a++) {
		for (let b = 0; b <= steps; b++) {
			const { lost, duplicated } = await interleave(a, b);
			if (lost.length || duplicated.length) failures.push(`A@${a} B@${b}: lost ${lost.join(",") || "none"}, duplicated ${duplicated.join(",") || "none"}`);
		}
	}
	assert.deepEqual(failures.slice(0, 5), [], `${failures.length} interleavings failed`);
});

test("D1 without the ClickHouse lock: an archived generation's objects are never replaced and no row is dropped unarchived", async () => {
	const solo = new GatedDb(new FakeClickHouse());
	(solo as unknown as { fake: FakeClickHouse }).fake.add("runtime_spans", "2026-10-30", { org_a: 3, org_b: 2 });
	(solo as unknown as { fake: FakeClickHouse }).fake.add("runtime_spans", "2026-10-31", { org_a: 1 });
	await runnerOn(solo, NOW, NO_LOCK).runOnce();
	const steps = solo.calls + 1;
	const lost: string[] = [];
	let duplicated = 0;
	for (let a = 0; a <= steps; a++) {
		for (let b = 0; b <= steps; b++) {
			const result = await interleave(a, b, NO_LOCK);
			if (result.lost.length) lost.push(`A@${a} B@${b}: lost ${result.lost.join(",")}`);
			if (result.duplicated.length) duplicated++;
		}
	}
	assert.deepEqual(lost.slice(0, 5), [], `${lost.length} interleavings lost rows`);
	console.log(`without the lock: ${duplicated} of ${(steps + 1) ** 2} interleavings archived a row twice (the lock is what prevents that)`);
});


test("D1: a second runner backs off while the ClickHouse lock is held, and takes over a lock idle past ARCHIVE_LOCK_STALE_SECONDS", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3 });
	const held = new ClickHouseArchiveLock(fake, "db", "other-runner");
	assert.equal(await held.hold(), true);
	assert.equal(await new ClickHouseArchiveLock(fake, "db", "third").hold(), false, "one holder at a time");
	const skipped = await archiver(fake).runOnce();
	assert.equal(skipped.skipped, "lock");
	assert.deepEqual(fake.days("runtime_spans"), ["2026-10-30"], "nothing moved");
	assert.equal(fake.objects.size, 0);
	// The holder died: after two idle hours the lock is taken over.
	fake.clock += 2 * 3600;
	const result = await archiver(fake).runOnce();
	assert.deepEqual(result.tables[0]?.archivedDays, ["2026-10-30"]);
	assert.equal(fake.tables.has("runtime_archive_lock"), false, "released after the pass");
	// The old holder no longer holds it.
	assert.equal(await held.hold(), true, "free again: a new hold creates it");
});

test("D1: a runner that loses the lock mid-pass makes no change past the statement it had already fenced", async () => {
	const changes = /^\s*(ALTER TABLE|INSERT INTO FUNCTION|INSERT INTO db\.runtime_archive_log\b|DROP TABLE)/;
	for (let k = 3; k < 40; k++) {
		const fake = new FakeClickHouse();
		fake.add("runtime_spans", "2026-10-30", { org_a: 3, org_b: 2 });
		const db = new GatedDb(fake, k);
		const pass = runnerOn(db, NOW, undefined, 0).runOnce();
		await Promise.race([db.paused, pass]);
		// Another runner takes the lock over (the first looked dead for two hours).
		fake.clock += 2 * 3600;
		const thief = new ClickHouseArchiveLock(fake, "db", "thief");
		if (!(await thief.hold())) continue;
		const before = fake.statements.length;
		db.release();
		await pass;
		const after = fake.statements.slice(before);
		// Only the statement it was paused at (already past its fence) may run; nothing after it.
		assert.ok(!after.slice(1).some((sql) => changes.test(sql)), `paused at ${k}:\n${after.join("\n")}`);
		assert.equal(fake.tables.get("runtime_archive_lock")?.comment, "thief", "the loser does not release the new holder's lock");
	}
});

test("D1: an archived generation's objects are re-read before the stage is dropped, and never rewritten", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3 });
	fake.failOnce = /ALTER TABLE db\.runtime_spans_archive_stage DROP PARTITION/;
	await archiver(fake).runOnce();
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), ["2026-10-30"]);
	// Something empties the archived object before the drop is retried.
	const [path] = [...fake.objects.keys()];
	fake.objects.set(path!, []);
	const writes = fake.statements.filter((sql) => sql.startsWith("INSERT INTO FUNCTION")).length;
	const result = await archiver(fake).runOnce();
	assert.match(result.tables[0]?.error ?? "", /reads back 0 rows, the stage holds 3; the staged partition is kept/);
	assert.deepEqual(fake.days("runtime_spans_archive_stage"), ["2026-10-30"], "not dropped");
	assert.equal(fake.statements.filter((sql) => sql.startsWith("INSERT INTO FUNCTION")).length, writes, "the archived object is not rewritten");
});

test("objects are written once: no INSERT replaces an object unless its generation is not archived and it read back short", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3 });
	await archiver(fake).runOnce();
	const inserts = fake.statements.filter((sql) => sql.startsWith("INSERT INTO FUNCTION"));
	assert.equal(inserts.length, 1);
	assert.match(inserts[0]!, /s3_truncate_on_insert = 0, s3_create_new_file_on_insert = 0/);
});

test("D3: with an archive turned on over a table with no TTL and old rows, the backstop is set only after the job archived them", async () => {
	const fake = new FakeClickHouse();
	fake.engines.runtime_spans = ENGINE.noTtl;
	// 10 old days (2026-10-20 … 2026-10-29): spans hot window 7, backstop 14 keeps 2026-10-27 onwards.
	for (let i = 0; i < 10; i++) fake.add("runtime_spans", addDays("2026-10-20", i), { org_a: 1 });
	const config = { ...ARCHIVE, backstopDays: "auto" as const, maxDaysPerPass: 4 };
	const ttlAlters = () => fake.statements.filter((sql) => /ALTER TABLE db\.runtime_spans (MODIFY|REMOVE) TTL/.test(sql));
	// Boot: nothing set, the table still has days older than the backstop.
	const boot = await reconcileRetentionTtls({ db: fake, database: "db", archive: config, hotDays: HOT, logTtlExplicit: false, now: NOW });
	assert.equal(boot.find((r) => r.table === "runtime_spans")?.plan.action, "wait");
	await archiver(fake, undefined, NOW, config).runOnce();
	assert.deepEqual(ttlAlters(), [], "2026-10-20 … 23 archived, 24 … 26 still older than the backstop: waiting");
	await archiver(fake, undefined, new Date(NOW.getTime() + 3_600_000), config).runOnce();
	// Every day before 2026-10-27 is archived now: the backstop is set after this pass.
	assert.deepEqual(fake.days("runtime_spans"), ["2026-10-28", "2026-10-29"]);
	assert.deepEqual(ttlAlters().map((sql) => sql.trim()), ["ALTER TABLE db.runtime_spans MODIFY TTL toDateTime(started_at) + INTERVAL 14 DAY"]);
	await archiver(fake, undefined, new Date(NOW.getTime() + 7_200_000), config).runOnce();
	assert.deepEqual(fake.days("runtime_spans"), [], "every old day archived");
	assert.equal(ttlAlters().length, 1, "set once");
	assert.ok(fake.ttlSettings.length === 1 && fake.ttlSettings[0]?.materialize_ttl_after_modify === 0, "MODIFY TTL runs with materialize_ttl_after_modify = 0");
});

test("pass records: each finished pass is recorded, ok only without a failed table", async () => {
	const fake = new FakeClickHouse();
	fake.add("runtime_spans", "2026-10-30", { org_a: 3 });
	fake.failOnce = /INSERT INTO FUNCTION/;
	await archiver(fake).runOnce();
	await archiver(fake).runOnce();
	assert.deepEqual(fake.passes.map((p) => [p.kind, p.ok]), [["pass", 0], ["pass", 1]]);
	// A pass skipped for the lease records nothing.
	await archiver(fake, { kind: "redis", acquire: async () => false, release: async () => {} }).runOnce();
	assert.equal(fake.passes.length, 2);
});

test("archive configured but no pass: overdue after three intervals (at least 3 hours) from the last pass or from configuration", () => {
	const hour = 3_600_000;
	assert.equal(archivePassWarnHours(60), 3);
	assert.equal(archivePassWarnHours(5), 3);
	assert.equal(archivePassWarnHours(240), 12);
	const at = (h: number) => Date.UTC(2026, 10, 12) + h * hour;
	assert.equal(archivePassOverdue({ nowMs: at(2), lastOkPassMs: null, firstConfiguredMs: at(0), intervalMinutes: 60 }).overdue, false, "a new archive gets its grace");
	assert.equal(archivePassOverdue({ nowMs: at(4), lastOkPassMs: null, firstConfiguredMs: at(0), intervalMinutes: 60 }).overdue, true, "never ran");
	assert.equal(archivePassOverdue({ nowMs: at(30), lastOkPassMs: at(28), firstConfiguredMs: at(0), intervalMinutes: 60 }).overdue, false);
	assert.equal(archivePassOverdue({ nowMs: at(30), lastOkPassMs: at(26), firstConfiguredMs: at(0), intervalMinutes: 60 }).overdue, true, "stopped");
	assert.equal(archivePassOverdue({ nowMs: at(30), lastOkPassMs: null, firstConfiguredMs: null, intervalMinutes: 60 }).overdue, false, "nothing recorded");
});

test("status reporter: every process records the archive as configured, warns and reports when no pass succeeded", async () => {
	const fake = new FakeClickHouse();
	fake.clock = 1_000_000;
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
	try {
		const reporter = new ArchiveStatusReporter({ db: fake, database: "db", config: ARCHIVE, runsJob: false, now: () => new Date(fake.clock * 1000) });
		let status = await reporter.report();
		assert.equal(fake.passes[0]?.kind, "configured");
		assert.deepEqual({ ...status, checkedAt: null }, {
			configured: true,
			runsJob: false,
			lastPassAt: null,
			lastSuccessfulPassAt: null,
			passOverdue: false,
			passWarnHours: 3,
			checkedAt: null,
		});
		// Four hours on, still no pass anywhere: overdue, warned.
		fake.clock += 4 * 3600;
		status = await reporter.report();
		assert.equal(status.passOverdue, true);
		assert.ok(warnings.some((w) => /an archive is configured but no archive pass has finished without errors since it was configured/.test(w)), warnings.join("\n"));
		// A pass by any process clears it.
		fake.passes.push({ kind: "pass", ok: 1, at: fake.clock });
		status = await reporter.report();
		assert.equal(status.passOverdue, false);
		assert.equal(status.lastSuccessfulPassAt, new Date(fake.clock * 1000).toISOString());
		assert.deepEqual(reporter.snapshot(), status);
	} finally {
		console.warn = warn;
	}
});

test("archive turned off with rows still staged: they are reported with the statement that moves them back", async () => {
	const fake = new FakeClickHouse();
	fake.engines.runtime_spans = ENGINE.spans;
	fake.add("runtime_spans_archive_stage", "2026-10-30", { org_a: 3 });
	const warnings: string[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
	try {
		await reconcileRetentionTtls({ db: fake, database: "db", archive: null, hotDays: HOT, logTtlExplicit: false, now: NOW, tables: ["runtime_spans"] });
	} finally {
		console.warn = warn;
	}
	assert.ok(
		warnings.some((w) => w.includes("runtime_spans_archive_stage holds 3 rows of 1 day(s) (2026-10-30)") && w.endsWith("ALTER TABLE db.runtime_spans_archive_stage MOVE PARTITION ID '20261030' TO TABLE db.runtime_spans")),
		warnings.join("\n"),
	);
});

test("the lock reads a missing lock table as free, however ClickHouse words it", async () => {
	// @clickhouse/client: the code and type are properties; the message is ClickHouse's text.
	const real = Object.assign(new Error("Unknown table expression identifier 'db.runtime_archive_lock' in scope (SELECT toDateTime(max(at)) FROM db.runtime_archive_lock)."), {
		code: "60",
		type: "UNKNOWN_TABLE",
	});
	assert.equal(isUnknownTable(real), true);
	assert.equal(isUnknownTable(Object.assign(new Error("boom"), { code: "60" })), true);
	assert.equal(isUnknownTable(new Error("Code: 241. Memory limit exceeded")), false);
	const created: string[] = [];
	const db: ArchiveDb = {
		query: async (sql) => {
			if (/runtime_archive_lock/.test(sql)) throw real;
			return [];
		},
		command: async (sql) => void created.push(sql),
	};
	assert.equal(await new ClickHouseArchiveLock(db, "db", "me").hold(), true);
	assert.match(created[0]!, /^CREATE TABLE db\.runtime_archive_lock /);
});
