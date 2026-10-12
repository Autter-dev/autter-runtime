import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDoctorReport, parseDoctorArgs } from "../dist/index.js";

const compatible = {
	endpoint: "https://otlp.example.test",
	sdks: [{ name: "@autter/runtime-node", version: "1.5.0" }],
	ingester: { version: "1.5.0", schema: null },
	features: [{ id: "logs", title: "Logs", status: "ok" }],
	issues: [],
	exitCode: 0,
};

test("--quiet and -q are parsed, and cannot be combined with --json", () => {
	assert.deepEqual(parseDoctorArgs(["--quiet"], {}), { quiet: true });
	assert.deepEqual(parseDoctorArgs(["-q", "--endpoint", "http://x"], {}), { quiet: true, endpoint: "http://x" });
	assert.deepEqual(parseDoctorArgs(["--json", "--quiet"], {}), { error: "--json and --quiet cannot be combined" });
});

test("a quiet report is empty when everything is compatible", () => {
	assert.equal(formatDoctorReport(compatible, { quiet: true }), "");
	assert.match(formatDoctorReport(compatible), /Compatible\./);
});

test("a quiet report lists only the problems", () => {
	const broken = {
		...compatible,
		key: "rejected",
		features: [{ id: "traces", title: "Traces", status: "incompatible" }],
		issues: [{ message: "ingester 1.3.0 is older than the SDK expects" }],
		exitCode: 1,
	};
	assert.equal(
		formatDoctorReport(broken, { quiet: true }),
		[
			"autter doctor: ingest key rejected (401)",
			"autter doctor: feature traces is incompatible",
			"autter doctor: ingester 1.3.0 is older than the SDK expects",
		].join("\n"),
	);
	const unreachable = { ...compatible, ingester: null, ingesterError: "ECONNREFUSED", features: [], exitCode: 2 };
	assert.equal(
		formatDoctorReport(unreachable, { quiet: true }),
		"autter doctor: ingester unreachable at https://otlp.example.test (ECONNREFUSED)",
	);
});

test("the CLI prints its version and exits 0", async () => {
	const { spawnSync } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const { readFileSync } = await import("node:fs");
	const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
	const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const flag of ["--version", "-v", "version"]) {
		const run = spawnSync(process.execPath, [cli, flag], { encoding: "utf8" });
		assert.equal(run.status, 0, flag);
		assert.equal(run.stdout.trim(), `@autter/runtime-node ${version}`);
	}
});
