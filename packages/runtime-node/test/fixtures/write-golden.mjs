// One-off: writes golden-1.4.0-logs.json from a runtime-node 1.4.0 build.
// Kept for provenance only — do NOT rerun against a newer build.
//   node test/fixtures/write-golden.mjs <path-to-1.4.0-dist/index.js>
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runGoldenScenario } from "./golden-scenario.mjs";

const entry = process.argv[2];
if (!entry) throw new Error("usage: write-golden.mjs <1.4.0 dist/index.js>");
const sdk = await import(pathToFileURL(resolve(entry)).href);
const normalised = await runGoldenScenario(sdk);
writeFileSync(
	new URL("./golden-1.4.0-logs.json", import.meta.url),
	`${JSON.stringify(normalised, null, "\t")}\n`,
);
console.log("wrote golden-1.4.0-logs.json");
