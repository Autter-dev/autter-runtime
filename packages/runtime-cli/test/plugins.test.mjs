import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rollup } from "rollup";
import { hasDebugIdSnippet, readDebugIdComment } from "../dist/index.js";
import { withAutterSourceMaps } from "../dist/next.js";
import { autterSourceMaps } from "../dist/vite.js";
import { AutterSourceMapsWebpackPlugin } from "../dist/webpack.js";
import { ScopeIndex } from "../../otlp-ingester/dist/source-map-scopes.js";
import { decodeMappings, read, readJson, SERVER_KEY, SIMPLE_MAP, startIngester, tempDir, writeFiles } from "./helpers.mjs";

const silent = { silent: true };

/** Every `.map` file under `dir`, relative. */
function mapsUnder(dir) {
	return readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith(".map")).map(String).sort();
}

/** Run with AUTTER_RUNTIME_KEY unset. */
function withoutKey(t) {
	const saved = process.env.AUTTER_RUNTIME_KEY;
	delete process.env.AUTTER_RUNTIME_KEY;
	t.after(() => { if (saved !== undefined) process.env.AUTTER_RUNTIME_KEY = saved; });
}

/** Lines the plugin printed (console.log and console.warn). */
function captureLogs(t) {
	const lines = [];
	t.mock.method(console, "log", (line) => lines.push(String(line)));
	t.mock.method(console, "warn", (line) => lines.push(String(line)));
	return lines;
}

/** Nothing listens here: connections are refused. */
const UNREACHABLE = "http://127.0.0.1:9";

async function rollupBuild(src, outDir, plugin, output = {}) {
	const bundle = await rollup({ input: join(src, "main.js"), plugins: [plugin] });
	await bundle.write({ dir: outDir, format: "es", entryFileNames: "assets/[name]-[hash].js", chunkFileNames: "assets/[name]-[hash].js", ...output });
	await bundle.close();
}

const SOURCES = {
	"main.js": 'import { add } from "./math.js";\nconsole.log(add(1, 2));\nimport("./lazy.js").then((m) => m.run());\n',
	"math.js": "export function add(a, b) {\n  return a + b;\n}\n",
	"lazy.js": 'export function run() {\n  throw new Error("lazy failure");\n}\n',
};

test("Rollup: hidden maps, debug ids injected into every chunk, maps uploaded then removed", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const src = tempDir(SOURCES);
	const out = tempDir();
	await rollupBuild(src, out, autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: ingester.url, release: "rel-1" }));

	assert.equal(ingester.rows.length, 2, "main + lazy chunk");
	for (const row of ingester.rows) {
		assert.match(row.filename, /^\/assets\/(main|lazy)-[\w-]+\.js$/);
		assert.equal(row.release, "rel-1");
		const code = read(out, row.filename);
		assert.equal(readDebugIdComment(code), row.debugId);
		assert.ok(hasDebugIdSnippet(code));
		assert.doesNotMatch(code, /sourceMappingURL/, "hidden: the bundle never points at its map");
		assert.equal(existsSync(join(out, `${row.filename}.map`)), false, "maps the plugin enabled are deleted once uploaded");
		// The stored map still resolves the original source after the
		// snippet line was prepended.
		const map = JSON.parse(row.map);
		assert.equal(map.debugId, row.debugId);
		const lines = decodeMappings(map.mappings);
		assert.deepEqual(lines[0], []);
		assert.ok(lines.slice(1).some((segments) => segments.some((s) => map.sources[s[1]].endsWith(row.filename.includes("lazy") ? "lazy.js" : "main.js"))));
		// Function scopes, computed on the chunk as written (snippet included).
		const scopes = ScopeIndex.from(map.x_autter_scopes, map.names);
		const [marker, name] = row.filename.includes("lazy") ? ["lazy failure", "run"] : ["a + b", "add"];
		const before = code.slice(0, code.indexOf(marker)).split("\n");
		assert.deepEqual(scopes.nameAt(before.length - 1, before.at(-1).length), { kind: "named", name });
		assert.equal(scopes.nameAt(0, code.indexOf("try")).kind, "anonymous", "the snippet's own function on line 0");
	}
});

