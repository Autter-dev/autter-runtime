#!/usr/bin/env node
/**
 * End-to-end check of the built ingester against a real ClickHouse: honest
 * readiness and retry-safe writes (1.12).
 *
 * Needs a ClickHouse whose `default` user can manage access (the Docker
 * image with CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1), and `npm run build`
 * first. Run by hand:
 *
 *   docker run -d --name ch -p 8123:8123 -e CLICKHOUSE_PASSWORD=e2e \
 *     -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server:24.8.14.39
 *   npm run build -w @autter/otlp-ingester
 *   CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_ADMIN_PASSWORD=e2e \
 *     node packages/otlp-ingester/scripts/clickhouse-e2e.mjs
 *
 * It creates its own database and user, boots `dist/index.js` (migrations
 * run against the real server), sends real OTLP/JSON exports and counts the
 * rows ClickHouse holds:
 *   1. the same export sent twice (a retry after a lost response);
 *   2. a partial failure — INSERT revoked on runtime_metrics_1m for one
 *      request — then the retry;
 *   3. a partial failure, the ingester killed, restarted, and the retry;
 *   4. a dropped table, and a wrong password: /healthz unready;
 * and reports (without asserting) whether the server itself deduplicates a
 * retried async insert by its token when the ingester's receipts are off.
 * Exits non-zero on the first failed assertion.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CH = (process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123").replace(/\/$/, "");
const ADMIN_USER = process.env.CLICKHOUSE_ADMIN_USER ?? "default";
const ADMIN_PASSWORD = process.env.CLICKHOUSE_ADMIN_PASSWORD ?? "";
const EXPECT_VERSION = process.env.EXPECT_CLICKHOUSE_VERSION ?? "";
const DB = `autter_e2e_${Date.now()}`;
const USER = `autter_e2e_${process.pid}`;
const PASSWORD = "e2e-ingester-pass";
const KEY = "autter_rt_e2e_key";
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const STATE = mkdtempSync(join(tmpdir(), "autter-ch-e2e-"));
const RUN = Date.now().toString(36);

let failures = 0;
const ok = (message) => console.log(`  ✔ ${message}`);
function check(condition, message, detail) {
	if (condition) return ok(message);
	failures += 1;
	console.error(`  ✖ ${message}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	throw new Error(message);
}

/** Run SQL as the admin; JSONEachRow rows for SELECTs. */
async function sql(query) {
	const res = await fetch(`${CH}/`, {
		method: "POST",
		headers: { "x-clickhouse-user": ADMIN_USER, "x-clickhouse-key": ADMIN_PASSWORD },
		body: /^\s*(SELECT|SHOW)/i.test(query) ? `${query} FORMAT JSONEachRow` : query,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`ClickHouse ${res.status} for ${query}: ${text.trim()}`);
	return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

const ingesters = new Set();

/** Boot dist/index.js on `port`; resolves once /livez answers. */
async function startIngester(port, env = {}) {
	const logs = [];
	const child = spawn(process.execPath, [ENTRY], {
		env: {
			...process.env,
			PORT: String(port),
			CLICKHOUSE_URL: CH,
			CLICKHOUSE_USER: USER,
			CLICKHOUSE_PASSWORD: PASSWORD,
			CLICKHOUSE_DATABASE: DB,
			AUTTER_INGEST_KEYS: JSON.stringify([{ key: KEY, orgId: "org-e2e", repositoryId: "repo-e2e" }]),
			AUTTER_SINK_URL: "",
			INSERT_RECEIPTS_FILE: join(STATE, "insert-receipts.log"),
			LOOP_COLLAPSE_AFTER: "0",
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (d) => logs.push(String(d)));
	child.stderr.on("data", (d) => logs.push(String(d)));
	const ingester = {
		url: `http://127.0.0.1:${port}`,
		logs,
		child,
		async stop(signal = "SIGTERM") {
			if (child.exitCode !== null) return;
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill(signal);
			await exited;
			ingesters.delete(ingester);
		},
	};
	ingesters.add(ingester);
	for (let i = 0; i < 100; i++) {
		if (child.exitCode !== null) throw new Error(`ingester exited: ${logs.join("")}`);
		try {
			if ((await fetch(`${ingester.url}/livez`)).ok) return ingester;
		} catch {
			// not listening yet
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`ingester did not start: ${logs.join("")}`);
}

async function health(ingester) {
	const res = await fetch(`${ingester.url}/healthz`);
	return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

/** Poll /healthz until `predicate` holds (the probe is cached for 5 s). */
async function waitHealth(ingester, predicate, ms = 20_000) {
	const until = Date.now() + ms;
	let last;
	while (Date.now() < until) {
		last = await health(ingester);
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return last;
}

/** One failed server request with an exception: one span, one occurrence,
 * one request (and one error) in runtime_metrics_1m. Fixed timestamps, so a
 * re-send is byte-identical, like an exporter retry. */
function exportFor(name) {
	const start = BigInt(Date.now()) * 1_000_000n;
	const traceId = Buffer.from(`${RUN}-${name}`.padEnd(16, "0").slice(0, 16)).toString("hex");
	return {
		traceId,
		service: `e2e-${RUN}-${name}`,
		body: JSON.stringify({
			resourceSpans: [{
				resource: { attributes: [{ key: "service.name", value: { stringValue: `e2e-${RUN}-${name}` } }] },
				scopeSpans: [{
					spans: [{
						traceId,
						spanId: "b7ad6b7169203331",
						name: "POST /charge",
						kind: 2,
						startTimeUnixNano: String(start),
						endTimeUnixNano: String(start + 5_000_000n),
						status: { code: 2, message: "card declined" },
						attributes: [
							{ key: "http.route", value: { stringValue: "/charge" } },
							{ key: "http.request.method", value: { stringValue: "POST" } },
							{ key: "http.response.status_code", value: { intValue: "500" } },
						],
						events: [{
							name: "exception",
							timeUnixNano: String(start + 1_000_000n),
							attributes: [
								{ key: "exception.type", value: { stringValue: "PaymentError" } },
								{ key: "exception.message", value: { stringValue: `card declined ${name}` } },
							],
						}],
					}],
				}],
			}],
		}),
	};
}

async function send(ingester, exp) {
	const res = await fetch(`${ingester.url}/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: exp.body,
	});
	await res.text();
	return res.status;
}

/** What ClickHouse holds for one export. */
async function rows(exp) {
	const [spans] = await sql(`SELECT count() AS n FROM ${DB}.runtime_spans WHERE trace_id = '${exp.traceId}'`);
	const [occ] = await sql(`SELECT count() AS n FROM ${DB}.runtime_error_occurrences WHERE trace_id = '${exp.traceId}'`);
	const [metrics] = await sql(
		`SELECT sum(request_count) AS requests, sum(error_count) AS errors FROM ${DB}.runtime_metrics_1m WHERE service = '${exp.service}'`,
	);
	return { spans: Number(spans.n), occurrences: Number(occ.n), requests: Number(metrics.requests), errors: Number(metrics.errors) };
}

/** Exactly one copy: what a single successful send stores. */
async function checkOneCopy(exp, baseline, label) {
	const got = await rows(exp);
	check(
		got.spans === 1 && got.occurrences === baseline.occurrences && got.requests === baseline.requests && got.errors === baseline.errors,
		`${label}: exactly one copy in runtime_spans, runtime_error_occurrences and runtime_metrics_1m`,
		{ got, expected: { spans: 1, ...baseline } },
	);
}

async function main() {
	console.log(`ClickHouse ${CH}, database ${DB}, user ${USER}`);
	const [{ v: serverVersion }] = await sql("SELECT version() AS v");
	console.log(`server version ${serverVersion}`);
	if (EXPECT_VERSION) check(serverVersion === EXPECT_VERSION, `server is ClickHouse ${EXPECT_VERSION}`, serverVersion);

	await sql(`DROP USER IF EXISTS ${USER}`);
	await sql(`CREATE USER ${USER} IDENTIFIED WITH plaintext_password BY '${PASSWORD}'`);
	await sql(`GRANT CREATE DATABASE ON ${DB}.* TO ${USER}`);
	await sql(`GRANT ALL ON ${DB}.* TO ${USER}`);
	await sql(`GRANT SELECT ON system.* TO ${USER}`);

	console.log("\n— boot, migrations, readiness");
	let ingester = await startIngester(14318);
	let h = await waitHealth(ingester, (r) => r.status === 200);
	check(h.status === 200 && h.body.ok === true && h.body.clickhouse === "up", "/healthz is ready against a real ClickHouse", h.body);
	check(h.body.clickhouseVersion === serverVersion, "/healthz reports clickhouseVersion", h.body.clickhouseVersion);
	check(h.body.insertReceipts?.mode === "file", "insert receipts are journaled to a file", h.body.insertReceipts);
	const migrations = (await sql(`SELECT id FROM ${DB}.schema_migrations`)).map((r) => r.id);
	check(migrations.includes("0023-readiness-and-sink-dead-letters"), "migration 0023 applied", migrations.slice(-3));
	const tables = (await sql(`SELECT name FROM system.tables WHERE database = '${DB}'`)).map((r) => r.name);
	check(
		tables.includes("runtime_sink_dead_letters") && tables.includes("runtime_ingester_heartbeat"),
		"0023 tables exist",
		tables,
	);
	const [beat] = await sql(`SELECT count() AS n FROM ${DB}.runtime_ingester_heartbeat`);
	check(Number(beat.n) >= 1, "the readiness probe wrote a heartbeat row");

	console.log("\n— 1. the same export sent twice (retry after a lost response)");
	const e1 = exportFor("lost-response");
	check((await send(ingester, e1)) === 200, "first send stored");
	const baseline = await rows(e1);
	const { spans: _spans, ...one } = baseline;
	console.log(`    one send stores ${JSON.stringify(baseline)}`);
	check(baseline.spans === 1 && baseline.requests >= 1 && baseline.occurrences >= 1, "one send stores a span, an occurrence and a request", baseline);
	check((await send(ingester, e1)) === 200, "re-send answered 200");
	await checkOneCopy(e1, one, "after the re-send");

	console.log("\n— 2. partial failure (INSERT revoked on runtime_metrics_1m), then the retry");
	const e2 = exportFor("partial");
	await sql(`REVOKE INSERT ON ${DB}.runtime_metrics_1m FROM ${USER}`);
	let status = await send(ingester, e2);
	check(status === 503, "the failed fan-out answers 503", status);
	const partial = await rows(e2);
	check(partial.spans === 1 && partial.requests === 0, "spans committed, metrics did not (a real partial write)", partial);
	h = await health(ingester);
	check(h.status === 503 && h.body.clickhouse === "auth_failed", "/healthz is unready after an ingest write was refused", h.body.clickhouse);
	await sql(`GRANT INSERT ON ${DB}.runtime_metrics_1m TO ${USER}`);
	check((await send(ingester, e2)) === 200, "retry stored");
	await checkOneCopy(e2, one, "after the retry");
	h = await waitHealth(ingester, (r) => r.status === 200);
	check(h.status === 200, "/healthz ready again after a successful write", h.body);

	console.log("\n— 3. partial failure, ingester killed and restarted, then the retry");
	const e3 = exportFor("restart");
	await sql(`REVOKE INSERT ON ${DB}.runtime_metrics_1m FROM ${USER}`);
	check((await send(ingester, e3)) === 503, "partial failure answers 503");
	await ingester.stop("SIGKILL");
	await sql(`GRANT INSERT ON ${DB}.runtime_metrics_1m TO ${USER}`);
	ingester = await startIngester(14318);
	check((await send(ingester, e3)) === 200, "retry after the restart stored");
	await checkOneCopy(e3, one, "after the restart and retry");
	check((await send(ingester, e1)) === 200, "export 1 re-sent after the restart");
	await checkOneCopy(e1, one, "export 1 after the restart");

	console.log("\n— 4. a dropped table makes /healthz unready until it is recreated");
	await sql(`DROP TABLE ${DB}.runtime_spans`);
	const e4 = exportFor("dropped-table");
	status = await send(ingester, e4);
	check(status === 503, "a write into the dropped table answers 503", status);
	h = await health(ingester);
	check(h.status === 503 && h.body.clickhouse === "schema_missing", "/healthz: schema_missing", h.body.clickhouse);
	check((await send(ingester, e4)) === 200, "the next write recreates the table and stores");
	await checkOneCopy(e4, one, "after the table was recreated");
	h = await waitHealth(ingester, (r) => r.status === 200);
	check(h.status === 200, "/healthz ready again", h.body);

	console.log("\n— 5. a wrong password makes /healthz unready (not retryable)");
	const wrong = await startIngester(14319, { CLICKHOUSE_PASSWORD: "not-the-password", INSERT_RECEIPTS_FILE: "off" });
	h = await health(wrong);
	check(h.status === 503 && h.body.clickhouse === "auth_failed" && h.body.retryable === false, "/healthz: auth_failed", h.body);
	check((await send(wrong, exportFor("wrong-password"))) === 503, "ingest answers 503 too");
	check(((await fetch(`${wrong.url}/livez`)).status) === 200, "/livez stays 200");
	await wrong.stop();

	console.log("\n— informational: does the server dedupe a retried async insert by its token alone?");
	await ingester.stop();
	const noReceipts = { INSERT_RECEIPTS_FILE: "off" };
	let bare = await startIngester(14318, noReceipts);
	const e5 = exportFor("token-only");
	await send(bare, e5);
	await bare.stop();
	bare = await startIngester(14318, noReceipts); // receipts gone with the process
	await send(bare, e5);
	const tokenOnly = await rows(e5);
	console.log(
		tokenOnly.spans === 1
			? `    ClickHouse ${serverVersion} dropped the retried block by its token (spans: 1)`
			: `    ClickHouse ${serverVersion} kept both blocks (spans: ${tokenOnly.spans}): the token does not dedupe async inserts here; the ingester's receipts are what prevent duplicates`,
	);
	await bare.stop();
}

let exitCode = 0;
try {
	await main();
	console.log(`\nall checks passed`);
} catch (err) {
	exitCode = 1;
	if (!failures) console.error(`\nerror: ${err?.stack ?? err}`);
	for (const ingester of ingesters) console.error(`\n--- ingester ${ingester.url} log ---\n${ingester.logs.join("").slice(-6000)}`);
} finally {
	for (const ingester of [...ingesters]) await ingester.stop().catch(() => {});
	await sql(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
	await sql(`DROP USER IF EXISTS ${USER}`).catch(() => {});
	rmSync(STATE, { recursive: true, force: true });
}
process.exit(exitCode);
