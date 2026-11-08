import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createIngesterApp } from "../../otlp-ingester/dist/server.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
// An empty project: only the doctor's own runtime-node is "installed".
const cwd = mkdtempSync(join(tmpdir(), "autter-doctor-"));

function runCli(args) {
	return new Promise((resolve) => {
		const env = { ...process.env };
		delete env.AUTTER_RUNTIME_KEY;
		delete env.AUTTER_ENDPOINT;
		delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
		const child = spawn(process.execPath, [cli, "doctor", ...args], { cwd, env });
		let stdout = "";
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stdout += c));
		child.on("exit", (code) => resolve({ code, stdout }));
	});
}

const listen = (server) =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });

const config = {
	port: 0, clickhouseUrl: null, clickhouseUser: "default", clickhousePassword: "",
	clickhouseDatabase: "autter_runtime", ingestKeys: [{ key: "good", orgId: "o", repositoryId: "r" }],
	keyValidatorUrl: null, keyValidatorToken: null, sinkUrl: null, sinkToken: null,
	sinkMaxAttempts: 1, sinkMaxBufferedBatches: 10, sinkMaxBufferedMb: 2, maxBodyBytes: 1048576,
	rateLimitPerMinute: 300, clientRateLimitPerMinute: 120, occurrenceTtlDays: 14, spanTtlDays: 7,
	metricsTtlDays: 90, llmCallTtlDays: 90,
};

test("doctor: versions match but storage is unconfigured → exit 1, not a plain \"Compatible.\"", async () => {
	// Before: "Compatible." while every ingest request got 503 "storage not configured".
	const server = createIngesterApp(config).app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	try {
		const endpoint = `http://127.0.0.1:${server.address().port}`;
		const { code, stdout } = await runCli(["--endpoint", endpoint, "--json"]);
		const report = JSON.parse(stdout);
		assert.equal(code, 1, stdout);
		assert.match(report.ingester.version, /^\d+\.\d+\.\d+/);
		assert.equal(report.ingester.schema.status, "unconfigured");
		assert.deepEqual(
			{ state: report.storage.state, ok: report.storage.ok, writeChecked: report.storage.writeChecked },
			{ state: "unconfigured", ok: false, writeChecked: true },
		);
		assert.equal(report.key, "not_checked");
		assert.ok(report.features.some((f) => f.id === "operation_logging" && f.status === "ok"));
		assert.equal(report.skew[0].status, "in_sync");
		assert.deepEqual(report.issues, []);

		const text = await runCli(["--endpoint", endpoint]);
		assert.match(text.stdout, /storage {4}NOT READY: no ClickHouse configured \(CLICKHOUSE_URL unset\)/);
		assert.match(text.stdout, /key {8}not checked \(pass --key or set AUTTER_RUNTIME_KEY\)/);
		assert.match(text.stdout, /Not ready: the ingester cannot store data right now/);
		assert.doesNotMatch(text.stdout, /^Compatible\.$/m);
	} finally {
		await close(server);
	}
});

test("doctor passes (exit 0) when storage is ready; without a key it says the key was not checked", async () => {
	const app = createIngesterApp({ ...config, clickhouseUrl: "http://127.0.0.1:1", sinkOutboxDir: null });
	app.store.ensureSchema = async () => {};
	app.store.probe = async () => ({ state: "up", checkedAt: new Date().toISOString(), latencyMs: 1 });
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(app.store))) {
		if (name.startsWith("insert")) app.store[name] = async () => {};
	}
	const server = app.app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	try {
		const endpoint = `http://127.0.0.1:${server.address().port}`;
		const unchecked = await runCli(["--endpoint", endpoint]);
		assert.equal(unchecked.code, 0, unchecked.stdout);
		assert.match(unchecked.stdout, /storage {4}ready: ClickHouse accepts writes/);
		assert.match(unchecked.stdout, /Versions compatible and storage ready\. Key not checked/);
		assert.match(unchecked.stdout, /ok {3}@autter\/runtime-node@[\d.]+: in sync with ingester/);
		const checked = await runCli(["--endpoint", endpoint, "--key", "good"]);
		assert.equal(checked.code, 0, checked.stdout);
		assert.match(checked.stdout, /Ready: versions compatible, storage ready, key accepted/);
		const rejected = await runCli(["--endpoint", endpoint, "--key", "nope", "--json"]);
		assert.equal(rejected.code, 1);
		assert.equal(JSON.parse(rejected.stdout).key, "rejected");
		assert.equal(JSON.parse(rejected.stdout).keyDetail, "invalid ingest key");
	} finally {
		app.sink?.stop();
		await app.collapse.stop();
		await app.drops.stop();
		await close(server);
	}
});