test("Rollup without a key: no maps are generated, the output is untouched, one line says why", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	withoutKey(t);
	const logs = captureLogs(t);
	const src = tempDir(SOURCES);
	const out = tempDir();
	await rollupBuild(src, out, autterSourceMaps({ endpoint: ingester.url, release: "rel-1" }));
	assert.equal(ingester.requests.length, 0);
	assert.deepEqual(mapsUnder(out), []);
	const main = readdirSync(join(out, "assets")).find((f) => f.startsWith("main-") && f.endsWith(".js"));
	assert.equal(readDebugIdComment(read(out, `assets/${main}`)), null);
	assert.deepEqual(logs, ["[autter-runtime] AUTTER_RUNTIME_KEY is not set: no source maps generated, nothing uploaded"]);
});

test("Rollup: maps it generated are deleted when the upload fails (413), with one line saying why", async (t) => {
	const ingester = await startIngester({ rejectUploads: 413 });
	t.after(ingester.close);
	const logs = captureLogs(t);
	const src = tempDir(SOURCES);
	const out = tempDir();
	await rollupBuild(src, out, autterSourceMaps({ key: SERVER_KEY, endpoint: ingester.url, release: "rel-1" }));
	assert.equal(ingester.uploads().length, 2, "both maps were tried");
	assert.deepEqual(mapsUnder(out), []);
	for (const name of readdirSync(join(out, "assets"))) {
		assert.doesNotMatch(read(out, `assets/${name}`), /sourceMappingURL/);
		assert.ok(readDebugIdComment(read(out, `assets/${name}`)), "debug ids stay: a later upload can still match");
	}
	const removed = logs.filter((line) => line.includes("removed"));
	assert.equal(removed.length, 1, logs.join("\n"));
	assert.match(removed[0], /^\[autter-runtime\] removed 2 source map\(s\) this plugin generated, so they are not deployed: 2 of 2 could not be uploaded \(HTTP 413/);
});

test("Rollup: maps it generated are deleted in a dry run and when the ingester is unreachable; upload: false keeps them with a warning", async (t) => {
	const dryOut = tempDir();
	await rollupBuild(tempDir(SOURCES), dryOut, autterSourceMaps({ ...silent, dryRun: true, release: "rel-1" }));
	assert.deepEqual(mapsUnder(dryOut), []);

	const logs = captureLogs(t);
	const out = tempDir();
	await rollupBuild(tempDir(SOURCES), out, autterSourceMaps({ key: SERVER_KEY, endpoint: UNREACHABLE, release: "rel-1", concurrency: 2 }));
	assert.deepEqual(mapsUnder(out), []);
	assert.match(logs.find((line) => line.includes("removed")), /removed 2 source map\(s\).*: 2 of 2 could not be uploaded/);

	withoutKey(t);
	const later = tempDir();
	await rollupBuild(tempDir(SOURCES), later, autterSourceMaps({ upload: false }));
	assert.equal(mapsUnder(later).length, 2, "kept for `autter-runtime sourcemaps upload`");
	assert.ok(logs.some((line) => /kept 2 source map\(s\) this plugin generated \(upload: false\): they expose your source/.test(line)));
});

test("Rollup keeps maps the user turned on, and their sourceMappingURL: uploaded, failed, or without a key", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const src = tempDir(SOURCES);
	const out = tempDir();
	await rollupBuild(src, out, autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: ingester.url, release: "rel-1" }), { sourcemap: true });
	assert.equal(ingester.rows.length, 2);
	for (const row of ingester.rows) {
		assert.ok(existsSync(join(out, `${row.filename}.map`)));
		assert.match(read(out, row.filename), /\/\/# sourceMappingURL=/);
	}
	const failing = await startIngester({ rejectUploads: 413 });
	t.after(failing.close);
	const failedOut = tempDir();
	await rollupBuild(src, failedOut, autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: failing.url, release: "rel-1" }), { sourcemap: true });
	assert.equal(mapsUnder(failedOut).length, 2);
	withoutKey(t);
	const keyless = tempDir();
	await rollupBuild(src, keyless, autterSourceMaps(silent), { sourcemap: true });
	assert.equal(mapsUnder(keyless).length, 2);
});

