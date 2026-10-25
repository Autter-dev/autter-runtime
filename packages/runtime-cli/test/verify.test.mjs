// `autter-runtime sourcemaps verify`: local checks of a build directory, and
// the ingester check by debug id against the real ingester routes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { globToRegExp, injectDir, uploadDir, verifyDir } from "../dist/index.js";
import { SERVER_KEY, SIMPLE_MAP, startIngester, tempDir, UPLOAD_KEY } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const quiet = { log: () => {} };

/** A project with a build in dist/: two bundles with maps, a copied public file and a service worker. */
function project() {
	const root = tempDir({
		"package.json": "{}",
		"public/analytics.js": "window.analytics = 1;\n",
		"dist/analytics.js": "window.analytics = 1;\n",
		"dist/sw.js": "self.addEventListener('fetch', () => {});\n",
		"dist/assets/index-4f3c.js": "console.log('app');\n//# sourceMappingURL=index-4f3c.js.map\n",
		"dist/assets/index-4f3c.js.map": SIMPLE_MAP,
		"dist/assets/vendor-91ab.mjs": "export const v = 1;\n",
		"dist/assets/vendor-91ab.mjs.map": { ...SIMPLE_MAP, file: "vendor-91ab.mjs" },
	});
	return { root, dist: join(root, "dist") };
}

/** Inject and upload with --delete-after-upload, as a deploy pipeline would. */
async function deployable(ingester, key = SERVER_KEY) {
	const { root, dist } = project();
	await injectDir(dist);
	const summary = await uploadDir(dist, { ...quiet, release: "abc123", endpoint: ingester.url, key, deleteAfterUpload: true });
	assert.equal(summary.uploaded.length, 2);
	return { root, dist };
}

function cli(args, env = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

test("a clean build verifies: debug ids everywhere, no maps left, every map on the ingester (upload key)", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const { dist } = await deployable(ingester, UPLOAD_KEY);
	const before = ingester.requests.length;
	const result = await verifyDir(dist, { endpoint: ingester.url, env: { AUTTER_RUNTIME_KEY: UPLOAD_KEY, GITHUB_SHA: "other-release" } });
	assert.deepEqual(result.failures, []);
	assert.equal(result.ok, true);
	assert.deepEqual(result.maps, []);
	assert.deepEqual(
		result.bundles.map((b) => [b.path, b.status, b.uploaded]),
		[
			["analytics.js", "skipped", null],
			["assets/index-4f3c.js", "ok", true],
			["assets/vendor-91ab.mjs", "ok", true],
			["sw.js", "skipped", null],
		],
	);
	assert.match(result.bundles[0].reasons[0], /copied unchanged from public\/analytics\.js/);
	assert.match(result.bundles[3].reasons[0], /service worker/);
	// One check request; the debug id alone answers it, whatever the release.
	assert.deepEqual(result.upload, { status: "verified", endpoint: ingester.url, reason: null, checked: 2, missing: 0 });
	assert.deepEqual(ingester.requests.slice(before).map((r) => r.url), ["/v1/sourcemaps/check"]);

	const run = await cli(["sourcemaps", "verify", dist, "--endpoint", ingester.url], { AUTTER_RUNTIME_KEY: UPLOAD_KEY });
	assert.equal(run.code, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /upload: verified, 2 bundle map\(s\) on the ingester/);
	assert.match(run.stdout, /^ok: 2 bundle\(s\) with debug ids, no source maps left$/m);
});

test("leftover maps and a sourceMappingURL to a missing map fail; --allow-maps tolerates the maps", async () => {
	const { dist } = project();
	await injectDir(dist);
	const result = await verifyDir(dist, { env: {} });
	assert.equal(result.ok, false);
	assert.deepEqual(result.maps, ["assets/index-4f3c.js.map", "assets/vendor-91ab.mjs.map"]);
	assert.deepEqual(result.failures.map((f) => f.path), ["assets/index-4f3c.js.map", "assets/vendor-91ab.mjs.map"]);
	assert.match(result.failures[0].reason, /source map in the deploy output: it exposes your original source/);
	assert.equal((await verifyDir(dist, { env: {}, allowMaps: true })).ok, true);

	const dangling = tempDir({ "app.js": "x()\n//# sourceMappingURL=app.js.map\n", "app.js.map": SIMPLE_MAP, "inline.js": "y()\n//# sourceMappingURL=data:application/json;base64,e30=\n", "inline.js.map": SIMPLE_MAP });
	await injectDir(dangling);
	const { rmSync } = await import("node:fs");
	rmSync(join(dangling, "app.js.map"));
	rmSync(join(dangling, "inline.js.map"));
	const bad = await verifyDir(dangling, { env: {} });
	assert.equal(bad.ok, false);
	const byPath = Object.fromEntries(bad.failures.map((f) => [f.path, f.reason]));
	assert.match(byPath["app.js"], /sourceMappingURL points at app\.js\.map, which is not in the output/);
	assert.match(byPath["inline.js"], /inline source map \(data: URL\)/);
});

