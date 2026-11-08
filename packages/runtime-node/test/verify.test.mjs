import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createIngesterApp } from "../../otlp-ingester/dist/server.js";

/**
 * `npx @autter/runtime-node verify` against the real ingester app with its
 * ClickHouse stubbed (CI's examples-e2e and clickhouse-e2e jobs run it
 * against a real ClickHouse 24.8). Each scenario checks the first failing
 * step is the one named.
 */

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "autter-verify-"));
const KEY = `autter_rt_${"5".repeat(48)}`;

function runCli(args, env = {}) {
	return new Promise((resolve) => {
		const childEnv = { ...process.env, ...env };
		for (const name of ["AUTTER_RUNTIME_KEY", "AUTTER_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT", "GIT_SHA", "AUTTER_RELEASE", "GITHUB_SHA", "AUTTER_SERVICE", "OTEL_SERVICE_NAME"]) {
			if (!(name in env)) delete childEnv[name];
		}
		const child = spawn(process.execPath, [cli, "verify", ...args], { cwd, env: childEnv });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });

const baseConfig = {
	port: 0, clickhouseUrl: "http://127.0.0.1:1", clickhouseUser: "default", clickhousePassword: "",
	clickhouseDatabase: "autter_runtime", ingestKeys: [{ key: KEY, orgId: "o", repositoryId: "r" }],
	keyValidatorUrl: null, keyValidatorToken: null, sinkUrl: null, sinkToken: null, sinkOutboxDir: null,
	sinkMaxAttempts: 1, sinkMaxBufferedBatches: 10, sinkMaxBufferedMb: 2, maxBodyBytes: 1048576,
	rateLimitPerMinute: 300, clientRateLimitPerMinute: 120, occurrenceTtlDays: 14, spanTtlDays: 7,
	metricsTtlDays: 90, llmCallTtlDays: 90,
};

/** The ingester app with an in-memory "ClickHouse" keyed by trace id. */
async function ingester({ storage = "up", dropWrites = false } = {}) {
	const app = createIngesterApp(baseConfig);
	const { store } = app;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) store[name] = async () => {};
	}
	const rows = { spans: [], occurrences: [], logs: [] };
	store.ensureSchema = async () => {};
	store.recentOccurrenceTraceIds = async () => new Set();
	store.probe = async () => ({ state: storage, checkedAt: new Date().toISOString(), latencyMs: 1 });
	store.insertSpans = async (_ctx, spans) => void (dropWrites || rows.spans.push(...spans));
	store.insertOccurrences = async (_ctx, occ) => void (dropWrites || rows.occurrences.push(...occ));
	store.insertLogs = async (_ctx, logs) => void (dropWrites || rows.logs.push(...logs));
	const table = (list, trace) => {
		const hit = list.filter((row) => row.traceId === trace);
		return { rows: hit.length, services: [...new Set(hit.map((r) => r.service))], releases: [...new Set(hit.map((r) => r.release).filter(Boolean))] };
	};
	store.verifyLookup = async (_ctx, trace) => ({
		spans: table(rows.spans, trace),
		occurrences: table(rows.occurrences, trace),
		logs: table(rows.logs, trace),
	});
	const server = app.app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		rows,
		close: async () => {
			app.sink?.stop();
			await app.collapse.stop();
			await app.drops.stop();
			await close(server);
		},
	};
}

const stepOf = (report, name) => report.steps.find((s) => s.step === name);

test("verify: every step passes against a working ingester", async () => {
	const ing = await ingester();
	try {
		const { code, stdout } = await runCli(["--endpoint", ing.url, "--key", KEY, "--service", "checkout", "--release", "abc123", "--json"]);
		const report = JSON.parse(stdout);
		assert.equal(code, 0, stdout);
		assert.equal(report.firstFailure, null);
		for (const name of ["key", "network", "storage", "auth", "ingest", "stored", "trace", "release", "logs"]) {
			assert.equal(stepOf(report, name).status, "pass", `${name}: ${JSON.stringify(stepOf(report, name))}`);
		}
		assert.match(stepOf(report, "ingest").detail, /spans=1 occurrences=1 metric_points=0/);
		// The test event was stored under its trace id, release and environment "verify".
		const span = ing.rows.spans.find((s) => s.traceId === report.traceId);
		assert.equal(span.service, "checkout");
		assert.equal(span.environment, "verify");
		assert.equal(ing.rows.occurrences[0].errorType, "AutterVerifyTestEvent");
		assert.equal(ing.rows.logs.length, 1);
	} finally {
		await ing.close();
	}
});

