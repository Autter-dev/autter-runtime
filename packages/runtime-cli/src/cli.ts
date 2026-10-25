#!/usr/bin/env node
/**
 * `autter-runtime` — readable stack traces for Autter Runtime.
 *
 *   autter-runtime sourcemaps setup [dir]
 *   autter-runtime sourcemaps inject <dir>
 *   autter-runtime sourcemaps upload <dir> --release <r>
 *   autter-runtime sourcemaps verify <dir>
 *
 * `@autter/runtime-node` ships a bin with the same name (`doctor`); each one
 * hands the other's commands over when both packages are installed, so it
 * doesn't matter which one npm linked.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { formatUploadSummary } from "./build.js";
import { findBundles, findMapFiles, removeSourceMaps } from "./files.js";
import { injectDir } from "./inject.js";
import { formatSetup, runSetup } from "./setup.js";
import { KEY_ADVICE, uploadDir, type UploadSummary } from "./upload.js";
import { formatVerify, verifyDir } from "./verify.js";

const USAGE = `autter-runtime — readable stack traces for Autter Runtime

Usage:
  autter-runtime sourcemaps setup [dir] [--dry-run] [--install] [--json]
  autter-runtime sourcemaps verify <dir> [--endpoint <url>] [--url-prefix <prefix>]
                [--ignore <glob>]... [--allow-maps] [--server] [--json]
  autter-runtime sourcemaps inject <dir> [--dry-run] [--json]
  autter-runtime sourcemaps upload <dir> [--release <r>] [--url-prefix <prefix>]
                [--endpoint <url>] [--concurrency <n>] [--delete-after-upload]
                [--no-sources-content] [--best-effort] [--dry-run] [--json]
  autter-runtime doctor ...      (provided by @autter/runtime-node)

setup   Wires source map upload into the project in [dir] (default "."):
        detects the build tool, package manager, CI and browser SDK, adds
        @autter/runtime-cli to devDependencies, adds the Vite/Rollup, webpack
        or Next.js plugin when the config is safe to edit (else a postbuild
        step), turns on hidden maps, and prints what is left to do by hand,
        including where to store AUTTER_RUNTIME_KEY. Never writes a key.
        Safe to re-run. Exit 0: all applied; 2: manual actions remain; 1: error.
verify  Checks a production build before deploy: every bundle has a debug
        id, no .map file is left, no sourceMappingURL points at a missing
        map, and (with AUTTER_RUNTIME_KEY) every bundle's map is on the
        ingester. Exit 0: ok (upload unverified without a key); 1: problems.
inject  Gives every .js/.mjs/.cjs bundle that has a source map a debug id
        derived from its bytes: a "//# debugId=" comment, a one-line snippet
        that registers it for the Autter SDKs (browser, Node and edge), and
        "debugId" in the .map. Works on browser and server output alike
        (Vite, webpack, Next.js, tsup, esbuild). Running it again changes
        nothing.
upload  Sends every map to <endpoint>/v1/sourcemaps with AUTTER_RUNTIME_KEY,
        in parallel, skipping maps the ingester already has. Each map carries
        the bundle's function scopes ("x_autter_scopes"), so stack frames are
        named after the function they are in, not the call site, and the
        original source of your own files ("sourcesContent", never your
        dependencies'), so issues show the lines around each frame.

Options:
  --release <r>          Default: $GITHUB_SHA, $VERCEL_GIT_COMMIT_SHA,
                         $CF_PAGES_COMMIT_SHA, $GIT_SHA, then git rev-parse HEAD
  --url-prefix <prefix>  Where <dir> is served from: "/" (default), "/static/",
                         or "https://cdn.example.com/app/". For server output,
                         any tail of the path the server runs it from
                         ("/dist/" for /app/dist/server.js) or "/"
  --endpoint <url>       Ingester base URL. Default: $AUTTER_ENDPOINT,
                         $AUTTER_RUNTIME_ENDPOINT, $OTEL_EXPORTER_OTLP_ENDPOINT,
                         then https://otlp.autter.dev
  --concurrency <n>      Parallel uploads (default 8)
  --delete-after-upload  Delete each .map once the ingester has it
  --no-sources-content   upload: send maps without your files' source (issues
                         then show no lines around a frame)
  --best-effort          For build scripts: never fail. Without a key, or when
                         the upload fails, report it and exit 0; with
                         --delete-after-upload, every .map under <dir> is then
                         deleted anyway, so a build never ships maps
  --install              setup: also run the package manager's install
  --ignore <glob>        verify: JS files that are not bundles (repeatable)
  --allow-maps           verify: report leftover .map files without failing
  --server               verify: <dir> is server output (tsup, esbuild, webpack
                         or Next server bundles): leftover maps are fine there
  --dry-run              Show what would change or be uploaded; write and send nothing
  --json                 Print the result as JSON
  -h, --help             Show this help
  -v, --version          Print the version

Environment:
  AUTTER_RUNTIME_KEY     Upload-only key (autter_rtu_…, recommended for CI: it
                         can only upload source maps) or the server key
                         (autter_rt_…, also works). Required by upload; used by
                         verify to check the ingester. Never a client key.`;

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
	"best-effort": { type: "boolean" },
	install: { type: "boolean" },
	ignore: { type: "string", multiple: true },
	"allow-maps": { type: "boolean" },
	server: { type: "boolean" },
	"no-sources-content": { type: "boolean" },
	"dry-run": { type: "boolean" },
	json: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

/** Which flags each action takes (json and help go everywhere). */
const ACTION_FLAGS: Record<string, string[]> = {
	setup: ["dry-run", "install"],
	inject: ["dry-run"],
	upload: ["release", "url-prefix", "endpoint", "concurrency", "delete-after-upload", "no-sources-content", "best-effort", "dry-run"],
	verify: ["endpoint", "url-prefix", "release", "ignore", "allow-maps", "server"],
};

