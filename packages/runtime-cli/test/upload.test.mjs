import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	FatalUploadError,
	injectDir,
	MAX_MAP_CHARS,
	resolveEndpoint,
	resolveRelease,
	servedFilename,
	uploadDir,
} from "../dist/index.js";
import { read, readJson, SERVER_KEY, SIMPLE_MAP, startIngester, tempDir, writeFiles } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const quiet = { log: () => {} };

function build() {
	return tempDir({
		"assets/app.js": "console.log('app');\n",
		"assets/app.js.map": SIMPLE_MAP,
		"assets/vendor.mjs": "export const v = 1;\n",
		"assets/vendor.mjs.map": { ...SIMPLE_MAP, file: "vendor.mjs" },
		"assets/worker.cjs": "module.exports = 1;\n",
		"assets/worker.cjs.map": { ...SIMPLE_MAP, file: "worker.cjs" },
	});
}

test("upload sends every map with its debug id, and the ingester accepts them", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const dir = build();
	const injected = await injectDir(dir);
	const summary = await uploadDir(dir, { ...quiet, release: "abc123", endpoint: ingester.url, key: SERVER_KEY, urlPrefix: "/static/" });
	assert.deepEqual(summary.failed, []);
	assert.equal(summary.uploaded.length, 3);
	assert.equal(ingester.uploads().length, 3);
	const byPath = Object.fromEntries(ingester.rows.map((row) => [row.filename, row]));
	for (const result of injected) {
		const row = byPath[`/static/${result.path}`];
		assert.ok(row, `stored ${result.path}`);
		assert.equal(row.tenant, "org-a/repo-a");
		assert.equal(row.release, "abc123");
		assert.equal(row.debugId, result.debugId);
		assert.equal(row.map.includes("secret source"), false, "sourcesContent never leaves the machine");
		// The client's content hash is the one the ingester stores, so the
		// next run can skip this map.
		const item = summary.uploaded.find((u) => u.path === result.path);
		assert.equal(item.hash, row.contentHash);
		assert.equal(item.hash, createHash("sha256").update(row.map).digest("hex"));
	}
});

test("a second upload skips maps the ingester already has, and re-sends changed ones", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const dir = build();
	await injectDir(dir);
	const options = { ...quiet, release: "abc123", endpoint: ingester.url, key: SERVER_KEY };
	await uploadDir(dir, options);
	const again = await uploadDir(dir, options);
	assert.equal(again.uploaded.length, 0);
	assert.equal(again.skipped.length, 3);
	assert.equal(ingester.uploads().length, 3, "no second round of uploads");
	writeFiles(dir, { "assets/app.js.map": { ...readJson(dir, "assets/app.js.map"), names: ["changed"] } });
	const third = await uploadDir(dir, options);
	assert.deepEqual(third.uploaded.map((u) => u.path), ["assets/app.js"]);
	// A new release is a new upload.
	const fourth = await uploadDir(dir, { ...options, release: "def456" });
	assert.equal(fourth.uploaded.length, 3);
});

test("dry runs list the maps without a key or any request", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const dir = build();
	const summary = await uploadDir(dir, { ...quiet, release: "abc123", endpoint: ingester.url, dryRun: true, env: {} });
	assert.equal(summary.dryRun, true);
	assert.deepEqual(summary.uploaded.map((u) => u.filename), ["/assets/app.js", "/assets/vendor.mjs", "/assets/worker.cjs"]);
	assert.equal(ingester.requests.length, 0);
});

test("an ingester without the check route gets every map, with a warning", async (t) => {
	const ingester = await startIngester({ legacy: true });
	t.after(ingester.close);
	const dir = build();
	const warnings = [];
	const summary = await uploadDir(dir, { release: "abc123", endpoint: ingester.url, key: SERVER_KEY, log: (l) => warnings.push(l) });
	assert.equal(summary.legacyIngester, true);
	assert.equal(summary.uploaded.length, 3);
	assert.match(warnings.join("\n"), /predates 1\.6\.0/);
});