test("verify: the human report names each step and says it never opens an issue", async () => {
	const ing = await ingester();
	try {
		const { code, stdout } = await runCli(["--endpoint", ing.url, "--service", "checkout"], { AUTTER_RUNTIME_KEY: KEY });
		assert.equal(code, 0, stdout);
		assert.match(stdout, /ok {3}stored {4}1 span and 1 error stored after/);
		assert.match(stdout, /warn release {3}no release set/);
		assert.match(stdout, /Delivered: a test event from "checkout" was accepted and stored\. Check the warnings: release\./);
		assert.match(stdout, /never opens an issue/);
	} finally {
		await ing.close();
	}
});

test("verify: no key → the key step fails first, nothing is sent", async () => {
	const { code, stdout } = await runCli(["--endpoint", "http://127.0.0.1:9", "--json"]);
	const report = JSON.parse(stdout);
	assert.equal(code, 1);
	assert.equal(report.firstFailure.step, "key");
	assert.match(report.firstFailure.fix, /AUTTER_RUNTIME_KEY/);
	assert.equal(stepOf(report, "network").status, "skip");
});

test("verify: a wrong key fails at auth with the ingester's reason", async () => {
	const ing = await ingester();
	try {
		const { code, stdout } = await runCli(["--endpoint", ing.url, "--key", `autter_rt_${"0".repeat(48)}`]);
		assert.equal(code, 1, stdout);
		assert.match(stdout, /FAIL auth {6}401: invalid ingest key/);
		assert.match(stdout, /First failing step: auth\. Check AUTTER_RUNTIME_KEY/);
		assert.equal(ing.rows.spans.length, 0);
	} finally {
		await ing.close();
	}
});

test("verify: storage not writable fails at storage, before anything is sent", async () => {
	const ing = await ingester({ storage: "auth_failed" });
	try {
		const { code, stdout } = await runCli(["--endpoint", ing.url, "--key", KEY, "--json"]);
		const report = JSON.parse(stdout);
		assert.equal(code, 1);
		assert.equal(report.firstFailure.step, "storage");
		assert.match(report.firstFailure.fix, /CLICKHOUSE_USER\/CLICKHOUSE_PASSWORD/);
	} finally {
		await ing.close();
	}
});

test("verify: accepted but never stored fails at stored", async () => {
	const ing = await ingester({ dropWrites: true });
	try {
		const { code, stdout } = await runCli(["--endpoint", ing.url, "--key", KEY, "--wait", "300", "--json"]);
		const report = JSON.parse(stdout);
		assert.equal(code, 1, stdout);
		assert.equal(report.firstFailure.step, "stored");
		assert.match(report.firstFailure.detail, /accepted but not found after .* 0 span\(s\), 0 error\(s\) stored/);
	} finally {
		await ing.close();
	}
});

test("verify: an unreachable endpoint exits 2 and names the network step", async () => {
	const { code, stdout } = await runCli(["--endpoint", "http://127.0.0.1:9", "--key", KEY, "--timeout", "1000", "--json"]);
	const report = JSON.parse(stdout);
	assert.equal(code, 2);
	assert.equal(report.firstFailure.step, "network");
	assert.match(report.firstFailure.detail, /^TCP: 127\.0\.0\.1:9 ECONNREFUSED/);
});

test("verify: an ingester without /v1/verify gets a plain span (no error) and 'stored: not checked'", async () => {
	const posted = [];
	const old = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
			if (req.url === "/v1/compat") return json(200, { ingester: { version: "1.12.1" }, schema: { status: "ready", applied: [] } });
			if (req.url === "/healthz") return json(200, { ok: true, clickhouse: "up" });
			if (req.url === "/livez") return json(200, { ok: true });
			if (req.method === "POST" && req.url === "/v1/traces") { posted.push(JSON.parse(body)); return json(200, { partialSuccess: {} }); }
			json(404, { error: "not found" });
		});
	});
	await new Promise((resolve) => old.listen(0, "127.0.0.1", resolve));
	try {
		const { code, stdout } = await runCli(["--endpoint", `http://127.0.0.1:${old.address().port}`, "--key", KEY, "--release", "r1", "--json"]);
		const report = JSON.parse(stdout);
		assert.equal(code, 0, stdout);
		assert.equal(stepOf(report, "stored").status, "warn");
		assert.match(stepOf(report, "stored").detail, /has no \/v1\/verify/);
		const testRequest = posted.find((p) => p.resourceSpans.length > 0);
		assert.ok(testRequest, "the test span was sent");
		assert.equal(testRequest.resourceSpans[0].scopeSpans[0].spans[0].events, undefined, "no error event: an older ingester would turn it into an issue");
	} finally {
		await close(old);
	}
});

test("verify --help and bad options", async () => {
	const help = await runCli(["--help"]);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /names the first step that fails|naming the first step that fails/);
	const bad = await runCli(["--wait", "soon"]);
	assert.equal(bad.code, 64);
	assert.match(bad.stderr, /--wait needs a positive number of ms/);
});
