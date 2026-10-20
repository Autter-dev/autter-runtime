#!/usr/bin/env node
/**
 * `npx @autter/runtime-node doctor` — see doctor.ts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DOCTOR_USAGE, formatDoctorReport, parseDoctorArgs, runDoctor } from "./doctor.js";

/**
 * `autter-runtime sourcemaps …` belongs to @autter/runtime-cli, which ships a
 * bin with the same name; whichever one npm linked hands over to the other.
 */
function delegateToRuntimeCli(argv: string[]): number | null {
	try {
		const manifest = createRequire(join(process.cwd(), "package.json")).resolve("@autter/runtime-cli/package.json");
		const bin = (JSON.parse(readFileSync(manifest, "utf8")) as { bin?: Record<string, string> }).bin?.["autter-runtime"];
		if (!bin) return null;
		return spawnSync(process.execPath, [resolve(dirname(manifest), bin), ...argv], { stdio: "inherit" }).status ?? 1;
	} catch {
		return null;
	}
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "sourcemaps") {
		const code = delegateToRuntimeCli(argv);
		if (code !== null) return code;
		console.error("autter-runtime sourcemaps is part of @autter/runtime-cli: npm install -D @autter/runtime-cli");
		return 64;
	}
	if (command !== "doctor") {
		console.log(DOCTOR_USAGE);
		return command === undefined || command === "--help" || command === "-h" ? 0 : 64;
	}
	const parsed = parseDoctorArgs(rest);
	if ("help" in parsed) {
		console.log(DOCTOR_USAGE);
		return 0;
	}
	if ("error" in parsed) {
		console.error(`${parsed.error}\n\n${DOCTOR_USAGE}`);
		return 64;
	}
	const report = await runDoctor(parsed);
	console.log(parsed.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
	return report.exitCode;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		console.error("autter doctor failed:", err instanceof Error ? err.message : err);
		process.exitCode = 2;
	},
);
