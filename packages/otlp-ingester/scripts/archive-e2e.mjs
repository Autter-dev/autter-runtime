#!/usr/bin/env node
/**
 * End-to-end check of tiered retention (src/archive.ts) against a real
 * ClickHouse and a real S3-compatible bucket (MinIO in CI). Skips (exit 0)
 * unless ARCHIVE_E2E_S3_URL is set: the URL as ClickHouse reaches the bucket.
 *
 *   docker network create e2e
 *   docker run -d --name ch --network e2e -p 8123:8123 -e CLICKHOUSE_PASSWORD=e2e \
 *     -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:24.8.14.39
 *   docker run -d --name minio --network e2e -p 9000:9000 minio/minio server /data
 *   docker run --rm --network e2e --entrypoint sh minio/mc -c \
 *     "mc alias set l http://minio:9000 minioadmin minioadmin && mc mb l/archive"
 *   npm run build -w @autter/otlp-ingester
 *   CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_ADMIN_PASSWORD=e2e \
 *     ARCHIVE_E2E_S3_URL=http://minio:9000/archive/e2e \
 *     ARCHIVE_E2E_ACCESS_KEY_ID=minioadmin ARCHIVE_E2E_SECRET_ACCESS_KEY=minioadmin \
 *     node packages/otlp-ingester/scripts/archive-e2e.mjs
 *
 * It creates its own database, applies the schema with an archive configured
 * (the spans TTL moves to the 14-day backstop), inserts spans for two orgs on
 * an old day (past the 7-day hot window, inside the backstop) and a hot one, runs one archive pass, and checks: the old day left the table,
 * the stage table is empty, the log says archived, each org's object reads
 * back with its rows (also with an explicit structure, as the backend reads
 * it); then late rows for the archived day become a second generation.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const S3_URL = process.env.ARCHIVE_E2E_S3_URL?.replace(/\/$/, "");
if (!S3_URL) {
	console.log("archive e2e: ARCHIVE_E2E_S3_URL not set, skipping");
	process.exit(0);
}
const CH = (process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123").replace(/\/$/, "");
const ADMIN_USER = process.env.CLICKHOUSE_ADMIN_USER ?? "default";
const ADMIN_PASSWORD = process.env.CLICKHOUSE_ADMIN_PASSWORD ?? "";
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const DB = `autter_archive_e2e_${Date.now()}`;
const PREFIX = `${S3_URL}/${DB}`;

Object.assign(process.env, {
	CLICKHOUSE_URL: CH,
	CLICKHOUSE_USER: ADMIN_USER,
	CLICKHOUSE_PASSWORD: ADMIN_PASSWORD,
	CLICKHOUSE_DATABASE: DB,
	SPAN_TTL_DAYS: "7",
	ARCHIVE_S3_URL: PREFIX,
	ARCHIVE_S3_ACCESS_KEY_ID: process.env.ARCHIVE_E2E_ACCESS_KEY_ID ?? "",
	ARCHIVE_S3_SECRET_ACCESS_KEY: process.env.ARCHIVE_E2E_SECRET_ACCESS_KEY ?? "",
	ARCHIVE_TABLES: "runtime_spans",
});

const { loadConfig } = await import(pathToFileURL(join(DIST, "config.js")).href);
const { ClickHouseStore } = await import(pathToFileURL(join(DIST, "clickhouse.js")).href);
const { LocalArchiveLease, RuntimeArchiver, addDays, utcDay, s3Function } = await import(pathToFileURL(join(DIST, "archive.js")).href);

let failures = 0;
function check(condition, message, detail) {
	if (condition) return console.log(`  ✔ ${message}`);
	failures += 1;
	console.error(`  ✖ ${message}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

async function sql(query) {
	const res = await fetch(`${CH}/`, {
		method: "POST",
		headers: { "x-clickhouse-user": ADMIN_USER, "x-clickhouse-key": ADMIN_PASSWORD },
		body: /^\s*(SELECT|SHOW)/i.test(query) ? `${query} FORMAT JSONEachRow` : query,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`ClickHouse ${res.status} for ${query.slice(0, 200)}: ${text.trim()}`);
	return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

const config = loadConfig();
const store = new ClickHouseStore(config);
const today = utcDay(new Date());
// Past the 7-day hot window but inside the 14-day backstop TTL, which would
// delete older rows itself before the archiver sees them.
const oldDay = addDays(today, -10);
const hotDay = addDays(today, -1);

async function insertSpans(day, org, n, tag) {
	const values = Array.from({ length: n }, (_, i) =>
		`('${org}', 'repo', 'api', 'production', '${tag}${String(i).padStart(30, "0")}', 's${i}', 'GET /x', 12.5, '${day} 10:00:00.000')`,
	).join(", ");
	await sql(`INSERT INTO ${DB}.runtime_spans (org_id, repository_id, service, environment, trace_id, span_id, name, duration_ms, started_at) VALUES ${values}`);
}

try {
	console.log(`archive e2e: database ${DB}, archive ${PREFIX}`);
	await store.ensureSchema();
	const [engine] = await sql(`SELECT engine_full FROM system.tables WHERE database = '${DB}' AND name = 'runtime_spans'`);
	check(/\bTTL\b[^]*toIntervalDay\(14\)/.test(engine.engine_full), "archived table keeps only the backstop TTL (hot window + 7 days)", engine.engine_full);

	await insertSpans(oldDay, "org_a", 30, "a");
	await insertSpans(oldDay, "org_b", 5, "b");
	await insertSpans(hotDay, "org_a", 7, "c");

	const archiver = new RuntimeArchiver({
		db: store.archiveDb(),
		database: DB,
		config: config.archive,
		hotDays: store.hotDays(),
		lease: new LocalArchiveLease(),
	});
	const first = await archiver.runOnce();
	check(!first.tables[0]?.error, "archive pass ran without error", first);
	check(JSON.stringify(first.tables[0]?.archivedDays) === JSON.stringify([oldDay]), "the old day was archived", first.tables[0]);

	const left = await sql(`SELECT toString(toDate(started_at)) AS day, count() AS n FROM ${DB}.runtime_spans GROUP BY day ORDER BY day`);
	check(left.length === 1 && left[0].day === hotDay && Number(left[0].n) === 7, "only the hot day is left in the table", left);
	const staged = await sql(`SELECT count() AS n FROM ${DB}.runtime_spans_archive_stage`);
	check(Number(staged[0].n) === 0, "the stage table is empty", staged);
	const log = await sql(
		`SELECT toString(day) AS day, argMax(status, updated_at) AS status, argMax(rows, updated_at) AS rows, argMax(orgs, updated_at) AS orgs
		FROM ${DB}.runtime_archive_log GROUP BY day, generation`,
	);
	check(log.length === 1 && log[0].status === "archived" && Number(log[0].rows) === 35 && Number(log[0].orgs) === 2, "the log says archived, 35 rows, 2 orgs", log);

	const archive = { url: PREFIX, namedCollection: null, accessKeyId: config.archive.accessKeyId, secretAccessKey: config.archive.secretAccessKey };
	const orgA = await sql(`SELECT count() AS n FROM ${s3Function(archive, `runtime_spans/org=org_a/date=${oldDay}/g*.parquet`)}`);
	check(Number(orgA[0].n) === 30, "org_a's object has its 30 rows", orgA);
	const structure = (await sql(`SELECT name, type FROM system.columns WHERE database = '${DB}' AND table = 'runtime_spans' ORDER BY position`))
		.map((c) => `${c.name} ${c.type}`)
		.join(", ");
	const typed = await sql(
		`SELECT count() AS n, max(trace_id) AS t FROM ${s3Function(archive, `runtime_spans/org=org_b/date={${oldDay},${addDays(oldDay, 1)}}/g*.parquet`, structure)}
		WHERE org_id = 'org_b' SETTINGS input_format_parquet_allow_missing_columns = 1`,
	);
	check(Number(typed[0].n) === 5, "org_b reads back with the hot table's structure, over a day list", typed);

	await insertSpans(oldDay, "org_a", 2, "d");
	const second = await archiver.runOnce();
	check(!second.tables[0]?.error, "second pass (late rows) ran without error", second);
	const total = await sql(`SELECT count() AS n FROM ${s3Function(archive, `runtime_spans/org=org_a/date=${oldDay}/g*.parquet`)}`);
	check(Number(total[0].n) === 32, "late rows became a second generation next to the first", total);
	const generations = await sql(`SELECT count(DISTINCT generation) AS g FROM ${DB}.runtime_archive_log`);
	check(Number(generations[0].g) === 2, "two generations logged", generations);
} catch (err) {
	failures += 1;
	console.error(`  ✖ ${err instanceof Error ? err.message : err}`);
} finally {
	await sql(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
	await store.close();
}

if (failures > 0) {
	console.error(`archive e2e: ${failures} failure(s)`);
	process.exit(1);
}
console.log("archive e2e: ok");
