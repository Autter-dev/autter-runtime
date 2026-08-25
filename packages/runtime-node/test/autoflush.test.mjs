import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = (name) => path.join(here, "fixtures", name);

function runChild(file, env = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [file], {
			env: { ...process.env, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

let collector;
let collectorPort;
let receivedBodies;

before(async () => {
	receivedBodies = [];
	collector = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	collectorPort = collector.address().port;
});

after(() => collector.close());

test("SIGTERM with no other handler: flushes then exits 130/143", async () => {
	const { code, out } = await runChild(fixtures("sigterm-sole.mjs"));
	assert.equal(code, 143); // SIGTERM -> 128 + 15
	assert.match(out, /\[autter\] telemetry flushed/);
});

test("second signal exits immediately instead of waiting for a slow flush", async () => {
	const started = Date.now();
	const { code } = await runChild(fixtures("sigterm-double.mjs"));
	const elapsed = Date.now() - started;
	assert.equal(code, 143);
	// Flush target alone would hold the process for ~2s; the second SIGTERM
	// must cut through well before that.
	assert.ok(elapsed < 1_500, `took ${elapsed}ms — second signal did not cut through`);
});

test("SIGTERM coexists with the app's own handler — app exit code wins", async () => {
	const { code, out } = await runChild(fixtures("sigterm-coexists.mjs"));
	assert.equal(code, 0);
	assert.match(out, /app graceful drain complete/);
});

test("beforeExit flush completes inside the natural-exit window", async () => {
	const { code, out } = await runChild(fixtures("before-exit.mjs"));
	assert.equal(code, 0);
	assert.match(out, /FLUSHED=1/);
	assert.ok(!/FLUSHED=2/.test(out), "beforeExit must not loop flushes");
});

test("e2e: captured exception attributes are redacted on the wire", async () => {
	const { code, err } = await runChild(fixtures("e2e-redaction.mjs"), {
		COLLECTOR_PORT: String(collectorPort),
		AUTTER_DEBUG: "1",
	});
	assert.equal(code, 143);

	assert.ok(receivedBodies.length > 0, "collector received nothing");
	const wire = receivedBodies.join("\n");

	// PII must not survive the trip.
	assert.ok(!wire.includes("jane.doe@example.com"), "raw email leaked");
	assert.ok(!wire.includes("supersecrettoken123456"), "raw bearer token leaked");
	assert.ok(!wire.includes("eyJhbGciOiJIUzI1NiJ9"), "raw JWT leaked");

	// Mask present; non-sensitive context intact.
	assert.ok(wire.includes("[redacted]"), "expected mask marker");
	assert.ok(wire.includes("o-1"), "non-sensitive attribute was dropped");
	assert.ok(wire.includes("boom: order failed"), "exception message missing");

	// Debug mode reported exports.
	assert.match(err, /exported \d+ span/);
});