test("Vite: turns on hidden maps, uses `base` as the URL prefix, skips SSR builds", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const plugin = autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: ingester.url, release: "rel-1" });
	assert.equal(plugin.apply, "build");
	assert.deepEqual(plugin.config({}), { build: { sourcemap: "hidden" } });
	plugin.configResolved({ base: "/app/", build: { sourcemap: "hidden" } });
	assert.equal(plugin.outputOptions({ dir: "x" }), null, "Vite already configured the maps");
	const out = tempDir({ "assets/index-abc.js": "console.log(1);\n", "assets/index-abc.js.map": SIMPLE_MAP, "assets/index.css": "" });
	await plugin.writeBundle.call({}, { dir: out }, {
		"assets/index-abc.js": { type: "chunk", fileName: "assets/index-abc.js" },
		"assets/index.css": { type: "asset", fileName: "assets/index.css" },
	});
	assert.deepEqual(ingester.rows.map((r) => r.filename), ["/app/assets/index-abc.js"]);
	assert.ok(ingester.rows[0].debugId);

	// A user who set sourcemap themselves keeps it.
	assert.equal(autterSourceMaps(silent).config({ build: { sourcemap: true } }), undefined);
	// Server bundles (Vite ≤5 SSR, or a Vite 6 server environment) are skipped.
	const ssr = autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: ingester.url, release: "rel-1" });
	ssr.config({});
	ssr.configResolved({ base: "/", build: { ssr: true } });
	const ssrOut = tempDir({ "entry.js": "x\n", "entry.js.map": SIMPLE_MAP });
	await ssr.writeBundle.call({}, { dir: ssrOut }, { "entry.js": { type: "chunk", fileName: "entry.js" } });
	const env = autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: ingester.url, release: "rel-1" });
	await env.writeBundle.call({ environment: { config: { consumer: "server" } } }, { dir: ssrOut }, { "entry.js": { type: "chunk", fileName: "entry.js" } });
	assert.equal(readDebugIdComment(read(ssrOut, "entry.js")), null);
	assert.equal(ingester.rows.length, 1);
});

test("Vite: no key → no maps turned on; a failed upload → every map it turned on (JS and CSS) deleted; your own maps untouched", async (t) => {
	withoutKey(t);
	const logs = captureLogs(t);
	assert.equal(autterSourceMaps().config({}), undefined, "no key: build.sourcemap stays off");
	assert.deepEqual(logs, ["[autter-runtime] AUTTER_RUNTIME_KEY is not set: no source maps generated, nothing uploaded"]);

	const failing = await startIngester({ rejectUploads: 413 });
	t.after(failing.close);
	const files = () => ({
		"assets/index-abc.js": "console.log(1);\n",
		"assets/index-abc.js.map": SIMPLE_MAP,
		"assets/index-abc.css": "body{}\n/*# sourceMappingURL=index-abc.css.map */\n",
		"assets/index-abc.css.map": { version: 3, sources: ["../src/app.css"], mappings: "AAAA" },
	});
	const bundle = {
		"assets/index-abc.js": { type: "chunk", fileName: "assets/index-abc.js" },
		"assets/index-abc.js.map": { type: "asset", fileName: "assets/index-abc.js.map" },
		"assets/index-abc.css": { type: "asset", fileName: "assets/index-abc.css" },
		"assets/index-abc.css.map": { type: "asset", fileName: "assets/index-abc.css.map" },
	};
	const plugin = autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: failing.url, release: "rel-1" });
	assert.deepEqual(plugin.config({}), { build: { sourcemap: "hidden" } });
	plugin.configResolved({ base: "/", build: { sourcemap: "hidden" } });
	const out = tempDir(files());
	await plugin.writeBundle.call({}, { dir: out }, bundle);
	assert.equal(failing.uploads().length, 1);
	assert.deepEqual(mapsUnder(out), []);
	assert.equal(read(out, "assets/index-abc.css"), "body{}\n", "the CSS comment naming the deleted map goes too");

	// build.sourcemap set by the user: their maps stay, whatever the upload did.
	const own = autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: failing.url, release: "rel-1" });
	assert.equal(own.config({ build: { sourcemap: true } }), undefined);
	own.configResolved({ base: "/", build: { sourcemap: true } });
	const ownOut = tempDir(files());
	await own.writeBundle.call({}, { dir: ownOut }, bundle);
	assert.deepEqual(mapsUnder(ownOut), ["assets/index-abc.css.map", "assets/index-abc.js.map"]);
	assert.match(read(ownOut, "assets/index-abc.css"), /sourceMappingURL/);

	// A Vite 6 server environment is never uploaded: maps we turned on for it go.
	const env = autterSourceMaps({ ...silent, key: SERVER_KEY, endpoint: failing.url, release: "rel-1" });
	env.config({});
	const serverOut = tempDir({ "entry.js": "x\n", "entry.js.map": SIMPLE_MAP });
	await env.writeBundle.call({ environment: { config: { consumer: "server" } } }, { dir: serverOut }, {
		"entry.js": { type: "chunk", fileName: "entry.js" },
		"entry.js.map": { type: "asset", fileName: "entry.js.map" },
	});
	assert.deepEqual(mapsUnder(serverOut), []);
	// SSR builds get no maps from the plugin at all.
	assert.equal(autterSourceMaps({ ...silent, key: SERVER_KEY }).config({ build: { ssr: true } }), undefined);
});

