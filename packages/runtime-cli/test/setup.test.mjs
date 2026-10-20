// `autter-runtime sourcemaps setup`: each fixture is a small project in a
// temporary directory, set up through the built CLI with --json.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { read, readJson, snapshot, tempDir } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Run setup with a clean environment (no CI variables from the test runner). */
function setup(dir, ...args) {
	const run = spawnSync(process.execPath, [CLI, "sourcemaps", "setup", dir, "--json", ...args], {
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: process.env.HOME },
	});
	assert.ok(run.stdout, `setup printed nothing (exit ${run.status}): ${run.stderr}`);
	return { code: run.status, result: JSON.parse(run.stdout), stderr: run.stderr };
}

const pkg = (over = {}) => JSON.stringify({ name: "app", private: true, version: "0.0.0", ...over }, null, 2) + "\n";
const types = (result) => result.actions.map((a) => a.type);
const ofType = (result, type) => result.actions.filter((a) => a.type === type);
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

function viteProject(extra = {}) {
	return tempDir({
		"package.json": pkg({
			type: "module",
			scripts: { dev: "vite", build: "tsc -b && vite build" },
			dependencies: { "@autter/runtime-browser": "^1.6.0", react: "^19.0.0" },
			devDependencies: { "@vitejs/plugin-react": "^4.3.0", typescript: "^5.7.0", vite: "^6.0.0" },
		}),
		"package-lock.json": "{}",
		"tsconfig.json": "{}",
		"vite.config.ts": [
			"import { defineConfig } from 'vite'",
			"import react from '@vitejs/plugin-react'",
			"import type { UserConfig } from 'vite'",
			"",
			"// https://vite.dev/config/",
			"export default defineConfig({",
			"  plugins: [react()],",
			"  build: { outDir: 'build/web' },",
			"} satisfies UserConfig)",
			"",
		].join("\n"),
		"src/main.ts": 'import { initAutterBrowser } from "@autter/runtime-browser";\ninitAutterBrowser({ endpoint: "/api/autter-runtime", service: "web" });\n',
		".github/workflows/deploy.yml": "name: deploy\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci && npm run build\n",
		...extra,
	});
}

