import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consoleSink, fileSink } from "../dist/index.js";

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

test("fileSink disables itself on a read-only directory", { skip: process.getuid?.() === 0 }, () => {
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
