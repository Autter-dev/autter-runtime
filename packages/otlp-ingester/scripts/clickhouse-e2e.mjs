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
 *   4. a dropped table the ingester may not recreate, and a wrong
 *      password: /healthz unready (and ready again once the table is back);
 *   5. cache-aware LLM cost: migration 0024's columns and defaults, an
 *      insert that does not name them, and a GenAI span with cache tokens;
 *   6. `verify` (Node CLI and Python compat.py): a tagged test event read
 *      back through GET /v1/verify from the real tables, with no rollup row;
 *      against the wrong-password ingester it stops at "storage".
 *      Needs `npm run build -w @autter/runtime-node` too, and python3.
 * and reports (without asserting) whether the server itself deduplicates a
 * retried async insert by its token when the ingester's receipts are off.
 * Exits non-zero on the first failed assertion.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VERIFY_CLI = join(REPO, "packages", "runtime-node", "dist", "cli.js");
const PY_COMPAT = join(REPO, "adapters", "python", "compat.py");
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

/** Run a verify CLI (`node cli.js verify …` or `python3 compat.py verify …`) with --json. */
function runVerify(command, args) {
	return new Promise((resolve) => {
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTTER_|OTEL_)/.test(k)));
		const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("exit", (code) => {
			let report = null;
			try {
				report = JSON.parse(out);
			} catch {
				// not JSON: reported below
			}
			resolve({ code, report, out: out + err });
		});
	});
}

