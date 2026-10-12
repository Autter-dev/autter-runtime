#!/usr/bin/env node
/**
 * `npx @autter/runtime-node doctor` — see doctor.ts.
 */
import { SDK_IDENTITY } from "./compat.js";
import { DOCTOR_USAGE, formatDoctorReport, parseDoctorArgs, runDoctor } from "./doctor.js";

/** `autter-runtime --version` / `-v` / `version`: the installed SDK's name and version. */
export function versionLine(): string {
	return `${SDK_IDENTITY.name} ${SDK_IDENTITY.version}`;
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "--version" || command === "-v" || command === "version") {
		console.log(versionLine());
		return 0;
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
	const output = parsed.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report, { quiet: parsed.quiet });
	if (output) (report.exitCode === 0 ? console.log : console.error)(output);
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