test("Vite + defineConfig (TypeScript): plugin added, devDependency added, and the JSON report", () => {
	const dir = viteProject();
	git(dir, "init", "-q");
	git(dir, "remote", "add", "origin", "https://github.com/acme/shop.git");
	const { code, result } = setup(dir);
	assert.equal(code, 2, "manual actions remain (release, workflow env)");

	// The JSON shape.
	assert.deepEqual(Object.keys(result).sort(), ["actions", "detected", "dir", "dryRun", "exitCode", "next", "secret"]);
	for (const action of result.actions) {
		assert.ok(["edit", "add-dependency", "add-script", "manual", "set-secret"].includes(action.type));
		assert.equal(typeof action.description, "string");
		for (const key of Object.keys(action)) assert.ok(["type", "file", "description", "snippet", "command"].includes(key), key);
	}
	assert.equal(result.secret.name, "AUTTER_RUNTIME_KEY");
	assert.ok(result.next.length > 0);
	const d = result.detected;
	assert.deepEqual([d.buildTool.id, d.buildTool.framework, d.buildTool.config], ["vite", null, "vite.config.ts"]);
	assert.deepEqual(d.packageManager, { name: "npm", lockfile: "package-lock.json" });
	assert.equal(d.outputDir, "build/web");
	assert.equal(d.sourceMaps.state, "default-off");
	assert.deepEqual(d.sdk, { package: "@autter/runtime-browser", range: "^1.6.0", installed: null, debugIds: true });
	assert.deepEqual(d.release, { file: "src/main.ts", passed: false });
	assert.deepEqual(d.ci, [{ id: "github", name: "GitHub Actions", evidence: ".github/workflows/deploy.yml", repo: "acme/shop" }]);

	// The edits: same quote and semicolon style, plugin appended last.
	assert.deepEqual(types(result), ["add-dependency", "edit", "manual", "set-secret", "manual"]);
	assert.equal(
		read(dir, "vite.config.ts"),
		[
			"import { defineConfig } from 'vite'",
			"import react from '@vitejs/plugin-react'",
			"import type { UserConfig } from 'vite'",
			"import { autterSourceMaps } from '@autter/runtime-cli/vite'",
			"",
			"// https://vite.dev/config/",
			"export default defineConfig({",
			"  plugins: [react(), autterSourceMaps()],",
			"  build: { outDir: 'build/web' },",
			"} satisfies UserConfig)",
			"",
		].join("\n"),
	);
	const manifest = readJson(dir, "package.json");
	assert.deepEqual(Object.keys(manifest.devDependencies), ["@autter/runtime-cli", "@vitejs/plugin-react", "typescript", "vite"]);
	assert.match(manifest.devDependencies["@autter/runtime-cli"], /^\^1\.\d+\.\d+$/);
	assert.match(read(dir, "package.json"), /^\{\n  "name"/, "indentation kept");
	assert.equal(ofType(result, "add-dependency")[0].command, `npm install --save-dev @autter/runtime-cli@${manifest.devDependencies["@autter/runtime-cli"]}`);

	// The release: a manual action with the define snippet, never an app-code edit.
	const release = ofType(result, "manual")[0];
	assert.match(release.description, /initAutterBrowser in src\/main\.ts gets no release/);
	assert.match(release.snippet, /"import\.meta\.env\.VITE_AUTTER_RELEASE": JSON\.stringify\(process\.env\.GITHUB_SHA \?\? process\.env\.GIT_SHA \?\? ""\)/);
	assert.match(read(dir, "src/main.ts"), /service: "web" \}\);\n$/);

	// The secret: the gh command for the remote's repo, reading the value from a prompt.
	assert.deepEqual(result.secret.where.map((w) => [w.ci, w.command]), [["github", "gh secret set AUTTER_RUNTIME_KEY --repo acme/shop"]]);
	assert.equal(ofType(result, "set-secret")[0].command, "gh secret set AUTTER_RUNTIME_KEY --repo acme/shop");
	const workflow = ofType(result, "manual")[1];
	assert.equal(workflow.file, ".github/workflows/deploy.yml");
	assert.match(workflow.snippet, /AUTTER_RUNTIME_KEY: \$\{\{ secrets\.AUTTER_RUNTIME_KEY \}\}/);
	// No key anywhere on disk.
	for (const file of Object.keys(snapshot(dir))) {
		if (!file.startsWith(".git/")) assert.doesNotMatch(read(dir, file), /autter_rt[uc]?_[A-Za-z0-9]/, file);
	}
	assert.match(result.next.join("\n"), /npx autter-runtime sourcemaps verify build\/web/);
});

test("re-running setup changes nothing, and reports only what is left", () => {
	const dir = viteProject();
	const first = setup(dir).result;
	assert.ok(types(first).includes("edit"));
	const before = snapshot(dir);
	const again = setup(dir);
	assert.deepEqual(snapshot(dir), before);
	assert.deepEqual(types(again.result), ["manual", "set-secret", "manual"]);
	assert.equal(again.code, 2);
	// Once the release and the workflow are wired by hand, it exits 0.
	const done = viteProject({
		"src/main.ts": 'initAutterBrowser({ service: "web", release: import.meta.env.VITE_AUTTER_RELEASE });\n',
		".github/workflows/deploy.yml": "steps:\n  - run: npm run build\n    env:\n      AUTTER_RUNTIME_KEY: ${{ secrets.AUTTER_RUNTIME_KEY }}\n",
	});
	setup(done);
	const clean = setup(done);
	assert.equal(clean.code, 0, JSON.stringify(clean.result.actions));
	assert.deepEqual(types(clean.result), ["set-secret"]);
});

