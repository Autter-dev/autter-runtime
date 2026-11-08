#!/usr/bin/env node
// npm audit of what installing our published packages gives a user: their
// production dependencies, resolved fresh from their package.json ranges the
// way `npm install @autter/runtime-node` resolves them. The workspace
// lockfile pins versions a user never gets, so auditing it alone misses a
// vulnerable range (runtime-node 1.9.1 shipped `@opentelemetry/*` ^0.57.1,
// 25 advisories, and nothing here noticed).
//
// Usage:
//   node scripts/audit-published.mjs              # the packages in this checkout (npm pack)
//   node scripts/audit-published.mjs --registry   # the versions on npm right now (`latest`)
//   AUDIT_LEVEL=critical node scripts/audit-published.mjs   # default: high
//   AUDIT_KEEP=1 node scripts/audit-published.mjs   # keep the temp project to inspect
//
// Exits non-zero when an advisory at or above the level reaches any of them.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = process.argv.includes("--registry");
const level = process.env.AUDIT_LEVEL || "high";

function npm(args, cwd) {
	const npmCli = process.env.npm_execpath;
	const result = npmCli && npmCli.endsWith(".js")
		? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" })
		: spawnSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Every public package (runtime-core is private and bundled).
const packages = readdirSync(join(root, "packages"))
	.map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) }))
	.filter(({ manifest }) => !manifest.private);

const work = mkdtempSync(join(tmpdir(), "autter-audit-"));
try {
	const dependencies = {};
	if (registry) {
		for (const { manifest } of packages) dependencies[manifest.name] = "latest";
	} else {
		for (const { manifest } of packages) {
			const packed = npm(["pack", "--ignore-scripts", "--json", "--pack-destination", work, "-w", manifest.name], root);
			if (packed.status !== 0) {
				console.error(packed.stderr || packed.stdout);
				throw new Error(`npm pack failed for ${manifest.name}`);
			}
			const [{ filename }] = JSON.parse(packed.stdout);
			dependencies[manifest.name] = `file:./${filename.replace(/^.*[\\/]/, "")}`;
		}
	}
	// Sibling packages (runtime-next → runtime-node) resolve to this checkout's
	// tarballs too, not to what is on npm, so a fix is checked before release.
	const overrides = registry ? undefined : { ...dependencies };
	writeFileSync(
		join(work, "package.json"),
		JSON.stringify({ name: "autter-published-audit", private: true, dependencies, ...(overrides ? { overrides } : {}) }, null, 2),
	);

	console.log(`Auditing ${registry ? "the npm `latest` of" : "this checkout's"} ${Object.keys(dependencies).join(", ")}`);
	const lock = npm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], work);
	if (lock.status !== 0) {
		console.error(lock.stderr || lock.stdout);
		throw new Error("npm could not resolve the published packages' dependencies");
	}
	const audit = npm(["audit", "--omit=dev", `--audit-level=${level}`], work);
	console.log(audit.stdout.trim() || audit.stderr.trim());
	if (audit.status !== 0) {
		console.error(`audit-published: advisories at or above "${level}" reach a published package (fix the ranges, then release).`);
		process.exitCode = 1;
	}
} finally {
	if (!process.env.AUDIT_KEEP) rmSync(work, { recursive: true, force: true });
	else console.log(`kept ${work}`);
}