test("doctor exits 1 and names the fix when the ingester is too old", async () => {
	const old = createServer((req, res) => {
		if (req.url === "/v1/compat") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ingester: { version: "1.3.4" }, schema: { status: "ready", applied: [] } }));
		} else res.writeHead(401).end();
	});
	const url = await listen(old);
	try {
		const { code, stdout } = await runCli(["--endpoint", url]);
		assert.equal(code, 1, stdout);
		assert.match(stdout, /ingester\s+@autter\/otlp-ingester@1\.3\.4/);
		assert.match(stdout, /FAIL Operation logging/);
		// Version skew, named per SDK.
		assert.match(stdout, /FAIL @autter\/runtime-node@[\d.]+: ingester 1\.3\.4 is behind: \d+ feature\(s\) this SDK sends need ingester >= [\d.]+ \(.*operation_logging/);
		assert.match(stdout, /Operation logging needs ingester >= 1\.4\.0; yours is 1\.3\.4\. Upgrade the ingester: docker pull/);
	} finally {
		await close(old);
	}
});

test("doctor detects a pre-compat ingester by probing feature routes", async () => {
	const legacy = createServer((req, res) => {
		// 1.3.x: no /v1/compat, no /v1/logs; other routes exist (401 without a key).
		res.writeHead(req.url === "/v1/compat" || req.url === "/v1/logs" ? 404 : 401).end();
	});
	const url = await listen(legacy);
	try {
		const { code, stdout } = await runCli(["--endpoint", url, "--features", "operation_logging,memory_metrics"]);
		assert.equal(code, 1, stdout);
		assert.match(stdout, /1\.4\.0 or older/);
		assert.match(stdout, /no \/v1\/logs route/);
		assert.match(stdout, /\?\?\s+Memory pressure detection/);
	} finally {
		await close(legacy);
	}
});

test("doctor reports a rejected key and exits 1; unreachable ingester exits 2", async () => {
	const fake = createServer((req, res) => {
		if (req.url === "/v1/compat") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ingester: { version: "1.4.0" }, schema: { status: "ready", applied: ["0004-llm-calls"] } }));
		} else res.writeHead(req.headers.authorization === "Bearer good" ? 200 : 401).end("{}");
	});
	const endpoint = await listen(fake);
	try {
		const bad = await runCli(["--endpoint", endpoint, "--key", "wrong-key-value", "--features", "llm_calls", "--json"]);
		assert.equal(bad.code, 1, bad.stdout);
		assert.equal(JSON.parse(bad.stdout).key, "rejected");
		assert.ok(!bad.stdout.includes("wrong-key-value"), "the key is never printed");
		const good = await runCli(["--endpoint", endpoint, "--key", "good", "--features", "llm_calls"]);
		assert.equal(good.code, 0, good.stdout);
		assert.match(good.stdout, /key\s+accepted/);
	} finally {
		await close(fake);
	}
	const down = await runCli(["--endpoint", "http://127.0.0.1:9", "--timeout", "1000"]);
	assert.equal(down.code, 2, down.stdout);
	assert.match(down.stdout, /unreachable/);
	// Where it breaks, not just "could not reach".
	assert.match(down.stdout, /FAIL tcp {3}127\.0\.0\.1:9 ECONNREFUSED/);
	assert.match(down.stdout, /Could not reach the ingester: the TCP step failed/);
});

test("doctor tells a validator outage (503 + Retry-After) from a storage outage (503)", async () => {
	const fake = createServer((req, res) => {
		if (req.url === "/v1/compat") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ingester: { version: "1.4.0" }, schema: { status: "ready", applied: ["0004-llm-calls"] } }));
		} else if (req.headers.authorization === "Bearer unchecked") res.writeHead(503, { "retry-after": "5" }).end("{}");
		else res.writeHead(503).end("{}");
	});
	const endpoint = await listen(fake);
	try {
		const unchecked = await runCli(["--endpoint", endpoint, "--key", "unchecked", "--features", "llm_calls"]);
		assert.equal(unchecked.code, 1, unchecked.stdout);
		assert.match(unchecked.stdout, /key\s+could not be checked: the ingester's key validator is unavailable/);
		const storage = await runCli(["--endpoint", endpoint, "--key", "any", "--features", "llm_calls", "--json"]);
		assert.equal(JSON.parse(storage.stdout).key, "storage_unavailable");
	} finally {
		await close(fake);
	}
});

test("unknown options print usage and exit 64", async () => {
	const { code, stdout } = await runCli(["--nope"]);
	assert.equal(code, 64);
	assert.match(stdout, /Usage: npx @autter\/runtime-node doctor/);
});