/** Just enough of webpack's Compiler/Compilation for the plugin. */
function fakeCompiler(options) {
	const taps = [];
	return {
		options,
		outputPath: "/unused",
		hooks: { afterEmit: { tapPromise: (name, fn) => taps.push({ name, fn }) } },
		taps,
	};
}

test("webpack: hidden-source-map in production, inject + upload after emit with the public path", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const compiler = fakeCompiler({ mode: "production" });
	new AutterSourceMapsWebpackPlugin({ ...silent, key: SERVER_KEY, endpoint: ingester.url, release: "rel-1" }).apply(compiler);
	assert.equal(compiler.options.devtool, "hidden-source-map");
	assert.equal(compiler.taps.length, 1);
	const out = tempDir({ "js/main.123.js": "console.log(1);\n", "js/main.123.js.map": SIMPLE_MAP, "js/vendor.js": "v\n" });
	await compiler.taps[0].fn({
		outputOptions: { path: out, publicPath: "/static/" },
		getAssets: () => [{ name: "js/main.123.js" }, { name: "js/main.123.js.map" }, { name: "js/vendor.js" }],
	});
	assert.deepEqual(ingester.rows.map((r) => r.filename), ["/static/js/main.123.js"]);
	assert.equal(readDebugIdComment(read(out, "js/main.123.js")), ingester.rows[0].debugId);
	assert.equal(existsSync(join(out, "js/main.123.js.map")), false);

	// A devtool the user chose is kept (and its maps stay); development builds are untouched.
	const own = fakeCompiler({ mode: "production", devtool: "source-map" });
	new AutterSourceMapsWebpackPlugin(silent).apply(own);
	assert.equal(own.options.devtool, "source-map");
	const dev = fakeCompiler({ mode: "development" });
	new AutterSourceMapsWebpackPlugin(silent).apply(dev);
	assert.equal(dev.options.devtool, undefined);
	assert.equal(dev.taps.length, 0);
});

test("webpack: no key → no devtool; unreachable ingester → maps it turned on deleted; a devtool you chose keeps its maps", async (t) => {
	withoutKey(t);
	const logs = captureLogs(t);
	const keyless = fakeCompiler({ mode: "production" });
	new AutterSourceMapsWebpackPlugin().apply(keyless);
	assert.equal(keyless.options.devtool, undefined);
	assert.deepEqual(logs, ["[autter-runtime] AUTTER_RUNTIME_KEY is not set: no source maps generated, nothing uploaded"]);

	const files = () => ({
		"js/main.123.js": "console.log(1);\n",
		"js/main.123.js.map": SIMPLE_MAP,
		"css/main.css": "a{}\n",
		"css/main.css.map": { version: 3, sources: ["src/main.scss"], mappings: "AAAA" },
	});
	const assets = [{ name: "js/main.123.js" }, { name: "js/main.123.js.map" }, { name: "css/main.css" }, { name: "css/main.css.map" }];
	const compiler = fakeCompiler({ mode: "production" });
	new AutterSourceMapsWebpackPlugin({ key: SERVER_KEY, endpoint: UNREACHABLE, release: "rel-1" }).apply(compiler);
	assert.equal(compiler.options.devtool, "hidden-source-map");
	const out = tempDir(files());
	await compiler.taps[0].fn({ outputOptions: { path: out, publicPath: "/" }, getAssets: () => assets });
	assert.deepEqual(mapsUnder(out), []);
	assert.match(logs.at(-1), /removed 2 source map\(s\) this plugin generated, so they are not deployed: 1 of 1 could not be uploaded/);

	const own = fakeCompiler({ mode: "production", devtool: "source-map" });
	new AutterSourceMapsWebpackPlugin({ ...silent, key: SERVER_KEY, endpoint: UNREACHABLE, release: "rel-1" }).apply(own);
	const ownOut = tempDir(files());
	await own.taps[0].fn({ outputOptions: { path: ownOut, publicPath: "/" }, getAssets: () => assets });
	assert.deepEqual(mapsUnder(ownOut), ["css/main.css.map", "js/main.123.js.map"]);
});