async function sourcemaps(argv: string[]): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, allowPositionals: true, options: SOURCEMAPS_OPTIONS });
	} catch (err) {
		console.error(`${(err as Error).message}\n\n${USAGE}`);
		return 64;
	}
	const { values, positionals } = parsed;
	const [action, dirArg, ...extra] = positionals;
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	const known = action !== undefined && action in ACTION_FLAGS;
	const dir = dirArg ?? (action === "setup" ? "." : undefined);
	if (!known || !dir || extra.length) {
		console.error(`${action && !known ? `unknown command: sourcemaps ${action}\n\n` : ""}${USAGE}`);
		return 64;
	}
	const allowed = new Set([...ACTION_FLAGS[action]!, "json", "help"]);
	const stray = Object.keys(values).filter((flag) => !allowed.has(flag));
	if (stray.length) {
		console.error(`autter-runtime: sourcemaps ${action} does not take --${stray.join(", --")}\n\n${USAGE}`);
		return 64;
	}
	if (!existsSync(dir)) {
		console.error(`autter-runtime: ${dir} does not exist`);
		return action === "setup" ? 1 : 64;
	}
	const dryRun = Boolean(values["dry-run"]);

	if (action === "setup") {
		try {
			const result = runSetup(dir, { dryRun, install: Boolean(values.install), installOutput: values.json ? "stderr" : "inherit" });
			if (values.json) console.log(JSON.stringify(result, null, 2));
			else for (const line of formatSetup(result)) console.log(line);
			return result.exitCode;
		} catch (err) {
			console.error(`autter-runtime: sourcemaps setup: ${err instanceof Error ? err.message : String(err)}`);
			return 1;
		}
	}

	if (action === "verify") {
		const result = await verifyDir(dir, {
			endpoint: values.endpoint,
			urlPrefix: values["url-prefix"],
			release: values.release,
			ignore: values.ignore,
			allowMaps: Boolean(values["allow-maps"]),
			server: Boolean(values.server),
		});
		if (values.json) console.log(JSON.stringify(result, null, 2));
		else for (const line of formatVerify(result)) console.log(line);
		return result.ok ? 0 : 1;
	}

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
	const deleteAfterUpload = Boolean(values["delete-after-upload"]);
	const bestEffort = Boolean(values["best-effort"]);
	let summary: UploadSummary | null = null;
	let error: string | null = null;
	const run = () =>
		uploadDir(dir, {
			release: values.release,
			urlPrefix: values["url-prefix"],
			endpoint: values.endpoint,
			concurrency,
			dryRun,
			deleteAfterUpload,
			...(values["no-sources-content"] ? { sourcesContent: false } : {}),
			log: (line) => console.error(line),
		});
	if (!bestEffort) summary = await run();
	else if (!dryRun && !(process.env.AUTTER_RUNTIME_KEY ?? "").trim()) error = `AUTTER_RUNTIME_KEY is not set, so nothing was uploaded (${KEY_ADVICE})`;
	else {
		try {
			summary = await run();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}
	let removedMaps: string[] = [];
	if (bestEffort && deleteAfterUpload && !dryRun) {
		// Whatever happened above, no map stays behind to be deployed.
		const owners = new Map((await findBundles(dir)).map((bundle) => [bundle.map, bundle.js]));
		removedMaps = (await removeSourceMaps(await findMapFiles(dir), owners)).map((map) => relative(resolve(dir), map).split(sep).join("/"));
	}
	if (values.json) {
		console.log(JSON.stringify({ ...(summary ?? { uploaded: [], skipped: [], failed: [] }), ...(bestEffort ? { error, removedMaps } : {}) }, null, 2));
	} else {
		if (summary) {
			if (!summary.uploaded.length && !summary.skipped.length && !summary.failed.length) {
				console.log(`no .js/.mjs/.cjs bundles with source maps under ${dir}`);
			}
			for (const line of formatUploadSummary(summary)) console.log(line);
		}
		if (error) console.error(`autter-runtime: ${error}`);
		if (removedMaps.length) {
			const why = error ? "the upload did not run" : summary?.failed.length ? `${summary.failed.length} could not be uploaded` : "they were uploaded";
			console.log(`removed ${removedMaps.length} source map(s) under ${dir}, so they are not deployed: ${why}`);
		}
		if (bestEffort && (error || summary?.failed.length)) console.error("autter-runtime: --best-effort: the build continues");
	}
	return bestEffort ? 0 : summary?.failed.length ? 1 : 0;
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