test("a bundle without a debug id (or with only half of it) fails, with the reason per file", async () => {
	const dir = tempDir({
		"plain.js": "console.log('never injected');\n",
		"native.js": "x()\n//# debugId=0f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f\n",
		"ok.js": "z()\n",
		"ok.js.map": SIMPLE_MAP,
		"generated/vendor.js": "v()\n",
	});
	await injectDir(dir);
	const { rmSync } = await import("node:fs");
	rmSync(join(dir, "ok.js.map"));
	const result = await verifyDir(dir, { env: {}, ignore: ["generated/**"] });
	assert.equal(result.ok, false);
	const status = Object.fromEntries(result.bundles.map((b) => [b.path, b.status]));
	assert.deepEqual(status, { "generated/vendor.js": "skipped", "native.js": "failed", "ok.js": "ok", "plain.js": "failed" });
	const reasons = Object.fromEntries(result.failures.map((f) => [f.path, f.reason]));
	assert.match(reasons["plain.js"], /^no debug id: .*autter-runtime sourcemaps inject/);
	assert.match(reasons["native.js"], /comment but no registration snippet/);
	// Without a key the upload is unverified, which alone is not a failure.
	assert.equal(result.upload.status, "unverified");

	const run = await cli(["sourcemaps", "verify", dir, "--json", "--ignore", "generated/**"]);
	assert.equal(run.code, 1);
	assert.equal(JSON.parse(run.stdout).failures.length, 2);
	assert.equal((await cli(["sourcemaps", "verify", tempDir({ "a.css": "a{}" })])).code, 1, "no bundles at all");
});

test("the ingester check reports bundles whose maps were never uploaded", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const { dist } = project();
	await injectDir(dist);
	// Upload only one of the two bundles, then remove the maps.
	await uploadDir(dist, { ...quiet, files: ["assets/index-4f3c.js"], release: "abc123", endpoint: ingester.url, key: SERVER_KEY, deleteAfterUpload: true });
	const { rmSync } = await import("node:fs");
	rmSync(join(dist, "assets/vendor-91ab.mjs.map"));
	const result = await verifyDir(dist, { endpoint: ingester.url, key: SERVER_KEY, env: {} });
	assert.equal(result.ok, false);
	assert.equal(result.upload.status, "missing");
	assert.equal(result.upload.missing, 1);
	assert.deepEqual(result.failures.map((f) => f.path), ["assets/vendor-91ab.mjs"]);
	assert.match(result.failures[0].reason, /no map with debug id [0-9a-f-]{36} on the ingester/);

	// A key the ingester rejects is a failure; an ingester too old to check by debug id is not.
	const rejected = await verifyDir(dist, { endpoint: ingester.url, key: "autter_rtu_unknown", env: {} });
	assert.equal(rejected.upload.status, "error");
	assert.match(rejected.upload.reason, /rejected the key \(401\).*need ingester 1\.7\.0/);
	const old = await startIngester({ checkStatus: 400 });
	t.after(old.close);
	const unverified = await verifyDir(dist, { endpoint: old.url, key: SERVER_KEY, env: {} });
	assert.equal(unverified.upload.status, "unverified");
	assert.match(unverified.upload.reason, /predates 1\.7\.0/);
	assert.equal(unverified.ok, true);
});

test("without a key the local checks run and the upload is reported as unverified", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const { dist } = await deployable(ingester);
	const before = ingester.requests.length;
	const run = await cli(["sourcemaps", "verify", dist, "--endpoint", ingester.url, "--json"]);
	assert.equal(run.code, 0, run.stdout);
	const result = JSON.parse(run.stdout);
	assert.equal(result.ok, true);
	assert.deepEqual(result.upload, { status: "unverified", endpoint: null, reason: "AUTTER_RUNTIME_KEY is not set: only the local checks ran", checked: 0, missing: 0 });
	assert.equal(ingester.requests.length, before, "no request without a key");
	assert.match((await cli(["sourcemaps", "verify", dist])).stdout, /upload: unverified, AUTTER_RUNTIME_KEY is not set/);
});

test("--ignore globs", () => {
	assert.ok(globToRegExp("generated/**").test("generated/a/b.js"));
	assert.ok(globToRegExp("*.worker.js").test("assets/x.worker.js"));
	assert.ok(!globToRegExp("assets/*.js").test("assets/deep/x.js"));
	assert.ok(globToRegExp("**/legacy-?.js").test("a/b/legacy-1.js"));
});

test("--server: server output keeps its maps without failing, and Next server manifests are not bundles (RF-05)", async () => {
	const root = tempDir({
		"package.json": "{}",
		"dist/server.js": "module.exports = 1;\n",
		"dist/server.js.map": SIMPLE_MAP,
		".next/server/app/page.js": "exports.id = 1;\n",
		".next/server/app/page.js.map": SIMPLE_MAP,
		".next/server/middleware-manifest.js": "self.__MIDDLEWARE_MANIFEST={}\n",
		".next/server/app/page_client-reference-manifest.js": "globalThis.__RSC_MANIFEST={}\n",
	});
	const dist = join(root, "dist");
	await injectDir(dist);
	// As browser output, the leftover map fails the check; as server output it is a note.
	assert.equal((await verifyDir(dist, { env: {} })).ok, false);
	const server = await verifyDir(dist, { env: {}, server: true });
	assert.deepEqual(server.failures, []);
	assert.equal(server.ok, true);
	assert.equal(server.server, true);
	assert.deepEqual(server.maps, ["server.js.map"]);

	const next = join(root, ".next/server");
	await injectDir(next);
	const result = await verifyDir(next, { env: {}, server: true });
	assert.deepEqual(result.failures, []);
	assert.deepEqual(
		result.bundles.map((b) => [b.path, b.status]),
		[
			["app/page.js", "ok"],
			["app/page_client-reference-manifest.js", "skipped"],
			["middleware-manifest.js", "skipped"],
		],
	);

	const run = await cli(["sourcemaps", "verify", dist, "--server"]);
	assert.equal(run.code, 0, run.stdout);
	assert.match(run.stdout, /note {4}server\.js\.map: source map in the server output/);
	assert.match(run.stdout, /1 source map\(s\) left \(server output\)/);
});
