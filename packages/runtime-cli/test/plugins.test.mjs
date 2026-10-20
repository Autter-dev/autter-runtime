import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rollup } from "rollup";
import { hasDebugIdSnippet, readDebugIdComment } from "../dist/index.js";
import { withAutterSourceMaps } from "../dist/next.js";
import { autterSourceMaps } from "../dist/vite.js";
import { AutterSourceMapsWebpackPlugin } from "../dist/webpack.js";
import { decodeMappings, read, readJson, SERVER_KEY, SIMPLE_MAP, startIngester, tempDir, writeFiles } from "./helpers.mjs";

const silent = { silent: true };

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
	}
});

test("Rollup without a key: debug ids are injected, maps stay on disk, nothing is sent", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const saved = process.env.AUTTER_RUNTIME_KEY;
	delete process.env.AUTTER_RUNTIME_KEY;
	t.after(() => { if (saved !== undefined) process.env.AUTTER_RUNTIME_KEY = saved; });
	const src = tempDir(SOURCES);
	const out = tempDir();
	await rollupBuild(src, out, autterSourceMaps({ ...silent, endpoint: ingester.url, release: "rel-1" }));
	assert.equal(ingester.requests.length, 0);
	const main = (await import("node:fs")).readdirSync(join(out, "assets")).find((f) => f.startsWith("main-") && f.endsWith(".js"));
	assert.ok(readDebugIdComment(read(out, `assets/${main}`)));
	assert.ok(readJson(out, `assets/${main}.map`).debugId);
});

test("Rollup keeps maps the user turned on, and their sourceMappingURL", async (t) => {
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
	const config = withAutterSourceMaps({ assetPrefix: "https://cdn.example.com" }, silent);
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