test("--dry-run writes nothing but reports the same plan", () => {
	const dir = viteProject();
	const before = snapshot(dir);
	const { result } = setup(dir, "--dry-run");
	assert.equal(result.dryRun, true);
	assert.deepEqual(snapshot(dir), before);
	assert.deepEqual(types(result), ["add-dependency", "edit", "manual", "set-secret", "manual"]);
});

test("Next.js: withAutterSourceMaps goes outermost around withX wrappers (TypeScript and CommonJS)", () => {
	const nextProject = (config, file = "next.config.ts", extra = {}) =>
		tempDir({
			"package.json": pkg({ scripts: { build: "next build" }, dependencies: { next: "15.5.0", "@autter/runtime-next": "^1.6.1", react: "^19.0.0" } }),
			[file]: config,
			"vercel.json": "{}",
			"app/autter.tsx": '"use client";\nimport { initAutterBrowser } from "@autter/runtime-next/client";\ninitAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", release: process.env.NEXT_PUBLIC_AUTTER_RELEASE });\n',
			...extra,
		});

	const ts = nextProject(
		[
			'import type { NextConfig } from "next";',
			'import createNextIntlPlugin from "next-intl/plugin";',
			'import bundleAnalyzer from "@next/bundle-analyzer";',
			"",
			"const withNextIntl = createNextIntlPlugin();",
			'const withBundleAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === "true" });',
			"",
			"const nextConfig: NextConfig = {",
			"  reactStrictMode: true,",
			"};",
			"",
			"export default withBundleAnalyzer(withNextIntl(nextConfig));",
			"",
		].join("\n"),
	);
	const { code, result } = setup(ts);
	assert.equal(code, 0, JSON.stringify(result.actions, null, 2));
	assert.deepEqual(types(result), ["add-dependency", "edit", "set-secret"]);
	const edited = read(ts, "next.config.ts");
	assert.match(edited, /^import bundleAnalyzer from "@next\/bundle-analyzer";\nimport \{ withAutterSourceMaps \} from "@autter\/runtime-cli\/next";\n/m);
	assert.match(edited, /\nexport default withAutterSourceMaps\(withBundleAnalyzer\(withNextIntl\(nextConfig\)\)\);\n$/);
	assert.equal(result.detected.outputDir, ".next/static");
	assert.equal(result.detected.urlPrefix, "/_next/static/");
	assert.deepEqual(result.detected.release, { file: "app/autter.tsx", passed: true });
	assert.deepEqual(result.secret.where.map((w) => [w.ci, w.command]), [["vercel", "vercel env add AUTTER_RUNTIME_KEY production"]]);
	assert.match(result.next.join("\n"), /sourcemaps verify \.next\/static/);
	assert.equal(setup(ts).result.actions.filter((a) => a.type === "edit").length, 0, "idempotent");

	const cjs = nextProject("const withPWA = require('next-pwa')({ dest: 'public' })\n\nmodule.exports = withPWA({\n  reactStrictMode: true,\n})\n", "next.config.js");
	setup(cjs);
	assert.equal(
		read(cjs, "next.config.js"),
		"const withPWA = require('next-pwa')({ dest: 'public' })\nconst { withAutterSourceMaps } = require('@autter/runtime-cli/next')\n\nmodule.exports = withAutterSourceMaps(withPWA({\n  reactStrictMode: true,\n}))\n",
	);

	// create-next-app's JavaScript config: the JSDoc type stays on its declaration.
	const jsdoc = nextProject("/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  /* config options here */\n};\n\nexport default nextConfig;\n", "next.config.mjs");
	setup(jsdoc);
	assert.equal(
		read(jsdoc, "next.config.mjs"),
		"import { withAutterSourceMaps } from \"@autter/runtime-cli/next\";\n\n/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  /* config options here */\n};\n\nexport default withAutterSourceMaps(nextConfig);\n",
	);

	// Already wrapped, but not outermost: a manual action, no edit.
	const inner = nextProject('import { withAutterSourceMaps } from "@autter/runtime-cli/next";\nexport default withSentryConfig(withAutterSourceMaps({}));\n', "next.config.mjs");
	const before = snapshot(inner);
	const nested = setup(inner);
	assert.equal(nested.code, 2);
	assert.match(ofType(nested.result, "manual")[0].description, /not the outermost wrapper/);
	assert.equal(read(inner, "next.config.mjs"), 'import { withAutterSourceMaps } from "@autter/runtime-cli/next";\nexport default withSentryConfig(withAutterSourceMaps({}));\n');
	assert.notDeepEqual(snapshot(inner), before, "package.json still gains the dependency");
});

