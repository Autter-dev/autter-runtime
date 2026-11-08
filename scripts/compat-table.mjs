#!/usr/bin/env node
/**
 * Print, or with --write update, the compatibility table in
 * docs/COMPATIBILITY.md from packages/otlp-ingester/src/compat-manifest.json.
 * Needs `npm run build -w @autter/otlp-ingester` first.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compatTableMarkdown, withCompatTable } from "../packages/otlp-ingester/dist/compat-table.js";

const doc = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "COMPATIBILITY.md");
if (process.argv.includes("--write")) {
	writeFileSync(doc, withCompatTable(readFileSync(doc, "utf8")));
	console.log(`updated ${doc}`);
} else {
	console.log(compatTableMarkdown());
}
