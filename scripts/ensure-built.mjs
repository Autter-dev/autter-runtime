#!/usr/bin/env node
// Build sibling workspace packages whose dist/ is missing, so a single
// package's `npm run build` works on a clean checkout (CI, review bots,
// `npm run build -w @autter/runtime-next`). Packages that are already built
// are skipped, so the root `npm run build`, which builds in dependency order,
// does no extra work.
//
// Usage (from a package's build script):
//   node ../../scripts/ensure-built.mjs runtime-core runtime-browser
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const name of process.argv.slice(2)) {
	const dist = join(root, "packages", name, "dist");
	if (existsSync(join(dist, "index.js")) && existsSync(join(dist, "index.d.ts"))) continue;
	console.log(`[ensure-built] building @autter/${name} (dist/ missing)`);
	const args = ["run", "build", "-w", `@autter/${name}`];
	const npmCli = process.env.npm_execpath;
	const result = npmCli
		? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: "inherit" })
		: spawnSync("npm", args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}