test("webpack: the plugin goes into module.exports and into a config function's returned object", () => {
	const project = (config) =>
		tempDir({
			"package.json": pkg({ scripts: { build: "webpack --mode production" }, devDependencies: { webpack: "^5.95.0", "webpack-cli": "^5.1.0" } }),
			"webpack.config.js": config,
		});
	const plain = project(
		[
			"'use strict';",
			"const path = require('path');",
			"const HtmlWebpackPlugin = require('html-webpack-plugin');",
			"",
			"module.exports = {",
			"  mode: 'production',",
			"  output: { path: path.resolve(__dirname, 'public/build'), publicPath: '/build/' },",
			"  plugins: [",
			"    new HtmlWebpackPlugin(),",
			"  ],",
			"};",
			"",
		].join("\n"),
	);
	const { result } = setup(plain);
	assert.deepEqual(types(result), ["add-dependency", "edit", "set-secret"]);
	assert.equal(
		read(plain, "webpack.config.js"),
		[
			"'use strict';",
			"const path = require('path');",
			"const HtmlWebpackPlugin = require('html-webpack-plugin');",
			"const { AutterSourceMapsWebpackPlugin } = require('@autter/runtime-cli/webpack');",
			"",
			"module.exports = {",
			"  mode: 'production',",
			"  output: { path: path.resolve(__dirname, 'public/build'), publicPath: '/build/' },",
			"  plugins: [",
			"    new HtmlWebpackPlugin(),",
			"    new AutterSourceMapsWebpackPlugin(),",
			"  ],",
			"};",
			"",
		].join("\n"),
	);
	assert.equal(result.detected.outputDir, "public/build");
	assert.equal(result.detected.urlPrefix, "/build/");

	const fn = project("module.exports = (env, argv) => ({\n  entry: './src/index.js',\n});\n");
	setup(fn);
	assert.equal(
		read(fn, "webpack.config.js"),
		"const { AutterSourceMapsWebpackPlugin } = require(\"@autter/runtime-cli/webpack\");\n\nmodule.exports = (env, argv) => ({\n  entry: './src/index.js',\n  plugins: [new AutterSourceMapsWebpackPlugin()],\n});\n",
	);
});

test("Create React App: a postbuild step with --best-effort, maps turned on, homepage as the URL prefix", () => {
	const dir = tempDir({
		"package.json": pkg({
			homepage: "https://acme.github.io/shop",
			scripts: { start: "react-scripts start", build: "react-scripts build", test: "react-scripts test" },
			dependencies: { react: "^18.3.0", "react-scripts": "5.0.1", "@autter/runtime-browser": "1.5.0" },
		}),
		".env": "BROWSER=none\nGENERATE_SOURCEMAP=false\n",
		"netlify.toml": "[build]\ncommand = \"npm run build\"\n",
		"src/index.js": "initAutterBrowser(options);\n",
	});
	const { code, result } = setup(dir);
	assert.equal(code, 2, "the SDK predates debug ids");
	const manifest = readJson(dir, "package.json");
	assert.deepEqual(Object.keys(manifest.scripts), ["start", "build", "postbuild", "test"]);
	assert.equal(
		manifest.scripts.postbuild,
		"autter-runtime sourcemaps inject build && autter-runtime sourcemaps upload build --url-prefix /shop/ --delete-after-upload --best-effort",
	);
	assert.equal(read(dir, ".env"), "BROWSER=none\nGENERATE_SOURCEMAP=true\n");
	assert.deepEqual(types(result), ["add-dependency", "add-script", "edit", "manual", "set-secret"]);
	assert.match(ofType(result, "manual")[0].description, /@autter\/runtime-browser 1\.5\.0 predates 1\.6\.0/);
	assert.equal(ofType(result, "manual")[0].command, "npm install @autter/runtime-browser@latest");
	assert.deepEqual(result.detected.release, { file: "src/index.js", passed: null });
	assert.deepEqual(result.secret.where.map((w) => [w.ci, w.command]), [["netlify", 'netlify env:set AUTTER_RUNTIME_KEY "$(cat)" --context production --scope builds --secret']]);

	// pnpm skips postbuild: the step is appended to build instead.
	const pnpm = tempDir({
		"package.json": pkg({ scripts: { build: "react-scripts build" }, dependencies: { "react-scripts": "5.0.1" } }),
		"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
	});
	const pnpmRun = setup(pnpm);
	assert.equal(readJson(pnpm, "package.json").scripts.build, "react-scripts build && autter-runtime sourcemaps inject build && autter-runtime sourcemaps upload build --delete-after-upload --best-effort");
	assert.equal(ofType(pnpmRun.result, "add-dependency")[0].command.split("@autter")[0], "pnpm add --save-dev ");
});