test("transient failures are retried; bad keys stop the upload", async (t) => {
	const flaky = await startIngester({ failFirst: 2 });
	t.after(flaky.close);
	const dir = build();
	const summary = await uploadDir(dir, { ...quiet, release: "abc123", endpoint: flaky.url, key: SERVER_KEY, concurrency: 1 });
	assert.equal(summary.uploaded.length, 3);
	assert.equal(flaky.uploads().length, 5);

	await assert.rejects(uploadDir(dir, { ...quiet, release: "abc123", endpoint: flaky.url, key: "autter_rt_wrong" }), (err) => err instanceof FatalUploadError && /401/.test(err.message));
	await assert.rejects(uploadDir(dir, { ...quiet, release: "abc123", endpoint: flaky.url, key: "autter_rtc_client" }), /publishable client key/);
	await assert.rejects(uploadDir(dir, { ...quiet, release: "abc123", endpoint: flaky.url, env: {} }), /AUTTER_RUNTIME_KEY/);
});

test("maps over the ingester's limit and invalid maps are reported as failures", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const dir = tempDir({
		"big.js": "x\n",
		"big.js.map": { ...SIMPLE_MAP, names: ["n".repeat(MAX_MAP_CHARS)] },
		"bad.js": "y\n",
		"bad.js.map": { version: 2 },
		"ok.js": "z\n",
		"ok.js.map": SIMPLE_MAP,
	});
	const summary = await uploadDir(dir, { ...quiet, release: "abc123", endpoint: ingester.url, key: SERVER_KEY });
	assert.deepEqual(summary.uploaded.map((u) => u.path), ["ok.js"]);
	assert.deepEqual(summary.failed.map((f) => f.path).sort(), ["bad.js", "big.js"]);
	assert.match(summary.failed.find((f) => f.path === "big.js").error, /32\.0 MB without sourcesContent; the ingester accepts up to 32 MB/);
	assert.equal(ingester.uploads().length, 1, "only ok.js is sent");
});

test("uploads are gzipped, and the real ingester route inflates them", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const names = Array.from({ length: 3000 }, (_, i) => `originalName${i}`);
	const dir = tempDir({ "app.js": "x()\n", "app.js.map": { ...SIMPLE_MAP, names } });
	const summary = await uploadDir(dir, { ...quiet, release: "abc123", endpoint: ingester.url, key: SERVER_KEY });
	assert.deepEqual(summary.failed, []);
	const [request] = ingester.uploads();
	assert.equal(request.encoding, "gzip");
	assert.ok(request.bytes > 0 && request.bytes < summary.uploaded[0].bytes / 3, `${request.bytes} gzipped of ${summary.uploaded[0].bytes}`);
	assert.deepEqual(JSON.parse(ingester.rows[0].map).names, names);
	assert.equal(summary.uploaded[0].hash, ingester.rows[0].contentHash);
});

test("an ingester that refuses a big map (1.6.0 and older take 5 MB) gets a clear error", async (t) => {
	const ingester = await startIngester({ rejectUploads: 413 });
	t.after(ingester.close);
	const dir = tempDir({ "big.js": "x\n", "big.js.map": { ...SIMPLE_MAP, names: ["n".repeat(6 * 1024 * 1024)] } });
	const summary = await uploadDir(dir, { ...quiet, release: "abc123", endpoint: ingester.url, key: SERVER_KEY });
	assert.equal(ingester.uploads().length, 1, "a 413 is not retried");
	assert.match(summary.failed[0].error, /^HTTP 413: .*this map is 6\.0 MB; ingester 1\.6\.0 and older accept up to 5 MB, newer ones 32 MB/);
});

test("--delete-after-upload removes uploaded maps and their sourceMappingURL comments", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const dir = tempDir({ "app.js": "x()\n//# sourceMappingURL=app.js.map\n", "app.js.map": SIMPLE_MAP });
	await injectDir(dir);
	const summary = await uploadDir(dir, { ...quiet, release: "abc123", endpoint: ingester.url, key: SERVER_KEY, deleteAfterUpload: true });
	assert.equal(summary.uploaded.length, 1);
	assert.equal(existsSync(join(dir, "app.js.map")), false);
	assert.doesNotMatch(read(dir, "app.js"), /sourceMappingURL/);
	assert.match(read(dir, "app.js"), /\/\/# debugId=/);
});

