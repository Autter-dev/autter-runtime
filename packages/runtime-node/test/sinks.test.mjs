import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { consoleSink, fileSink, otlpSink } from "../dist/index.js";

const context = { endpoint: "http://x", apiKey: "k", service: "svc", environment: "development" };
const summary = (i) => ({
	time: Date.parse("2026-10-07T12:00:00Z") + i,
	level: "info",
	message: `checkout ${i}`,
	attributes: {
		"autter.event.type": "operation",
		"autter.operation.name": "POST /checkout",
		"autter.operation.outcome": "succeeded",
		"autter.operation.duration_ms": 12,
		"autter.operation.steps": [{ name: "reserve", status: "succeeded", durationMs: 4 }],
		"autter.request.id": `req-${String(i).padStart(8, "0")}`,
		"http.response.status_code": 200,
		cart: { items: i, note: "x".repeat(200) },
		"autter.operation.logs": [{ t: 1, level: "info", message: "applied coupon" }],
	},
});

test("fileSink writes NDJSON per day and rotates by size, keeping maxFiles", () => {
	const dir = mkdtempSync(join(tmpdir(), "autter-files-"));
	try {
		const sink = fileSink({ dir, maxBytes: 2048, maxFiles: 3 });
		sink.start(context);
		for (let i = 0; i < 40; i++) sink.write(summary(i));
		const files = readdirSync(dir).sort();
		assert.equal(files.length, 3);
		assert.ok(files.every((name) => /^2026-10-07(\.\d+)?\.jsonl$/.test(name)), files.join());
		const newest = files
			.map((name) => ({ name, index: Number(name.split(".")[1]) || 0 }))
			.sort((a, b) => b.index - a.index)[0].name;
		const lines = readFileSync(join(dir, newest), "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(lines.at(-1).message, "checkout 39");
		assert.equal(lines.at(-1).service, "svc");
		assert.equal(lines.at(-1)["autter.request.id"], "req-00000039");
		assert.equal(lines.at(-1).time, "2026-10-07T12:00:00.039Z");
		// next day → new file
		sink.write({ ...summary(0), time: Date.parse("2026-10-08T00:00:01Z") });
		assert.ok(readdirSync(dir).includes("2026-10-08.jsonl"));
		assert.equal(readdirSync(dir).length, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Skipped where chmod cannot make a directory unwritable: for root (it
// writes anyway) and on Windows (chmod only toggles the read-only attribute,
// which Windows ignores on directories).
const cannotLockDir =
	process.getuid?.() === 0 ? "root can write to a read-only directory"
	: process.platform === "win32" ? "chmod does not make a directory read-only on Windows"
	: false;
test("fileSink disables itself on a read-only directory", { skip: cannotLockDir }, () => {
	const root = mkdtempSync(join(tmpdir(), "autter-ro-"));
	const warnings = [];
	const original = console.warn;
	console.warn = (message) => warnings.push(message);
	try {
		mkdirSync(join(root, "locked"));
		chmodSync(join(root, "locked"), 0o500);
		const sink = fileSink({ dir: join(root, "locked", "runtime") });
		sink.start(context);
		sink.write(summary(1));
		sink.write(summary(2));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /local runtime files disabled \(EACCES/);
	} finally {
		console.warn = original;
		chmodSync(join(root, "locked"), 0o700);
		rmSync(root, { recursive: true, force: true });
	}
});

test("consoleSink: JSON lines identical to 1.4.0, pretty tree without ANSI off-TTY", () => {
	const lines = [];
	const json = consoleSink({ format: "json", write: (line) => lines.push(line) });
	json.write(summary(1));
	assert.deepEqual(JSON.parse(lines[0]), { ...summary(1).attributes, level: "info", message: "checkout 1" });
	const pretty = consoleSink({ format: "pretty", color: false, write: (line) => lines.push(line) });
	pretty.write(summary(2));
	const text = lines[1];
	assert.match(text, /INFO\s+POST \/checkout succeeded 200 12ms req=req-00000002/);
	assert.match(text, /steps\s+reserve ✓ 4ms/);
	assert.match(text, /log\s+\+1ms info applied coupon/);
	assert.match(text, /context\s+cart\.items=2/);
	assert.equal(text.includes("\u001b["), false);
	const colored = consoleSink({ format: "pretty", color: true, write: (line) => lines.push(line) });
	colored.write(summary(3));
	assert.ok(lines[2].includes("\u001b["));
});

test("otlpSink retries 503 and 429 after Retry-After within the flush; a 401 is tried once", async (t) => {
	const answers = [];
	const at = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			at.push(Date.now());
			const [status, headers] = answers.shift() ?? [202, {}];
			res.writeHead(status, headers).end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const endpoint = `http://127.0.0.1:${server.address().port}`;

	// The ingester's answer while its key validator is down, then back.
	answers.push([503, { "retry-after": "1" }], [429, {}], [202, {}]);
	const sink = otlpSink();
	sink.start({ ...context, endpoint });
	sink.write(summary(1));
	await sink.flush();
	assert.equal(at.length, 3);
	assert.ok(at[1] - at[0] >= 950, `waited for Retry-After (${at[1] - at[0]} ms)`);
	assert.ok(at[2] - at[1] >= 900, `then backed off (${at[2] - at[1]} ms)`);
	assert.equal(sink.buffered(), 0);

	// A refused key: one attempt, and the batch is dropped, not kept for a
	// later flush (it would be refused again, forever).
	at.length = 0;
	answers.push([401, {}]);
	const refused = otlpSink();
	refused.start({ ...context, endpoint });
	refused.write(summary(2));
	await assert.rejects(refused.flush(), /\(401\)/);
	assert.equal(at.length, 1);
	assert.equal(refused.buffered(), 0);
	await refused.shutdown?.().catch(() => {});
	await sink.shutdown?.();
});

/** A local ingester answering every POST with `status(count)`; records each batch's size. */
async function ingesterAnswering(t, status) {
	const posts = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const count = JSON.parse(Buffer.concat(chunks)).resourceLogs[0].scopeLogs[0].logRecords.length;
			posts.push(count);
			res.writeHead(status(count), { "content-type": "application/json" }).end(JSON.stringify({ error: "refused" }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	return { endpoint: `http://127.0.0.1:${server.address().port}`, posts };
}

/** console.warn lines while the test runs. */
function captureWarnings(t) {
	const warnings = [];
	const original = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	t.after(() => {
		console.warn = original;
	});
	return warnings;
}

test("otlpSink with a revoked key (401): 1500 records, one batch sent, no resend loop, at most one drop warning", async (t) => {
	const ingester = await ingesterAnswering(t, () => 401);
	const warnings = captureWarnings(t);
	const sink = otlpSink();
	sink.start({ ...context, endpoint: ingester.endpoint });
	for (let i = 0; i < 1500; i++) sink.write(summary(i));
	await assert.rejects(sink.flush(), /\(401\)/);
	// Paused: what was queued is dropped, and what is written now is dropped quietly.
	for (let i = 0; i < 500; i++) sink.write(summary(i));
	assert.equal(sink.buffered(), 0);
	await sink.flush();
	await sink.flush();
	assert.equal(ingester.posts.length, 1, "the refused batch was not sent again");
	const dropWarnings = warnings.filter((line) => /log record\(s\) dropped/.test(line));
	assert.ok(dropWarnings.length <= 1, warnings.join("\n"));
	// The 500 records past the 1000-record buffer: one line, not 500.
	assert.match(dropWarnings[0] ?? "", /the log buffer was full/);
	await sink.shutdown();
});

test("otlpSink drops a batch refused with 400 instead of blocking the records behind it", async (t) => {
	const ingester = await ingesterAnswering(t, () => 400);
	captureWarnings(t);
	const sink = otlpSink();
	sink.start({ ...context, endpoint: ingester.endpoint });
	for (let i = 0; i < 120; i++) sink.write(summary(i));
	await sink.flush();
	// Batches of 50, 50 and 20, each tried once and dropped: nothing is left.
	assert.deepEqual(ingester.posts, [50, 50, 20]);
	assert.equal(sink.buffered(), 0);
	await sink.flush();
	assert.equal(ingester.posts.length, 3);
	await sink.shutdown();
});

test("otlpSink splits a batch refused with 413 and sends the halves", async (t) => {
	const ingester = await ingesterAnswering(t, (count) => (count > 12 ? 413 : 202));
	captureWarnings(t);
	const sink = otlpSink();
	sink.start({ ...context, endpoint: ingester.endpoint });
	for (let i = 0; i < 50; i++) sink.write(summary(i));
	await sink.flush();
	assert.equal(sink.buffered(), 0);
	const accepted = ingester.posts.filter((count) => count <= 12).reduce((a, b) => a + b, 0);
	assert.equal(accepted, 50, `every record arrived: ${ingester.posts.join(", ")}`);
	await sink.shutdown();
});
