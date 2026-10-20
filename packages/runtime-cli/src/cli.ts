#!/usr/bin/env node
/**
 * `autter-runtime` — readable stack traces for Autter Runtime.
 *
 *   autter-runtime sourcemaps inject <dir>
 *   autter-runtime sourcemaps upload <dir> --release <r>
 *
 * `@autter/runtime-node` ships a bin with the same name (`doctor`); each one
 * hands the other's commands over when both packages are installed, so it
 * doesn't matter which one npm linked.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatUploadSummary } from "./build.js";
import { injectDir } from "./inject.js";
import { uploadDir } from "./upload.js";

const USAGE = `autter-runtime — readable stack traces for Autter Runtime

Usage:
  autter-runtime sourcemaps inject <dir> [--dry-run]
  autter-runtime sourcemaps upload <dir> [--release <r>] [--url-prefix <prefix>]
                [--endpoint <url>] [--concurrency <n>] [--delete-after-upload] [--dry-run]
  autter-runtime doctor ...      (provided by @autter/runtime-node)

inject  Gives every .js/.mjs/.cjs bundle that has a source map a debug id
        derived from its bytes: a "//# debugId=" comment, a one-line snippet
        that registers it for @autter/runtime-browser, and "debugId" in the
        .map. Running it again changes nothing.
upload  Sends every map to <endpoint>/v1/sourcemaps with AUTTER_RUNTIME_KEY,
        in parallel, skipping maps the ingester already has. Each map carries
        the bundle's function scopes ("x_autter_scopes"), so stack frames are
        named after the function they are in, not the call site.

Options:
  --release <r>          Default: $GITHUB_SHA, $VERCEL_GIT_COMMIT_SHA,
                         $CF_PAGES_COMMIT_SHA, $GIT_SHA, then git rev-parse HEAD
  --url-prefix <prefix>  Where <dir> is served from: "/" (default), "/static/",
                         or "https://cdn.example.com/app/"
  --endpoint <url>       Ingester base URL. Default: $AUTTER_ENDPOINT,
                         $AUTTER_RUNTIME_ENDPOINT, $OTEL_EXPORTER_OTLP_ENDPOINT,
                         then https://otlp.autter.dev
  --concurrency <n>      Parallel uploads (default 8)
  --delete-after-upload  Delete each .map once the ingester has it
  --dry-run              Show what would change or be uploaded; write and send nothing
  --json                 Print the result as JSON
  -h, --help             Show this help
  -v, --version          Print the version

Environment:
  AUTTER_RUNTIME_KEY     Server ingest key (autter_rt_…), required by upload`;

function ownVersion(): string {
	try {
		return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
	} catch {
		return "unknown";
	}
}

/** Run another package's `autter-runtime` bin, installed in the project. */
function delegate(pkg: string, args: string[]): number | null {
	let manifest: string;
	try {
		manifest = createRequire(join(process.cwd(), "package.json")).resolve(`${pkg}/package.json`);
	} catch {
		return null;
	}
	const bin = (JSON.parse(readFileSync(manifest, "utf8")) as { bin?: Record<string, string> | string }).bin;
	const relative = typeof bin === "string" ? bin : bin?.["autter-runtime"];
	if (!relative) return null;
	const script = resolve(dirname(manifest), relative);
	if (!existsSync(script)) return null;
	const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
	return result.status ?? 1;
}

const SOURCEMAPS_OPTIONS = {
	release: { type: "string" },
	"url-prefix": { type: "string" },
	endpoint: { type: "string" },
	concurrency: { type: "string" },
	"delete-after-upload": { type: "boolean" },
	"dry-run": { type: "boolean" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

async function sourcemaps(argv: string[]): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, allowPositionals: true, options: SOURCEMAPS_OPTIONS });
	} catch (err) {
		console.error(`${(err as Error).message}\n\n${USAGE}`);
		return 64;
	}
	const { values, positionals } = parsed;
	const [action, dir, ...extra] = positionals;
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if ((action !== "inject" && action !== "upload") || !dir || extra.length) {
		console.error(`${action && action !== "inject" && action !== "upload" ? `unknown command: sourcemaps ${action}\n\n` : ""}${USAGE}`);
		return 64;
	}
	if (!existsSync(dir)) {
		console.error(`autter-runtime: ${dir} does not exist`);
		return 64;
	}
	const dryRun = Boolean(values["dry-run"]);

	if (action === "inject") {
		const results = await injectDir(dir, { dryRun });
		if (values.json) {
			console.log(JSON.stringify(results.map(({ path, debugId, status }) => ({ path, debugId, status })), null, 2));
		} else {
			for (const r of results) {
				const what = r.status === "invalid-map" ? "skipped (map is not valid JSON)" : r.status === "injected" ? (dryRun ? "would inject" : "injected") : "unchanged";
				console.log(`${what} ${r.path}${r.debugId ? ` ${r.debugId}` : ""}`);
			}
			const injected = results.filter((r) => r.status === "injected").length;
			console.log(
				results.length
					? `${results.length} bundle(s) with source maps: ${injected} ${dryRun ? "would be injected" : "injected"}, ${results.length - injected} unchanged`
					: `no .js/.mjs/.cjs bundles with source maps under ${dir}`,
			);
		}
		return results.some((r) => r.status === "invalid-map") ? 1 : 0;
	}

	const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
	if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
		console.error("autter-runtime: --concurrency must be a positive integer");
		return 64;
	}
	const summary = await uploadDir(dir, {
		release: values.release,
		urlPrefix: values["url-prefix"],
		endpoint: values.endpoint,
		concurrency,
		dryRun,
		deleteAfterUpload: Boolean(values["delete-after-upload"]),
		log: (line) => console.error(line),
	});
	if (values.json) console.log(JSON.stringify(summary, null, 2));
	else {
		if (!summary.uploaded.length && !summary.skipped.length && !summary.failed.length) {
			console.log(`no .js/.mjs/.cjs bundles with source maps under ${dir}`);
		}
		for (const line of formatUploadSummary(summary)) console.log(line);
	}
	return summary.failed.length ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "-v" || command === "--version") {
		console.log(ownVersion());
		return 0;
	}
	if (command === undefined || command === "-h" || command === "--help" || command === "help") {
		console.log(USAGE);
		return 0;
	}
	if (command === "sourcemaps") return sourcemaps(rest);
	if (command === "doctor") {
		const code = delegate("@autter/runtime-node", argv);
		if (code !== null) return code;
		console.error("autter-runtime doctor is part of @autter/runtime-node: npx @autter/runtime-node doctor");
		return 64;
	}
	console.error(`unknown command: ${command}\n\n${USAGE}`);
	return 64;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`autter-runtime: ${message}`);
		process.exitCode = 2;
	},
);