test("release comes from --release, then CI variables, then git", () => {
	assert.deepEqual(resolveRelease("v1.2.3", { GITHUB_SHA: "aaa" }), { release: "v1.2.3", source: "--release" });
	assert.deepEqual(resolveRelease(undefined, { GITHUB_SHA: "aaa", GIT_SHA: "ddd" }), { release: "aaa", source: "GITHUB_SHA" });
	assert.deepEqual(resolveRelease(undefined, { VERCEL_GIT_COMMIT_SHA: "bbb", GIT_SHA: "ddd" }), { release: "bbb", source: "VERCEL_GIT_COMMIT_SHA" });
	assert.deepEqual(resolveRelease(undefined, { CF_PAGES_COMMIT_SHA: "ccc", GIT_SHA: "ddd" }), { release: "ccc", source: "CF_PAGES_COMMIT_SHA" });
	assert.deepEqual(resolveRelease(undefined, { GIT_SHA: "ddd" }), { release: "ddd", source: "GIT_SHA" });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	assert.deepEqual(resolveRelease(undefined, {}), { release: head, source: "git" });
	assert.throws(() => resolveRelease(undefined, {}, tempDir()), /no release/);
	assert.throws(() => resolveRelease("my app@1.0", {}), /not valid/);
});

test("served filenames and endpoints are normalised", () => {
	assert.equal(servedFilename(undefined, "assets/a.js"), "/assets/a.js");
	assert.equal(servedFilename("~/", "a.js"), "/a.js");
	assert.equal(servedFilename("static", "a.js"), "/static/a.js");
	assert.equal(servedFilename("/_next/static/", "chunks/a.js"), "/_next/static/chunks/a.js");
	assert.equal(servedFilename("https://cdn.example.com/app", "a.js"), "https://cdn.example.com/app/a.js");
	assert.equal(resolveEndpoint(undefined, {}), "https://otlp.autter.dev");
	assert.equal(resolveEndpoint(undefined, { AUTTER_ENDPOINT: "https://ingest.example.com/v1/browser" }), "https://ingest.example.com");
	assert.equal(resolveEndpoint("http://localhost:4318/", {}), "http://localhost:4318");
});

/** Run the built CLI. Asynchronous on purpose: the ingester it talks to
 * runs in this process, so a synchronous spawn would deadlock. */
function cli(args, env = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

test("the CLI injects and uploads a build directory end to end", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const dir = build();
	const inject = await cli(["sourcemaps", "inject", dir]);
	assert.equal(inject.code, 0, inject.stderr);
	assert.match(inject.stdout, /3 bundle\(s\) with source maps: 3 injected, 0 unchanged/);
	assert.match((await cli(["sourcemaps", "inject", dir])).stdout, /0 injected, 3 unchanged/);

	const upload = await cli(["sourcemaps", "upload", dir, "--url-prefix", "/static/", "--endpoint", ingester.url], {
		AUTTER_RUNTIME_KEY: SERVER_KEY,
		GITHUB_SHA: "0123abc",
	});
	assert.equal(upload.code, 0, upload.stderr);
	assert.match(upload.stdout, /uploaded \/static\/assets\/app\.js \(debug id [0-9a-f-]{36}\)/);
	assert.match(upload.stdout, /3 uploaded, 0 already uploaded, 0 failed \(release 0123abc from GITHUB_SHA/);
	assert.deepEqual(ingester.rows.map((r) => r.release), ["0123abc", "0123abc", "0123abc"]);
	const json = await cli(["sourcemaps", "upload", dir, "--endpoint", ingester.url, "--url-prefix", "/static/", "--json"], { AUTTER_RUNTIME_KEY: SERVER_KEY, GITHUB_SHA: "0123abc" });
	assert.equal(JSON.parse(json.stdout).skipped.length, 3);
});

test("the CLI reports usage errors and missing keys with distinct exit codes", async () => {
	assert.equal((await cli(["--help"])).code, 0);
	assert.match((await cli(["--version"])).stdout, /^\d+\.\d+\.\d+/);
	assert.equal((await cli(["sourcemaps"])).code, 64);
	assert.equal((await cli(["sourcemaps", "inject"])).code, 64);
	assert.equal((await cli(["sourcemaps", "upload", tempDir(), "--bogus"])).code, 64);
	assert.equal((await cli(["nope"])).code, 64);
	const noKey = await cli(["sourcemaps", "upload", build(), "--release", "abc"]);
	assert.equal(noKey.code, 2);
	assert.match(noKey.stderr, /AUTTER_RUNTIME_KEY/);
	const dry = await cli(["sourcemaps", "upload", build(), "--release", "abc", "--dry-run"]);
	assert.equal(dry.code, 0);
	assert.match(dry.stdout, /would upload \/assets\/app\.js/);
});
