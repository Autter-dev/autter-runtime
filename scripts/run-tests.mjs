#!/usr/bin/env node
// Run a package's tests with `node --test` without relying on the shell to
// expand `test/*.test.mjs`: cmd.exe (what npm uses on Windows) passes the
// pattern through unexpanded, and Node 20's test runner does not expand
// globs itself (Node 21+ does). Run from the package directory (npm does).
//
//   node ../../scripts/run-tests.mjs                     every test/*.test.mjs
//   node ../../scripts/run-tests.mjs test/sinks.test.mjs  only these files
//   node ../../scripts/run-tests.mjs --test-concurrency=1 Node options pass through
//
// With npm: npm test -w @autter/runtime-node -- test/sinks.test.mjs
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const options = args.filter((arg) => arg.startsWith("-"));
let files = args.filter((arg) => !arg.startsWith("-"));
if (!files.length) {
	files = readdirSync("test")
		.filter((name) => name.endsWith(".test.mjs"))
		.sort()
		.map((name) => join("test", name));
}
if (!files.length) {
	console.error(`run-tests: no test/*.test.mjs in ${process.cwd()}`);
	process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...options, ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