async function verifyEndToEnd(ingester, label, command, args) {
	const service = `e2e-${RUN}-verify-${label}`;
	const release = `rel-${RUN}`;
	const { code, report, out } = await runVerify(command, [...args, "verify", "--endpoint", ingester.url, "--key", KEY, "--service", service, "--release", release, "--json"]);
	check(code === 0 && report?.firstFailure === null, `${label} verify: every step passes against ClickHouse ${CH}`, report?.firstFailure ?? out);
	for (const name of ["key", "network", "storage", "auth", "ingest", "stored", "trace", "release", "logs"]) {
		const step = report.steps.find((s) => s.step === name);
		check(step?.status === "pass", `${label} verify: ${name}`, step);
	}
	const traceId = report.traceId;
	const [occ] = await sql(`SELECT count() AS n, any(release) AS release, any(environment) AS env FROM ${DB}.runtime_error_occurrences WHERE trace_id = '${traceId}'`);
	check(Number(occ.n) === 1 && occ.release === release && occ.env === "verify", `${label} verify: one test error in runtime_error_occurrences, release and environment kept`, occ);
	const [logs] = await sql(`SELECT count() AS n FROM ${DB}.runtime_logs WHERE trace_id = '${traceId}'`);
	check(Number(logs.n) === 1, `${label} verify: one test log record in runtime_logs`, logs);
	const [rollup] = await sql(`SELECT count() AS n FROM ${DB}.runtime_metrics_1m WHERE service = '${service}'`);
	check(Number(rollup.n) === 0, `${label} verify: no runtime_metrics_1m row (a test event moves no dashboard)`, rollup);
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

/**
 * Migration 0024: the cache columns exist with their defaults, an insert
 * that does not name them (an older replica during a rolling deploy) reads
 * 0 and '', and a real GenAI span is stored with its cache tokens and a
 * cache-aware estimate.
 */
async function checkLlmCacheColumns(ingester, migrations) {
	check(migrations.includes("0024-llm-cache-tokens"), "migration 0024 applied", migrations.slice(-3));
	const columns = await sql(
		`SELECT name, type, default_expression FROM system.columns WHERE database = '${DB}' AND table = 'runtime_llm_calls'
		 AND name IN ('cache_read_tokens', 'cache_write_tokens', 'cache_write_long_tokens', 'reasoning_tokens', 'pricing_version') ORDER BY name`,
	);
	check(
		JSON.stringify(columns.map((c) => [c.name, c.type, c.default_expression])) ===
			JSON.stringify([
				["cache_read_tokens", "UInt64", "0"],
				["cache_write_long_tokens", "UInt64", "0"],
				["cache_write_tokens", "UInt64", "0"],
				["pricing_version", "LowCardinality(String)", "''"],
				["reasoning_tokens", "UInt64", "0"],
			]),
		"runtime_llm_calls has the cache columns with their defaults",
		columns,
	);
	await sql(
		`INSERT INTO ${DB}.runtime_llm_calls (org_id, repository_id, service, environment, model, input_tokens, output_tokens, cost_usd, cost_source, started_at)
		 VALUES ('e2e-old-shape', 'r', 's', 'e', 'gpt-4o', 10, 3, 0.000055, 'estimated', now64(3))`,
	);
	const [old] = await sql(
		`SELECT cache_read_tokens AS r, cache_write_tokens AS w, cache_write_long_tokens AS l, reasoning_tokens AS x, pricing_version AS v
		 FROM ${DB}.runtime_llm_calls WHERE org_id = 'e2e-old-shape'`,
	);
	check(
		Number(old.r) === 0 && Number(old.w) === 0 && Number(old.l) === 0 && Number(old.x) === 0 && old.v === "",
		"an insert that does not name the cache columns (an older replica) reads 0 and ''",
		old,
	);
	const start = BigInt(Date.now()) * 1_000_000n;
	const traceId = Buffer.from(`${RUN}-llm`.padEnd(16, "0").slice(0, 16)).toString("hex");
	const attr = (key, value) => (typeof value === "number" ? { key, value: { intValue: String(value) } } : { key, value: { stringValue: value } });
	const res = await fetch(`${ingester.url}/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
		body: JSON.stringify({
			resourceSpans: [{
				resource: { attributes: [attr("service.name", `e2e-${RUN}-llm`)] },
				scopeSpans: [{
					spans: [{
						traceId,
						spanId: "c7ad6b7169203331",
						name: "chat gpt-5",
						kind: 3,
						startTimeUnixNano: String(start),
						endTimeUnixNano: String(start + 900_000_000n),
						attributes: [
							attr("gen_ai.provider.name", "openai"),
							attr("gen_ai.operation.name", "chat"),
							attr("gen_ai.request.model", "gpt-5"),
							attr("gen_ai.usage.input_tokens", 10_000),
							attr("gen_ai.usage.cache_read.input_tokens", 9_000),
							attr("gen_ai.usage.output_tokens", 500),
							attr("gen_ai.usage.reasoning.output_tokens", 200),
						],
					}],
				}],
			}],
		}),
	});
	await res.text();
	check(res.status === 200, "a GenAI span with cache tokens is accepted", res.status);
	const [row] = await sql(
		`SELECT input_tokens AS i, cache_read_tokens AS r, reasoning_tokens AS x, cost_usd AS c, cost_source AS s, pricing_version AS v
		 FROM ${DB}.runtime_llm_calls WHERE trace_id = '${traceId}'`,
	);
	// gpt-5: 1,000 uncached at $1.25, 9,000 cached at $0.125, 500 out at $10 per 1M.
	const expected = (1_000 * 1.25 + 9_000 * 0.125 + 500 * 10) / 1e6;
	check(
		row && Number(row.i) === 10_000 && Number(row.r) === 9_000 && Number(row.x) === 200 && row.s === "estimated" && /^\d{4}-\d{2}-\d{2}$/.test(row.v) && Math.abs(Number(row.c) - expected) < 1e-9,
		"the call is stored with its cache tokens, a cache-aware estimate and the price table's version",
		row,
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

	console.log("\n— cache-aware LLM cost (migration 0024)");
	await checkLlmCacheColumns(ingester, migrations);

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

	console.log("\n— 6. verify: a test event end to end, read back from the real tables");
	check(existsSync(VERIFY_CLI), "runtime-node is built (npm run build -w @autter/runtime-node)", VERIFY_CLI);
	await verifyEndToEnd(ingester, "node", process.execPath, [VERIFY_CLI]);
	await verifyEndToEnd(ingester, "python", "python3", [PY_COMPAT]);
	const [delivery] = [await (await fetch(`${ingester.url}/v1/verify`, { headers: { authorization: `Bearer ${KEY}` } })).json()];
	check(delivery.delivery?.accepted >= 2 && delivery.storage === "up", "GET /v1/verify: this key's delivery record and storage", delivery);

	console.log("\n— 4. a dropped table that cannot be recreated makes /healthz unready; once it can, the ingester heals");
	// Without CREATE TABLE the ingester cannot put the table back (with it,
	// the next readiness probe or write recreates it at once).
	await sql(`REVOKE CREATE TABLE ON ${DB}.* FROM ${USER}`);
	await sql(`DROP TABLE ${DB}.runtime_spans`);
	const e4 = exportFor("dropped-table");
	status = await send(ingester, e4);
	check(status === 503, "a write into the dropped table answers 503", status);
	h = await health(ingester);
	check(h.status === 503 && h.body.clickhouse !== "up", "/healthz is unready while the table is missing", h.body.clickhouse);
	check(h.body.writes.failingTables.includes("runtime_spans"), "/healthz names the failing table", h.body.writes.failingTables);
	await sql(`GRANT CREATE TABLE ON ${DB}.* TO ${USER}`);
	h = await waitHealth(ingester, (r) => r.status === 200);
	check(h.status === 200, "/healthz ready again once the table could be recreated", h.body);
	const spansBack = (await sql(`SELECT name FROM system.tables WHERE database = '${DB}' AND name = 'runtime_spans'`)).length;
	check(spansBack === 1, "runtime_spans recreated by the ingester");
	check((await send(ingester, e4)) === 200, "the retry stores");
	await checkOneCopy(e4, one, "after the table was recreated");

	console.log("\n— 5. a wrong password makes /healthz unready (not retryable)");
	const wrong = await startIngester(14319, { CLICKHOUSE_PASSWORD: "not-the-password", INSERT_RECEIPTS_FILE: "off" });
	h = await health(wrong);
	check(h.status === 503 && h.body.clickhouse === "auth_failed" && h.body.retryable === false, "/healthz: auth_failed", h.body);
	check((await send(wrong, exportFor("wrong-password"))) === 503, "ingest answers 503 too");
	check(((await fetch(`${wrong.url}/livez`)).status) === 200, "/livez stays 200");
	const stopped = await runVerify(process.execPath, [VERIFY_CLI, "verify", "--endpoint", wrong.url, "--key", KEY, "--json"]);
	check(stopped.code === 1 && stopped.report?.firstFailure?.step === "storage", "verify names storage as the first failing step", stopped.report?.firstFailure ?? stopped.out);
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
