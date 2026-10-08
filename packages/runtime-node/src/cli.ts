#!/usr/bin/env node
/**
 * `npx @autter/runtime-node doctor` — see doctor.ts.
 */
import { DOCTOR_USAGE, formatDoctorReport, parseDoctorArgs, runDoctor } from "./doctor.js";

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
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
