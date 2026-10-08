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

test("doctor passes (exit 0) against a current ingester", async () => {
	const server = createIngesterApp(config).app.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	try {
		const { code, stdout } = await runCli(["--endpoint", `http://127.0.0.1:${server.address().port}`, "--json"]);
		const report = JSON.parse(stdout);
		assert.equal(code, 0, stdout);
		assert.equal(report.exitCode, 0);
		assert.match(report.ingester.version, /^\d+\.\d+\.\d+/);
		assert.equal(report.ingester.schema.status, "unconfigured");
		assert.ok(report.features.some((f) => f.id === "operation_logging" && f.status === "ok"));
		assert.deepEqual(report.issues, []);
	} finally {
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
});

test("unknown options print usage and exit 64", async () => {
	const { code, stdout } = await runCli(["--nope"]);
	assert.equal(code, 64);
	assert.match(stdout, /Usage: npx @autter\/runtime-node doctor/);
});
