#!/usr/bin/env node
/**
 * Source maps end to end, against a real ClickHouse: a minified browser app
 * built with the Autter plugins, its maps uploaded with an upload-only key,
 * an error thrown in headless Chromium, and the stored occurrence read back.
 *
 *   1. Four builds of the same code, each minified differently and under
 *      its own release: Vite 8 (Oxc minifier), Vite 8 with terser (which
 *      inlines single-use functions as nameless expressions), webpack 5
 *      (terser, its own module wrapper), and Next.js 16 with Turbopack
 *      (SWC, which inlines applyDiscount and computeTotal into the click
 *      handler). Each build's plugin injects debug ids and uploads its maps
 *      with an upload-only `autter_rtu_` key; `autter-runtime sourcemaps
 *      verify` must pass and no map may be left in the output.
 *   2. Each build is served (a static server, or `next start`) and loaded
 *      in Chromium with @autter/runtime-browser; a click throws a TypeError
 *      in src/checkout/pricing.js.
 *   3. The stored occurrence must name the original files, lines and
 *      functions (applyDiscount → computeTotal → onCheckoutClick; only
 *      applyDiscount for the inlining Next.js build), with source context
 *      and no unresolved in-app frame.
 *   4. One issue: the three builds that keep every frame share a frames-v3
 *      fingerprint, all four share a cause-v1 fingerprint, and the
 *      platform's issue resolution (groupIntoIssues) puts all four in one
 *      issue.
 *   5. A fifth build without a key (no maps uploaded): `verify` fails, the
 *      occurrence's frames stay minified, are counted unresolved, say which
 *      bundle's map is missing, and land in another issue.
 *
 * Needs `npm run build` at the repo root, `npm ci` here, a Chromium for
 * playwright-core (`npx playwright-core install chromium`, or
 * E2E_CHROME_CHANNEL=chrome to use an installed Chrome), and a ClickHouse
 * whose admin can manage access (as for packages/otlp-ingester/scripts/
 * clickhouse-e2e.mjs):
 *
 *   CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_ADMIN_PASSWORD=e2e node e2e/sourcemaps/run.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const INGESTER_ENTRY = join(REPO, "packages", "otlp-ingester", "dist", "index.js");
const CLI = join(HERE, "node_modules", "@autter", "runtime-cli", "dist", "cli.js");
const CH = (process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123").replace(/\/$/, "");
const ADMIN_USER = process.env.CLICKHOUSE_ADMIN_USER ?? "default";
const ADMIN_PASSWORD = process.env.CLICKHOUSE_ADMIN_PASSWORD ?? "";
const RUN = Date.now().toString(36);
const DB = `autter_sm_e2e_${RUN}`;
const USER = `autter_sm_e2e_${process.pid}`;
const PASSWORD = "e2e-ingester-pass";
const UPLOAD_KEY = "autter_rtu_e2e_upload_key";
const CLIENT_KEY = "autter_rtc_e2e_client_key";
const STATE = mkdtempSync(join(tmpdir(), "autter-sm-e2e-"));
const PORT = Number(process.env.E2E_INGESTER_PORT ?? 14328);

let failures = 0;
function check(condition, message, detail) {
	if (condition) return console.log(`  ✔ ${message}`);
	failures += 1;
	console.error(`  ✖ ${message}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`}`);
	throw new Error(message);
}

async function sql(query) {
	const res = await fetch(`${CH}/`, {
		method: "POST",
		headers: { "x-clickhouse-user": ADMIN_USER, "x-clickhouse-key": ADMIN_PASSWORD },
		body: /^\s*(SELECT|SHOW)/i.test(query) ? `${query} FORMAT JSONEachRow` : query,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`ClickHouse ${res.status} for ${query}: ${text.trim()}`);
	return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

/** Run a command; resolves with its exit code and output (never rejects on a non-zero exit). */
function run(command, args, env = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: HERE, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (d) => (output += d));
		child.stderr.on("data", (d) => (output += d));
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, output }));
	});
}

const children = new Set();