/** A project directory whose node_modules has `next` at `version`. */
function nextProject(version) {
	const dir = tempDir({ "package.json": { name: "app" }, "node_modules/next/package.json": { name: "next", version } });
	return dir;
}

function inDir(t, dir) {
	const cwd = process.cwd();
	process.chdir(dir);
	t.after(() => process.chdir(cwd));
}

test("Next 15.4.1+: hidden client maps, and the after-compile hook injects, uploads and hides maps", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const project = nextProject("15.5.0");
	inDir(t, project);
	const calls = [];
	const config = withAutterSourceMaps(
		{
			basePath: "/docs",
			reactStrictMode: true,
			webpack: (cfg, ctx) => { calls.push(ctx); return { ...cfg, marker: true }; },
			compiler: { runAfterProductionCompile: async () => calls.push("user hook") },
		},
		{ ...silent, key: SERVER_KEY, endpoint: ingester.url, release: "rel-1" },
	);
	assert.equal(config.reactStrictMode, true);
	assert.equal(config.productionBrowserSourceMaps, true);
	const client = config.webpack({ devtool: "source-map", plugins: [] }, { isServer: false, dev: false });
	assert.equal(client.marker, true, "the user's webpack function still runs");
	assert.equal(client.devtool, "hidden-source-map");
	assert.equal(client.plugins.length, 0, "the after-compile hook does the work, for webpack and Turbopack alike");
	const server = config.webpack({ devtool: "source-map" }, { isServer: true, dev: false });
	assert.equal(server.devtool, "source-map");

	const distDir = join(project, ".next");
	writeFiles(distDir, {
		"static/chunks/app-1.js": "console.log(1);\n//# sourceMappingURL=app-1.js.map\n",
		"static/chunks/app-1.js.map": SIMPLE_MAP,
		"static/BUILD/_buildManifest.js": "self.__BUILD_MANIFEST={}\n",
		"server/page.js": "x\n",
		"server/page.js.map": SIMPLE_MAP,
	});
	await config.compiler.runAfterProductionCompile({ distDir, projectDir: project });
	assert.ok(calls.includes("user hook"));
	assert.deepEqual(ingester.rows.map((r) => r.filename), ["/docs/_next/static/chunks/app-1.js"]);
	const chunk = read(distDir, "static/chunks/app-1.js");
	assert.equal(readDebugIdComment(chunk), ingester.rows[0].debugId);
	assert.doesNotMatch(chunk, /sourceMappingURL/);
	assert.equal(existsSync(join(distDir, "static/chunks/app-1.js.map")), false);
	assert.equal(readDebugIdComment(read(distDir, "server/page.js")), null, "server output is untouched");
});

test("older Next: the webpack plugin runs in client production builds; a config function is wrapped too", async (t) => {
	inDir(t, nextProject("14.2.3"));
	const config = withAutterSourceMaps({ assetPrefix: "https://cdn.example.com" }, { ...silent, key: SERVER_KEY });
	assert.equal(config.productionBrowserSourceMaps, undefined);
	assert.equal(config.compiler, undefined);
	const client = config.webpack({ plugins: [] }, { isServer: false, dev: false });
	assert.equal(client.devtool, "hidden-source-map");
	assert.ok(client.plugins[0] instanceof Object && typeof client.plugins[0].apply === "function");
	assert.equal(config.webpack({ plugins: [] }, { isServer: false, dev: true }).plugins.length, 0);

	const fn = withAutterSourceMaps(async (phase) => ({ env: { phase } }), silent);
	const resolved = await fn("phase-production-build", { defaultConfig: {} });
	assert.equal(resolved.env.phase, "phase-production-build");
	assert.equal(typeof resolved.webpack, "function");

	// Maps the user already serves publicly stay public.
	const publicMaps = withAutterSourceMaps({ productionBrowserSourceMaps: true }, silent);
	assert.equal(publicMaps.webpack({ devtool: "source-map", plugins: [] }, { isServer: false, dev: false }).devtool, "source-map");
});