test("Angular: hidden script maps in the production configuration and a postbuild on the browser output", () => {
	const angular = {
		$schema: "./node_modules/@angular/cli/lib/config/schema.json",
		version: 1,
		projects: {
			shop: {
				projectType: "application",
				architect: {
					build: {
						builder: "@angular-devkit/build-angular:application",
						options: { outputPath: "dist/shop", browser: "src/main.ts", baseHref: "/shop/" },
						configurations: { production: { outputHashing: "all" }, development: { optimization: false, sourceMap: true } },
						defaultConfiguration: "production",
					},
				},
			},
		},
	};
	const dir = tempDir({
		"package.json": pkg({ scripts: { ng: "ng", build: "ng build" }, dependencies: { "@angular/core": "^19.0.0" }, devDependencies: { "@angular/cli": "^19.0.0" } }),
		"angular.json": JSON.stringify(angular, null, 2) + "\n",
		".gitlab-ci.yml": "build:\n  script: npm run build\n",
	});
	const { code, result } = setup(dir);
	assert.equal(code, 0, JSON.stringify(result.actions, null, 2));
	assert.deepEqual(types(result), ["add-dependency", "add-script", "edit", "set-secret"]);
	const edited = readJson(dir, "angular.json");
	assert.deepEqual(edited.projects.shop.architect.build.configurations.production, {
		outputHashing: "all",
		sourceMap: { scripts: true, styles: false, hidden: true, vendor: false },
	});
	assert.deepEqual(edited.projects.shop.architect.build.configurations.development, { optimization: false, sourceMap: true });
	assert.match(read(dir, "angular.json"), /^\{\n  "\$schema"/);
	assert.equal(
		readJson(dir, "package.json").scripts.postbuild,
		"autter-runtime sourcemaps inject dist/shop/browser && autter-runtime sourcemaps upload dist/shop/browser --url-prefix /shop/ --delete-after-upload --best-effort",
	);
	assert.equal(result.secret.where[0].ci, "gitlab");
	assert.equal(result.secret.where[0].command, undefined);
	assert.match(result.secret.where[0].note, /Masked/);
	const again = setup(dir);
	assert.deepEqual(types(again.result), ["set-secret"]);
});

test("configs setup can't edit safely get a manual action with the snippet, never an edit", () => {
	const weird = [
		["vite.config.js", "import { mergeConfig } from 'vite';\nimport base from './vite.base.js';\nexport default mergeConfig(base, { build: { sourcemap: true } });\n", /not an object literal/],
		["vite.config.mjs", "import { defineConfig } from 'vite';\nimport { plugins } from './plugins.js';\nexport default defineConfig({ plugins: plugins() });\n", /`plugins` is not an array literal/],
		["vite.config.mjs", "import base from './base.js';\nexport default { ...base, root: 'src' };\n", /spreads another object/],
		["vite.config.ts", "export default defineConfig({ plugins: [<Broken />] })\n", /does not parse as TypeScript/],
	];
	for (const [file, config, reason] of weird) {
		const dir = tempDir({
			"package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { vite: "^6.0.0" } }),
			[file]: config,
		});
		const { code, result } = setup(dir);
		assert.equal(code, 2, file);
		assert.equal(read(dir, file), config, `${file} untouched`);
		assert.ok(!types(result).includes("edit"), JSON.stringify(result.actions));
		const manual = ofType(result, "manual")[0];
		assert.equal(manual.file, file);
		assert.match(manual.description, reason);
		assert.match(manual.snippet, /import \{ autterSourceMaps \} from "@autter\/runtime-cli\/vite";[\s\S]*autterSourceMaps\(\)/);
	}
});

test("Nuxt and Astro get the plugin under vite.plugins", () => {
	const dir = tempDir({
		"package.json": pkg({ scripts: { build: "nuxt build" }, dependencies: { nuxt: "^3.14.0" } }),
		"nuxt.config.ts": "// https://nuxt.com/docs/api/configuration/nuxt-config\nexport default defineNuxtConfig({\n  devtools: { enabled: true },\n})\n",
	});
	const { result } = setup(dir);
	assert.equal(result.detected.buildTool.framework, "nuxt");
	assert.equal(result.detected.outputDir, ".output/public");
	assert.equal(
		read(dir, "nuxt.config.ts"),
		'import { autterSourceMaps } from "@autter/runtime-cli/vite";\n\n// https://nuxt.com/docs/api/configuration/nuxt-config\nexport default defineNuxtConfig({\n  devtools: { enabled: true },\n  vite: { plugins: [autterSourceMaps()] },\n})\n',
	);
	const astro = tempDir({
		"package.json": pkg({ scripts: { build: "astro build" }, dependencies: { astro: "^5.0.0" } }),
		"astro.config.mjs": "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  vite: {\n    plugins: [],\n  },\n});\n",
	});
	setup(astro);
	assert.match(read(astro, "astro.config.mjs"), /vite: \{\n {4}plugins: \[autterSourceMaps\(\)\],\n {2}\}/);
});

test("no package.json is an error (exit 1)", () => {
	const run = spawnSync(process.execPath, [CLI, "sourcemaps", "setup", tempDir()], { encoding: "utf8" });
	assert.equal(run.status, 1);
	assert.match(run.stderr, /no readable package\.json/);
});

test("a project that builds no JavaScript is left alone", () => {
	const dir = tempDir({ "package.json": pkg({ scripts: { start: "node server.js" }, dependencies: { express: "^4.21.2" } }) });
	const before = snapshot(dir);
	const { code, result } = setup(dir);
	assert.equal(code, 2);
	assert.deepEqual(snapshot(dir), before);
	assert.deepEqual(types(result), ["manual"]);
	assert.match(result.actions[0].description, /nothing to upload/);
	assert.deepEqual(result.secret.where, []);
});

test("edits keep comments where they were and the list's trailing-comma style", () => {
	const dir = tempDir({
		"package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { vite: "^6.0.0" } }),
		"vite.config.mjs": [
			"/** Licence header. */",
			"",
			"export default {",
			"  plugins: [",
			"    legacy(), // old browsers",
			"  ],",
			"  server: { port: 3000 } // dev only",
			"}",
			"",
		].join("\n"),
	});
	setup(dir);
	assert.equal(
		read(dir, "vite.config.mjs"),
		[
			"/** Licence header. */",
			"",
			'import { autterSourceMaps } from "@autter/runtime-cli/vite";',
			"",
			"export default {",
			"  plugins: [",
			"    legacy(), // old browsers",
			"    autterSourceMaps(),",
			"  ],",
			"  server: { port: 3000 } // dev only",
			"}",
			"",
		].join("\n"),
	);
});