async function startIngester(origins) {
	const logs = [];
	const child = spawn(process.execPath, [INGESTER_ENTRY], {
		env: {
			...process.env,
			PORT: String(PORT),
			CLICKHOUSE_URL: CH,
			CLICKHOUSE_USER: USER,
			CLICKHOUSE_PASSWORD: PASSWORD,
			CLICKHOUSE_DATABASE: DB,
			AUTTER_INGEST_KEYS: JSON.stringify([
				// What CI holds: an upload-only key (source maps, nothing else).
				{ key: UPLOAD_KEY, orgId: "org-sm-e2e", repositoryId: "repo-sm-e2e" },
				// What the page holds: a publishable browser key for these origins.
				{ key: CLIENT_KEY, orgId: "org-sm-e2e", repositoryId: "repo-sm-e2e", scope: "client", allowedOrigins: origins },
			]),
			AUTTER_SINK_URL: "",
			INSERT_RECEIPTS_FILE: join(STATE, "insert-receipts.log"),
			TRUST_PROXY: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (d) => logs.push(String(d)));
	child.stderr.on("data", (d) => logs.push(String(d)));
	const ingester = { url: `http://127.0.0.1:${PORT}`, logs, child };
	children.add(ingester);
	for (let i = 0; i < 150; i++) {
		if (child.exitCode !== null) throw new Error(`ingester exited: ${logs.join("")}`);
		try {
			if ((await fetch(`${ingester.url}/livez`)).ok) return ingester;
		} catch {
			// not listening yet
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`ingester never became ready: ${logs.join("")}`);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

/** A static server for one build's output directory. */
async function serve() {
	let root = null;
	const server = createServer((req, res) => {
		const path = new URL(req.url, "http://x").pathname;
		const file = join(root ?? STATE, path === "/" ? "index.html" : path);
		if (!root || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
	});
	server.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		setRoot: (dir) => (root = dir),
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/** Every file under `dir`, relative. */
function filesUnder(dir) {
	return readdirSync(dir, { recursive: true }).map(String).filter((name) => statSync(join(dir, name)).isFile());
}

/** 1-based line of the first line of `file` (relative to this directory) containing `marker`. */
function lineOf(file, marker) {
	const lines = readFileSync(join(HERE, file), "utf8").split("\n");
	const index = lines.findIndex((line) => line.includes(marker));
	if (index < 0) throw new Error(`${marker} not in ${file}`);
	return index + 1;
}

/**
 * The in-app frames a build's occurrence must have, innermost first, as
 * stored: project-relative paths. Turbopack's project is the repository
 * (the SDK is linked from packages/), so the Next.js paths start with
 * e2e/sourcemaps/.
 */
function expectedFrames(spec) {
	const prefix = spec.tool === "next" ? "e2e/sourcemaps/" : "";
	const main = spec.tool === "next" ? "next-app/app/main.js" : "src/main.js";
	return [
		{ function: "applyDiscount", file: `${prefix}src/checkout/pricing.js`, line: lineOf("src/checkout/pricing.js", "rule.amount"), context: "rule.amount" },
		{ function: "computeTotal", file: `${prefix}src/checkout/cart.js`, line: lineOf("src/checkout/cart.js", "applyDiscount(order") },
		{ function: "onCheckoutClick", file: `${prefix}${main}`, line: lineOf(main, "computeTotal(order)") },
	];
}

const BUILDS = [
	{ name: "vite-oxc", tool: "vite", minify: "oxc", key: true },
	{ name: "vite-terser", tool: "vite", minify: "terser", key: true },
	{ name: "webpack", tool: "webpack", key: true },
	// Next.js 16 with Turbopack (its default), served by `next start`. Its
	// minifier (SWC) inlines applyDiscount and computeTotal into
	// onCheckoutClick, so the browser's stack has one in-app frame: no source
	// map can bring the inlined calls back.
	{ name: "next", tool: "next", key: true, inlines: true },
	// No key: the plugin turns no maps on and uploads nothing.
	{ name: "vite-no-maps", tool: "vite", minify: "oxc", key: false },
];

/** A port nothing listens on right now (for `next start`). */
async function freePort() {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await new Promise((resolve) => probe.once("listening", resolve));
	const { port } = probe.address();
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

/** `next start` for the Next.js build; resolves once it answers. */
async function startNext(port) {
	const logs = [];
	const child = spawn(process.execPath, [join(HERE, "node_modules", "next", "dist", "bin", "next"), "start", "next-app", "-p", String(port), "-H", "127.0.0.1"], {
		cwd: HERE,
		env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (d) => logs.push(String(d)));
	child.stderr.on("data", (d) => logs.push(String(d)));
	const origin = `http://127.0.0.1:${port}`;
	const next = { url: `${origin} (next start)`, logs, child };
	children.add(next);
	for (let i = 0; i < 150; i++) {
		if (child.exitCode !== null) throw new Error(`next start exited: ${logs.join("")}`);
		try {
			if ((await fetch(origin)).ok) return { origin, setRoot: () => {}, close: async () => child.kill() };
		} catch {
			// not listening yet
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`next start never answered: ${logs.join("")}`);
}

async function build(spec, ingester) {
	const outDir = `dist/${spec.name}`;
	const release = `sm-e2e-${RUN}-${spec.name}`;
	const env = {
		AUTTER_RELEASE: release,
		AUTTER_ENDPOINT: ingester.url,
		AUTTER_RUNTIME_KEY: spec.key ? UPLOAD_KEY : "",
		E2E_OUT_DIR: outDir,
		...(spec.minify ? { E2E_MINIFY: spec.minify } : {}),
	};
	const result =
		spec.tool === "vite"
			? await run(process.execPath, [join(HERE, "node_modules", "vite", "bin", "vite.js"), "build"], env)
			: spec.tool === "next"
				? await run(process.execPath, [join(HERE, "node_modules", "next", "dist", "bin", "next"), "build", "next-app"], { ...env, NEXT_TELEMETRY_DISABLED: "1" })
				: await run(process.execPath, [join(HERE, "build-webpack.mjs")], env);
	if (result.code !== 0) throw new Error(`${spec.name} build failed:\n${result.output}`);
	if (spec.tool === "next") {
		// What the browser loads (and `verify` checks) is .next/static; no
		// map may be left anywhere in .next (server output included).
		const distDir = join(HERE, "next-app", ".next");
		return { ...spec, release, dir: join(distDir, "static"), mapsDir: distDir, output: result.output };
	}
	const dir = join(HERE, outDir);
	return { ...spec, release, dir, mapsDir: dir, output: result.output };
}

/** Load the build in Chromium, click, and wait for the SDK's report to be accepted. */
async function throwInBrowser(browser, server, ingester) {
	const page = await browser.newPage();
	const pageErrors = [];
	page.on("pageerror", (err) => pageErrors.push(err.message));
	const params = new URLSearchParams({ endpoint: `${ingester.url}/v1/browser`, key: CLIENT_KEY });
	await page.goto(`${server.origin}/?${params}`);
	await page.waitForSelector("body[data-ready=true]", { timeout: 10_000 });
	const reported = page.waitForResponse((res) => res.url().startsWith(`${ingester.url}/v1/browser`) && res.request().method() === "POST", { timeout: 15_000 });
	await page.click("#checkout");
	const response = await reported;
	const status = response.status();
	await page.close();
	return { status, pageErrors };
}

async function storedOccurrence(release) {
	const until = Date.now() + 20_000;
	while (Date.now() < until) {
		const rows = await sql(
			`SELECT release, error_type, message, frames, fingerprint, fingerprints, in_app_frames_resolved, in_app_frames_unresolved
			 FROM ${DB}.runtime_error_occurrences WHERE service = 'sourcemaps-e2e' AND release = '${release}'`,
		);
		if (rows.length > 0) return { ...rows[0], frames: rows[0].frames ? JSON.parse(rows[0].frames) : [] };
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return null;
}

/**
 * The platform's issue resolution for these candidates (autter-monorepo
 * backend/src/lib/runtime-issue-identity.ts, resolveIssueIdentities, with
 * cause-v1 grouping live, its default): the first of frames-v3 and
 * message-v1 that already has an issue; else the issue the cause-v1 id is an
 * alias of; else a new issue keyed by frames-v3, which also claims the
 * cause-v1 id as an alias. Returns an issue number per occurrence.
 */
function groupIntoIssues(occurrences) {
	const issues = new Map();
	let count = 0;
	return occurrences.map(([framesV3, messageV1, causeV1]) => {
		for (const fingerprint of [framesV3, messageV1]) if (issues.has(fingerprint)) return issues.get(fingerprint);
		if (causeV1 && issues.has(causeV1)) return issues.get(causeV1);
		const issue = ++count;
		issues.set(framesV3, issue);
		if (causeV1) issues.set(causeV1, issue);
		return issue;
	});
}

function summary(frames) {
	return frames.map((f) => `${f.inApp ? "" : "(not in app) "}${f.function ?? "<anonymous>"} ${f.filename}:${f.lineno}:${f.colno}${f.resolved ? "" : " [unresolved]"}`);
}

async function main() {
	const [{ v: version }] = await sql("SELECT version() AS v");
	console.log(`ClickHouse ${CH} ${version}, database ${DB}`);
	await sql(`DROP USER IF EXISTS ${USER}`);
	await sql(`CREATE USER ${USER} IDENTIFIED WITH plaintext_password BY '${PASSWORD}'`);
	await sql(`GRANT CREATE DATABASE ON ${DB}.* TO ${USER}`);
	await sql(`GRANT ALL ON ${DB}.* TO ${USER}`);
	await sql(`GRANT SELECT ON system.* TO ${USER}`);

	const servers = await Promise.all(BUILDS.map((spec) => (spec.tool === "next" ? freePort() : serve())));
	const origins = servers.map((s) => (typeof s === "number" ? `http://127.0.0.1:${s}` : s.origin));
	const ingester = await startIngester(origins);
	console.log(`ingester ${ingester.url} (upload key ${UPLOAD_KEY.slice(0, 11)}…, client key for ${servers.length} origins)`);

	const browser = await chromium.launch(process.env.E2E_CHROME_CHANNEL ? { channel: process.env.E2E_CHROME_CHANNEL } : {});
	const results = [];
	try {
		for (const [index, spec] of BUILDS.entries()) {
			console.log(`\n— ${spec.name}: ${spec.tool}${spec.minify ? ` (${spec.minify})` : ""}, ${spec.key ? "with" : "without"} an upload key`);
			const built = await build(spec, ingester);
			const files = filesUnder(built.dir);
			const bundles = files.filter((f) => f.endsWith(".js"));
			check(bundles.length > 0, `built ${bundles.length > 4 ? `${bundles.length} chunks` : bundles.join(", ")}`);
			const leftover = filesUnder(built.mapsDir).filter((f) => f.endsWith(".map"));
			check(leftover.length === 0, "no .map file left in the output", leftover);
			// The chunk with the checkout code.
			const appBundle = bundles.find((f) => readFileSync(join(built.dir, f), "utf8").includes("discounts"));
			check(appBundle !== undefined, `the checkout code is in ${appBundle}`);
			const bundle = readFileSync(join(built.dir, appBundle), "utf8");
			check(!bundles.some((f) => /sourceMappingURL=/.test(readFileSync(join(built.dir, f), "utf8"))), "no bundle points at a map (hidden maps)");
			const verify = await run(process.execPath, [CLI, "sourcemaps", "verify", built.dir, "--json"], {
				AUTTER_RUNTIME_KEY: spec.key ? UPLOAD_KEY : "",
				AUTTER_ENDPOINT: ingester.url,
			});
			let report = null;
			try {
				report = JSON.parse(verify.output.slice(verify.output.indexOf("{")));
			} catch {
				report = null;
			}
			if (spec.key) {
				check(/debugId=[0-9a-f-]{36}/.test(bundle), "the bundle carries a debug id");
				check(verify.code === 0 && report?.ok === true, "`sourcemaps verify` passes: debug ids injected, maps on the ingester", verify.output);
			} else {
				check(verify.code === 1 && report?.ok === false, "`sourcemaps verify` fails: the bundles have no debug id and no map was uploaded", verify.output);
			}

			const server = typeof servers[index] === "number" ? await startNext(servers[index]) : servers[index];
			if (typeof servers[index] === "number") servers[index] = server;
			server.setRoot(built.dir);
			const { status, pageErrors } = await throwInBrowser(browser, server, ingester);
			check(status >= 200 && status < 300, `the browser SDK's report was accepted (HTTP ${status})`);
			check(pageErrors.some((m) => /amount/.test(m)), "the page threw the TypeError", pageErrors);
			const occurrence = await storedOccurrence(built.release);
			check(occurrence !== null, "the occurrence is stored in ClickHouse");
			console.log(`    frames as stored:\n      ${summary(occurrence.frames).join("\n      ")}`);
			results.push({ ...built, occurrence });

			const inApp = occurrence.frames.filter((f) => f.inApp);
			if (spec.key) {
				check(occurrence.error_type === "TypeError" && /amount/.test(occurrence.message), "error type and message", occurrence);
				const all = expectedFrames(spec);
				// An inlining build keeps only the innermost frame, which must
				// still be named after the function the code is in.
				const expected = spec.inlines ? all.slice(0, 1) : all;
				for (const [i, want] of expected.entries()) {
					const got = inApp[i];
					check(
						got?.resolved === true && got.function === want.function && got.filename === want.file && got.lineno === want.line,
						`in-app frame ${i}: ${want.function} at ${want.file}:${want.line}`,
						got,
					);
				}
				check(inApp[0].contextLine?.includes(expected[0].context), "the innermost frame carries its source line", inApp[0].contextLine);
				check(Number(occurrence.in_app_frames_unresolved) === 0 && Number(occurrence.in_app_frames_resolved) >= expected.length, "no in-app frame left unresolved", {
					resolved: occurrence.in_app_frames_resolved,
					unresolved: occurrence.in_app_frames_unresolved,
				});
			} else {
				check(inApp.length > 0 && inApp.every((f) => f.resolved !== true), "without maps, the frames stay minified", inApp);
				check(Number(occurrence.in_app_frames_unresolved) > 0, "and are counted unresolved", occurrence.in_app_frames_unresolved);
				const missing = inApp[0].symbolication;
				check(
					missing?.status === "missing_map" && missing.bundle === `/${appBundle}` && missing.release === built.release,
					"the unresolved frame says which bundle's map is missing, for which release",
					inApp[0],
				);
			}
		}

		console.log("\n— one issue across builds");
		// Stored candidates of an uncoded error: [frames-v3, message-v1, cause-v1].
		const resolved = results.filter((r) => r.key);
		const candidates = Object.fromEntries(results.map((r) => [r.name, r.occurrence.fingerprints]));
		const whole = resolved.filter((r) => !r.inlines);
		const framesV3 = whole.map((r) => r.occurrence.fingerprints[0]);
		check(
			framesV3.every((fp) => fp && fp === framesV3[0]),
			`${whole.map((r) => r.name).join(", ")} share one frames-v3 fingerprint (${framesV3[0]})`,
			candidates,
		);
		const causeV1 = resolved.map((r) => r.occurrence.fingerprints[2]);
		check(
			causeV1.every((fp) => fp && fp === causeV1[0]),
			`${resolved.map((r) => r.name).join(", ")} share one cause-v1 fingerprint (${causeV1[0]}): the innermost frame reads applyDiscount@pricing.js, inlined or not`,
			candidates,
		);
		check(new Set(resolved.map((r) => r.release)).size === resolved.length, `under ${resolved.length} different releases`);
		const issues = groupIntoIssues(results.map((r) => r.occurrence.fingerprints));
		const issueOf = Object.fromEntries(results.map((r, i) => [r.name, issues[i]]));
		check(
			resolved.every((r) => issueOf[r.name] === issueOf[resolved[0].name]),
			`the platform's issue resolution puts all ${resolved.length} in one issue (the inlined Next.js build through its cause-v1 alias)`,
			issueOf,
		);
		const unresolved = results.find((r) => !r.key);
		check(issueOf[unresolved.name] !== issueOf[resolved[0].name], "the build without maps does not (its frames are minified)", issueOf);
	} finally {
		await browser.close();
		await Promise.all(servers.map((s) => s.close()));
	}
}

let exitCode = 0;
try {
	await main();
	console.log("\nall checks passed");
} catch (err) {
	exitCode = 1;
	if (!failures) console.error(`\nerror: ${err?.stack ?? err}`);
	for (const ingester of children) console.error(`\n--- ingester log ---\n${ingester.logs.join("").slice(-6000)}`);
} finally {
	for (const ingester of children) ingester.child.kill();
	await sql(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
	await sql(`DROP USER IF EXISTS ${USER}`).catch(() => {});
	rmSync(STATE, { recursive: true, force: true });
}
process.exit(exitCode);