test("Next without a key: client maps stay off, and the hook says so once", async (t) => {
	withoutKey(t);
	const logs = captureLogs(t);
	const project = nextProject("15.5.0");
	inDir(t, project);
	const config = withAutterSourceMaps({});
	assert.equal(config.productionBrowserSourceMaps, undefined, "not forced on");
	assert.equal(config.webpack({ devtool: false, plugins: [] }, { isServer: false, dev: false }).devtool, false);
	const distDir = join(project, ".next");
	writeFiles(distDir, { "static/chunks/app-1.js": "console.log(1);\n" });
	await config.compiler.runAfterProductionCompile({ distDir, projectDir: project });
	assert.deepEqual(logs, ["[autter-runtime] AUTTER_RUNTIME_KEY is not set: no source maps generated, nothing uploaded"]);
	assert.equal(read(distDir, "static/chunks/app-1.js"), "console.log(1);\n");

	// Older Next: the webpack plugin leaves Next's devtool alone too.
	inDir(t, nextProject("14.2.3"));
	const old = withAutterSourceMaps({}, silent);
	const client = old.webpack({ devtool: false, plugins: [] }, { isServer: false, dev: false });
	assert.equal(client.devtool, false);
	const compiler = fakeCompiler({ mode: "production", devtool: client.devtool });
	client.plugins[0].apply(compiler);
	assert.equal(compiler.options.devtool, false);
});

test("Next: a rejected upload still deletes every client map the wrapper turned on (JS and CSS); server maps and public maps stay", async (t) => {
	const logs = captureLogs(t);
	const project = nextProject("15.5.0");
	inDir(t, project);
	const ingester = await startIngester();
	t.after(ingester.close);
	// A publishable key is refused by the CLI before anything is sent.
	const config = withAutterSourceMaps({}, { key: "autter_rtc_client", endpoint: ingester.url, release: "rel-1" });
	assert.equal(config.productionBrowserSourceMaps, true);
	const distDir = join(project, ".next");
	writeFiles(distDir, {
		"static/chunks/app-1.js": "console.log(1);\n//# sourceMappingURL=app-1.js.map\n",
		"static/chunks/app-1.js.map": SIMPLE_MAP,
		"static/css/app.css": "a{}\n/*# sourceMappingURL=app.css.map*/\n",
		"static/css/app.css.map": { version: 3, sources: ["app.css"], mappings: "AAAA" },
		"server/page.js": "x\n",
		"server/page.js.map": SIMPLE_MAP,
	});
	await config.compiler.runAfterProductionCompile({ distDir, projectDir: project });
	assert.equal(ingester.uploads().length, 0);
	assert.deepEqual(mapsUnder(join(distDir, "static")), []);
	assert.doesNotMatch(read(distDir, "static/chunks/app-1.js"), /sourceMappingURL/);
	assert.equal(read(distDir, "static/css/app.css"), "a{}\n");
	assert.ok(existsSync(join(distDir, "server/page.js.map")), "server output is untouched");
	assert.match(logs.find((line) => line.includes("removed")), /removed 2 source map\(s\) this plugin generated, so they are not deployed: the upload failed \(AUTTER_RUNTIME_KEY is a publishable client key/);

	// productionBrowserSourceMaps set by the user: their public maps stay, even when the upload fails.
	const failing = await startIngester({ rejectUploads: 413 });
	t.after(failing.close);
	const userMaps = withAutterSourceMaps({ productionBrowserSourceMaps: true }, { ...silent, key: SERVER_KEY, endpoint: failing.url, release: "rel-1" });
	writeFiles(distDir, { "static/chunks/app-1.js": "console.log(1);\n//# sourceMappingURL=app-1.js.map\n", "static/chunks/app-1.js.map": SIMPLE_MAP });
	await userMaps.compiler.runAfterProductionCompile({ distDir, projectDir: project });
	assert.equal(failing.uploads().length, 1);
	assert.ok(existsSync(join(distDir, "static/chunks/app-1.js.map")));
	assert.match(read(distDir, "static/chunks/app-1.js"), /sourceMappingURL=app-1\.js\.map/);

	// Older Next: the webpack plugin the wrapper adds deletes them too.
	inDir(t, nextProject("14.2.3"));
	const old = withAutterSourceMaps({}, { ...silent, key: SERVER_KEY, endpoint: failing.url, release: "rel-1" });
	const client = old.webpack({ devtool: false, plugins: [] }, { isServer: false, dev: false });
	assert.equal(client.devtool, "hidden-source-map");
	const compiler = fakeCompiler({ mode: "production", devtool: client.devtool });
	client.plugins[0].apply(compiler);
	const out = tempDir({ "static/chunks/a.js": "x\n", "static/chunks/a.js.map": SIMPLE_MAP });
	await compiler.taps[0].fn({
		outputOptions: { path: out, publicPath: "/_next/" },
		getAssets: () => [{ name: "static/chunks/a.js" }, { name: "static/chunks/a.js.map" }],
	});
	assert.deepEqual(mapsUnder(out), []);
});
