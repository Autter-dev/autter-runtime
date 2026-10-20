/**
 * What `autter-runtime sourcemaps setup` finds in a project: build tool,
 * package manager, CI, output directory, existing source map settings, the
 * Autter browser SDK and whether `initAutterBrowser` gets a release. Read
 * only: nothing here writes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { exportedConfigObject, findProperty, literalProperty, nextConfigObject, parseFile, unwrap, type AnyNode } from "./setup-edit.js";

export type BuildToolId = "vite" | "next" | "webpack" | "rollup" | "cra" | "angular" | "parcel" | "esbuild" | "unknown";
export type CiId = "github" | "vercel" | "netlify" | "cloudflare-pages" | "gitlab";
export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

/** How the project emits source maps today. */
export type SourceMapState =
	| "off" // explicitly off
	| "default-off" // not configured, and the tool emits none by default
	| "hidden" // emitted, not referenced from the bundles
	| "public" // emitted and referenced (`sourceMappingURL`): served to anyone
	| "default-public" // not configured, and the tool emits public maps by default
	| "inline" // inside the bundles (data: URLs)
	| "unknown";

export interface DetectedBuildTool {
	id: BuildToolId;
	/** A framework that drives the tool: sveltekit, nuxt, astro, remix, react-router, solid, solid-start, qwik, vue-cli, craco. */
	framework: string | null;
	/** The config file setup reads or edits (relative to the project). */
	config: string | null;
	/** The tool's version range from package.json. */
	version: string | null;
	/** The `build` script, when there is one. */
	buildScript: string | null;
}

export interface DetectedCi {
	id: CiId;
	name: string;
	/** The file or variable that gave it away. */
	evidence: string;
	/** GitHub: owner/repo from the git remote. */
	repo?: string | null;
}

export interface Detected {
	/** Absolute project directory (the one with package.json). */
	dir: string;
	buildTool: DetectedBuildTool;
	packageManager: { name: PackageManagerName; lockfile: string | null; yarnBerry?: boolean };
	ci: DetectedCi[];
	/** The build output directory to inject/upload/verify (relative). */
	outputDir: string | null;
	/** Where the output is served from ("/" unless the project says otherwise). */
	urlPrefix: string;
	sourceMaps: { state: SourceMapState; setting: string | null; file: string | null };
	sdk: { package: "@autter/runtime-browser" | "@autter/runtime-next" | null; range: string | null; installed: string | null; debugIds: boolean | null };
	/** Where initAutterBrowser is called, and whether it gets a `release`
	 * (null when the call passes something setup can't read). */
	release: { file: string | null; passed: boolean | null };
	/** @autter/runtime-cli in package.json, and its installed version. */
	cli: { range: string | null; installed: string | null };
	gitRoot: string | null;
}

export interface PackageJson {
	name?: string;
	type?: string;
	homepage?: string;
	packageManager?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

const posix = (path: string) => path.split(sep).join("/");
export const rel = (from: string, to: string) => posix(relative(from, to)) || ".";

export function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function readJson<T>(path: string): T | null {
	const text = readText(path);
	if (text === null) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

const firstExisting = (dir: string, names: string[]) => names.find((name) => existsSync(join(dir, name))) ?? null;

/** The directories from `dir` up to `stop` (inclusive) or the filesystem root. */
function ancestors(dir: string, stop: string | null): string[] {
	const out: string[] = [];
	for (let current = dir; ; current = dirname(current)) {
		out.push(current);
		if (current === stop || dirname(current) === current) break;
	}
	return out;
}

export function gitRoot(dir: string): string | null {
	for (const current of ancestors(dir, null)) if (existsSync(join(current, ".git"))) return current;
	return null;
}

/** owner/repo of the GitHub remote (origin first), or null. */
export function githubRepo(root: string | null): string | null {
	if (!root) return null;
	const git = (args: string[]) => {
		try {
			return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
		} catch {
			return "";
		}
	};
	const remotes = git(["remote"]).split("\n").filter(Boolean);
	for (const remote of remotes.includes("origin") ? ["origin", ...remotes.filter((r) => r !== "origin")] : remotes) {
		const url = git(["remote", "get-url", remote]);
		const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
		if (match) return `${match[1]}/${match[2]}`;
	}
	return null;
}

function semver(version: string | null | undefined): [number, number, number] | null {
	const match = version ? /(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** version >= minimum; null when the version can't be read. */
export function atLeast(version: string | null | undefined, minimum: string): boolean | null {
	const a = semver(version);
	const b = semver(minimum)!;
	if (!a) return null;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
	return true;
}

/** The installed version of a package, looked up like Node resolves it. */
function installedVersion(dir: string, name: string): string | null {
	for (const current of ancestors(dir, null)) {
		const manifest = readJson<{ version?: string }>(join(current, "node_modules", ...name.split("/"), "package.json"));
		if (manifest?.version) return manifest.version;
	}
	return null;
}

function packageManager(dir: string, pkg: PackageJson, stop: string | null): Detected["packageManager"] {
	for (const current of ancestors(dir, stop)) {
		const manifest = current === dir ? pkg : readJson<PackageJson>(join(current, "package.json"));
		const declared = /^(npm|pnpm|yarn|bun)@(\S+)/.exec(manifest?.packageManager ?? "");
		if (declared) {
			const name = declared[1] as PackageManagerName;
			const lockfile = lockfileIn(current);
			return { name, lockfile: lockfile ? rel(dir, join(current, lockfile)) : null, ...(name === "yarn" ? { yarnBerry: !declared[2]!.startsWith("1.") } : {}) };
		}
		const lockfile = lockfileIn(current);
		if (lockfile) {
			const name: PackageManagerName = lockfile.startsWith("pnpm") ? "pnpm" : lockfile === "yarn.lock" ? "yarn" : lockfile.startsWith("bun") ? "bun" : "npm";
			const berry = name === "yarn" && (existsSync(join(current, ".yarnrc.yml")) || (readText(join(current, lockfile)) ?? "").includes("__metadata:"));
			return { name, lockfile: rel(dir, join(current, lockfile)), ...(name === "yarn" ? { yarnBerry: berry } : {}) };
		}
	}
	return { name: "npm", lockfile: null };
}

function lockfileIn(dir: string): string | null {
	return firstExisting(dir, ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json"]);
}

/** The value after `--flag value` / `--flag=value` / `-f value` in a script. */
export function scriptFlag(script: string | null, ...flags: string[]): string | null {
	if (!script) return null;
	for (const flag of flags) {
		const match = new RegExp(`(?:^|\\s)${flag.replace(/[-]/g, "\\-")}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s&|;]+))`).exec(script);
		if (match) return match[1] ?? match[2] ?? match[3] ?? null;
	}
	return null;
}

const CONFIG_NAMES = {
	vite: ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cts", "vite.config.cjs"],
	next: ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"],
	webpack: ["webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts"],
	rollup: ["rollup.config.js", "rollup.config.mjs", "rollup.config.cjs", "rollup.config.ts"],
	nuxt: ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"],
	astro: ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.mts", "astro.config.cjs"],
	"vue-cli": ["vue.config.js", "vue.config.cjs", "vue.config.mjs"],
	"solid-start": ["app.config.ts", "app.config.js"],
} as const;

function buildTool(dir: string, pkg: PackageJson): DetectedBuildTool {
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const has = (name: string) => typeof deps[name] === "string";
	const buildScript = pkg.scripts?.build ?? null;
	const scriptConfig = (tool: string) => {
		if (!buildScript || !new RegExp(`\\b${tool}\\b`).test(buildScript)) return null;
		const file = scriptFlag(buildScript, "--config", "-c");
		return file && existsSync(join(dir, file)) ? file : null;
	};
	const tool = (id: BuildToolId, framework: string | null, config: string | null, versionOf: string): DetectedBuildTool => ({
		id,
		framework,
		config,
		version: deps[versionOf] ?? null,
		buildScript,
	});
	if (has("next")) return tool("next", null, firstExisting(dir, [...CONFIG_NAMES.next]), "next");
	if (has("react-scripts")) return tool("cra", has("@craco/craco") ? "craco" : null, null, "react-scripts");
	if (existsSync(join(dir, "angular.json")) && (has("@angular/core") || has("@angular/cli"))) {
		return tool("angular", null, "angular.json", has("@angular/cli") ? "@angular/cli" : "@angular/core");
	}
	const viteConfig = scriptConfig("vite") ?? firstExisting(dir, [...CONFIG_NAMES.vite]);
	if (has("nuxt")) return tool("vite", "nuxt", firstExisting(dir, [...CONFIG_NAMES.nuxt]), "nuxt");
	if (has("astro")) return tool("vite", "astro", firstExisting(dir, [...CONFIG_NAMES.astro]), "astro");
	if (has("@solidjs/start")) return tool("vite", "solid-start", firstExisting(dir, [...CONFIG_NAMES["solid-start"]]), "@solidjs/start");
	const viteFrameworks: Array<[string, string]> = [
		["@sveltejs/kit", "sveltekit"],
		["@remix-run/dev", "remix"],
		["@react-router/dev", "react-router"],
		["@builder.io/qwik", "qwik"],
		["vite-plugin-solid", "solid"],
	];
	for (const [dep, framework] of viteFrameworks) {
		if (has(dep) && (viteConfig || has("vite"))) return tool("vite", framework, viteConfig, has("vite") ? "vite" : dep);
	}
	// A bare dependency (vite for vitest, webpack for Storybook) is not the
	// build tool: it also needs a config file or the build script to run it.
	const builds = (name: string) => has(name) && new RegExp(`\\b${name}\\b`).test(buildScript ?? "");
	if (viteConfig || builds("vite")) return tool("vite", null, viteConfig, "vite");
	if (has("@vue/cli-service")) return tool("webpack", "vue-cli", firstExisting(dir, [...CONFIG_NAMES["vue-cli"]]), "@vue/cli-service");
	const webpackConfig = scriptConfig("webpack") ?? firstExisting(dir, [...CONFIG_NAMES.webpack]);
	if (webpackConfig || builds("webpack")) return tool("webpack", null, webpackConfig, "webpack");
	const rollupConfig = scriptConfig("rollup") ?? firstExisting(dir, [...CONFIG_NAMES.rollup]);
	if (rollupConfig || builds("rollup")) return tool("rollup", null, rollupConfig, "rollup");
	if (has("parcel") || /\bparcel\b/.test(buildScript ?? "")) return tool("parcel", null, null, "parcel");
	if (/\besbuild\b/.test(buildScript ?? "")) return tool("esbuild", null, null, "esbuild");
	return tool("unknown", null, null, "");
}

function ciProviders(dir: string, root: string | null, env: NodeJS.ProcessEnv): DetectedCi[] {
	const found: DetectedCi[] = [];
	const top = root ?? dir;
	const near = (names: string[]) => {
		for (const current of ancestors(dir, top)) {
			const name = firstExisting(current, names);
			if (name) return rel(dir, join(current, name));
		}
		return null;
	};
	const workflows = join(top, ".github", "workflows");
	let workflowFile: string | null = null;
	try {
		workflowFile = readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f)).sort()[0] ?? null;
	} catch {
		// no workflows
	}
	if (workflowFile) {
		found.push({ id: "github", name: "GitHub Actions", evidence: rel(dir, join(workflows, workflowFile)), repo: githubRepo(root) });
	} else if (env.GITHUB_ACTIONS === "true") {
		found.push({ id: "github", name: "GitHub Actions", evidence: "GITHUB_ACTIONS", repo: env.GITHUB_REPOSITORY ?? githubRepo(root) });
	}
	const vercel = near(["vercel.json", ".vercel"]);
	if (vercel || env.VERCEL) found.push({ id: "vercel", name: "Vercel", evidence: vercel ?? "VERCEL" });
	const netlify = near(["netlify.toml"]);
	if (netlify || env.NETLIFY) found.push({ id: "netlify", name: "Netlify", evidence: netlify ?? "NETLIFY" });
	const wrangler = near(["wrangler.toml", "wrangler.json", "wrangler.jsonc"]);
	const pagesConfig = wrangler && /pages_build_output_dir/.test(readText(join(dir, wrangler)) ?? "") ? wrangler : null;
	const pkg = readJson<PackageJson>(join(dir, "package.json"));
	const pagesScript = Object.values(pkg?.scripts ?? {}).some((s) => /wrangler\s+pages\b/.test(s)) ? "package.json (wrangler pages)" : null;
	if (pagesConfig || pagesScript || env.CF_PAGES) {
		found.push({ id: "cloudflare-pages", name: "Cloudflare Pages", evidence: pagesConfig ?? pagesScript ?? "CF_PAGES" });
	}
	const gitlab = near([".gitlab-ci.yml"]);
	if (gitlab || env.GITLAB_CI) found.push({ id: "gitlab", name: "GitLab CI", evidence: gitlab ?? "GITLAB_CI" });
	return found;
}

/** Whether a GitHub workflow already hands AUTTER_RUNTIME_KEY to a step. */
export function workflowsPassKey(dir: string, root: string | null): boolean {
	const workflows = join(root ?? dir, ".github", "workflows");
	try {
		return readdirSync(workflows).some((f) => /\.ya?ml$/.test(f) && /secrets\.AUTTER_RUNTIME_KEY\b/.test(readText(join(workflows, f)) ?? ""));
	} catch {
		return false;
	}
}

interface AngularInfo {
	project: string;
	outputDir: string;
	sourceMap: unknown;
	urlPrefix: string;
}

/** The first application in angular.json: its browser output and production source map setting. */
export function angularInfo(json: Record<string, unknown>): AngularInfo | null {
	const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
	const names = Object.keys(projects);
	const name =
		(typeof json.defaultProject === "string" && projects[json.defaultProject] ? json.defaultProject : null) ??
		names.find((n) => projects[n]!.projectType === "application") ??
		names[0];
	if (!name) return null;
	const project = projects[name]!;
	const build = ((project.architect ?? project.targets) as Record<string, Record<string, unknown>> | undefined)?.build;
	if (!build) return null;
	const options = (build.options ?? {}) as Record<string, unknown>;
	const production = ((build.configurations as Record<string, Record<string, unknown>> | undefined)?.production ?? {}) as Record<string, unknown>;
	const application = typeof build.builder === "string" && /:application$/.test(build.builder);
	const outputPath = production.outputPath ?? options.outputPath ?? `dist/${name}`;
	let outputDir: string;
	if (outputPath && typeof outputPath === "object") {
		const { base, browser } = outputPath as { base?: string; browser?: string };
		outputDir = browser === "" ? String(base) : `${base}/${browser ?? "browser"}`;
	} else {
		outputDir = application ? `${outputPath}/browser` : String(outputPath);
	}
	const prefix = production.deployUrl ?? options.deployUrl ?? production.baseHref ?? options.baseHref;
	return {
		project: name,
		outputDir,
		sourceMap: "sourceMap" in production ? production.sourceMap : options.sourceMap,
		urlPrefix: typeof prefix === "string" && prefix.startsWith("/") ? prefix : "/",
	};
}

function mapStateFromLiteral(value: unknown, onTrue: SourceMapState = "public"): SourceMapState {
	if (value === true) return onTrue;
	if (value === false) return "off";
	if (value === "hidden") return "hidden";
	if (value === "inline") return "inline";
	return "unknown";
}

/** CRA reads GENERATE_SOURCEMAP from these, highest precedence first. */
export const CRA_ENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

function craEnv(dir: string, name: string): { value: string; file: string } | null {
	for (const file of CRA_ENV_FILES) {
		const match = new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\s#]*)`, "m").exec(readText(join(dir, file)) ?? "");
		if (match) return { value: match[1]!, file };
	}
	return null;
}

interface OutputFacts {
	outputDir: string | null;
	urlPrefix: string;
	sourceMaps: Detected["sourceMaps"];
}

function parseConfig(dir: string, config: string | null): AnyNode | null {
	if (!config) return null;
	const code = readText(join(dir, config));
	return code === null ? null : parseFile(code, config);
}

function outputFacts(dir: string, pkg: PackageJson, tool: DetectedBuildTool): OutputFacts {
	const script = tool.buildScript;
	const none = (state: SourceMapState, setting: string | null = null, file: string | null = null) => ({ state, setting, file });
	switch (tool.id) {
		case "vite": {
			const ast = parseConfig(dir, tool.config);
			const obj = ast ? exportedConfigObject(ast) : null;
			const base = tool.framework === "nuxt" || tool.framework === "astro" ? ["vite"] : [];
			const sourcemap = literalProperty(obj, [...base, "build", "sourcemap"]);
			const viteBase = literalProperty(obj, [...base, "base"]);
			const outDir =
				(tool.framework === "astro" ? literalProperty(obj, ["outDir"]) : literalProperty(obj, [...base, "build", "outDir"])) ??
				scriptFlag(script, "--outDir");
			const defaults: Record<string, string> = {
				nuxt: ".output/public",
				"solid-start": ".output/public",
				sveltekit: "build",
				remix: "build/client",
				"react-router": "build/client",
			};
			return {
				outputDir: typeof outDir === "string" ? outDir : (defaults[tool.framework ?? ""] ?? "dist"),
				urlPrefix: typeof viteBase === "string" && viteBase.startsWith("/") ? viteBase : "/",
				sourceMaps:
					sourcemap === undefined
						? none(obj || !tool.config ? "default-off" : "unknown")
						: none(mapStateFromLiteral(sourcemap), `build.sourcemap: ${JSON.stringify(sourcemap)}`, tool.config),
			};
		}
		case "next": {
			const ast = parseConfig(dir, tool.config);
			const obj = ast ? nextConfigObject(ast) : null;
			const distDir = literalProperty(obj, ["distDir"]);
			const exported = literalProperty(obj, ["output"]) === "export";
			const publicMaps = literalProperty(obj, ["productionBrowserSourceMaps"]);
			const basePath = literalProperty(obj, ["assetPrefix"]) ?? literalProperty(obj, ["basePath"]);
			return {
				outputDir: exported ? "out" : `${typeof distDir === "string" ? distDir : ".next"}/static`,
				urlPrefix: exported
					? `${typeof basePath === "string" ? basePath.replace(/\/+$/, "") : ""}/`
					: `${typeof basePath === "string" ? basePath.replace(/\/+$/, "") : ""}/_next/static/`,
				sourceMaps:
					publicMaps === true
						? none("public", "productionBrowserSourceMaps: true", tool.config)
						: none(obj || !tool.config ? "default-off" : "unknown"),
			};
		}
		case "webpack":
		case "rollup": {
			const ast = parseConfig(dir, tool.config);
			const obj = ast ? exportedConfigObject(ast) : null;
			if (tool.framework === "vue-cli") {
				const productionSourceMap = literalProperty(obj, ["productionSourceMap"]);
				const outputDir = literalProperty(obj, ["outputDir"]);
				const publicPath = literalProperty(obj, ["publicPath"]);
				return {
					outputDir: typeof outputDir === "string" ? outputDir : "dist",
					urlPrefix: typeof publicPath === "string" && publicPath.startsWith("/") ? publicPath : "/",
					sourceMaps:
						productionSourceMap === false
							? none("off", "productionSourceMap: false", tool.config)
							: none("default-public", productionSourceMap === true ? "productionSourceMap: true" : null, tool.config),
				};
			}
			if (tool.id === "webpack") {
				const devtool = literalProperty(obj, ["devtool"]);
				const path = obj ? outputPathOf(obj) : null;
				const publicPath = literalProperty(obj, ["output", "publicPath"]);
				return {
					outputDir: path ?? "dist",
					urlPrefix: typeof publicPath === "string" && publicPath.startsWith("/") ? publicPath : "/",
					sourceMaps:
						devtool === undefined
							? none(obj || !tool.config ? "default-off" : "unknown")
							: none(
									devtool === false ? "off" : typeof devtool === "string" ? (devtool.includes("hidden") ? "hidden" : devtool.includes("inline") || devtool.startsWith("eval") ? "inline" : "public") : "unknown",
									`devtool: ${JSON.stringify(devtool)}`,
									tool.config,
								),
				};
			}
			const outDir = literalProperty(obj, ["output", "dir"]);
			const outFile = literalProperty(obj, ["output", "file"]);
			const sourcemap = literalProperty(obj, ["output", "sourcemap"]);
			return {
				outputDir: typeof outDir === "string" ? outDir : typeof outFile === "string" ? posix(dirname(outFile)) : "dist",
				urlPrefix: "/",
				sourceMaps:
					sourcemap === undefined
						? none(obj || !tool.config ? "default-off" : "unknown")
						: none(mapStateFromLiteral(sourcemap), `output.sourcemap: ${JSON.stringify(sourcemap)}`, tool.config),
			};
		}
		case "cra": {
			const buildPath = (script && /BUILD_PATH=(\S+)/.exec(script)?.[1]) ?? craEnv(dir, "BUILD_PATH")?.value;
			const inScript = script ? /GENERATE_SOURCEMAP=(\w+)/.exec(script) : null;
			const fromEnv = craEnv(dir, "GENERATE_SOURCEMAP");
			const homepage = pkg.homepage ? homepagePath(pkg.homepage) : "/";
			const setting = inScript ? { value: inScript[1]!, file: "package.json" } : fromEnv;
			return {
				outputDir: buildPath || "build",
				urlPrefix: homepage,
				sourceMaps: setting
					? none(setting.value === "false" ? "off" : "default-public", `GENERATE_SOURCEMAP=${setting.value}`, setting.file)
					: none("default-public"),
			};
		}
		case "angular": {
			const json = readJson<Record<string, unknown>>(join(dir, "angular.json"));
			const info = json ? angularInfo(json) : null;
			if (!info) return { outputDir: null, urlPrefix: "/", sourceMaps: none("unknown", null, "angular.json") };
			const sm = info.sourceMap as { scripts?: boolean; hidden?: boolean } | boolean | undefined;
			const state: SourceMapState =
				sm === undefined
					? "default-off"
					: sm === false
						? "off"
						: sm === true
							? "public"
							: sm.scripts === false
								? "off"
								: sm.hidden
									? "hidden"
									: "public";
			return {
				outputDir: info.outputDir,
				urlPrefix: info.urlPrefix,
				sourceMaps: none(state, sm === undefined ? null : `sourceMap: ${JSON.stringify(sm)}`, "angular.json"),
			};
		}
		case "parcel": {
			const off = /--no-source-maps\b/.test(script ?? "");
			const publicUrl = scriptFlag(script, "--public-url");
			return {
				outputDir: scriptFlag(script, "--dist-dir") ?? "dist",
				urlPrefix: publicUrl && publicUrl.startsWith("/") ? publicUrl : "/",
				sourceMaps: off ? none("off", "--no-source-maps", "package.json") : none("default-public"),
			};
		}
		case "esbuild": {
			const flag = script ? /--sourcemap(?:=(\w+))?/.exec(script) : null;
			const outfile = scriptFlag(script, "--outfile");
			return {
				outputDir: scriptFlag(script, "--outdir") ?? (outfile ? posix(dirname(outfile)) : "dist"),
				urlPrefix: "/",
				sourceMaps: flag
					? none(flag[1] === "external" ? "hidden" : flag[1] === "inline" ? "inline" : "public", flag[0], "package.json")
					: none(script && /\besbuild\b/.test(script) ? "off" : "unknown"),
			};
		}
		default: {
			const existing = ["dist", "build", "out"].find((d) => existsSync(join(dir, d)) && statSync(join(dir, d)).isDirectory());
			return { outputDir: existing ?? null, urlPrefix: "/", sourceMaps: none("unknown") };
		}
	}
}

/** `output.path` of a webpack config: a string, or `path.resolve|join(__dirname, "dist")`. */
function outputPathOf(obj: AnyNode): string | null {
	const output = findProperty(obj, "output");
	if (!output || output === "ambiguous") return null;
	const value = unwrap(output.value);
	if (value?.type !== "ObjectExpression") return null;
	const path = findProperty(value, "path");
	if (!path || path === "ambiguous") return null;
	const node = unwrap(path.value);
	if (node?.type === "Literal" && typeof node.value === "string") return node.value;
	if (node?.type === "CallExpression" && node.callee?.type === "MemberExpression" && ["resolve", "join"].includes(node.callee.property?.name)) {
		const parts = (node.arguments as AnyNode[]).filter((a) => !(a.type === "Identifier" && a.name === "__dirname"));
		if (parts.every((a) => a.type === "Literal" && typeof a.value === "string")) return parts.map((a) => a.value as string).join("/") || null;
	}
	return null;
}

/** The path part of CRA's `homepage` ("https://x.github.io/app" → "/app/"). */
function homepagePath(homepage: string): string {
	if (homepage === "." || homepage === "./") return "/";
	try {
		const path = new URL(homepage, "https://autter.invalid").pathname;
		return path.endsWith("/") ? path : `${path}/`;
	} catch {
		return "/";
	}
}

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "public", "static", "storybook-static"]);

/** Every `initAutterBrowser({...})` call in the project's source. */
function releaseFacts(dir: string, skip: Set<string>): Detected["release"] {
	const found: Array<{ file: string; passed: boolean | null }> = [];
	const visit = (current: string) => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name) && !skip.has(full)) visit(full);
			} else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
				const code = readText(full);
				if (!code?.includes("initAutterBrowser")) continue;
				for (const passed of initCalls(code)) found.push({ file: rel(dir, full), passed });
			}
		}
	};
	visit(dir);
	if (!found.length) return { file: null, passed: null };
	const missing = found.find((f) => f.passed === false);
	const unknown = found.find((f) => f.passed === null);
	const pick = missing ?? unknown ?? found[0]!;
	return { file: pick.file, passed: missing ? false : unknown ? null : true };
}

/** For each `initAutterBrowser(` call: does its options object set `release`? */
export function initCalls(code: string): Array<boolean | null> {
	const out: Array<boolean | null> = [];
	const re = /\binitAutterBrowser\s*\(/g;
	for (let match = re.exec(code); match; match = re.exec(code)) {
		// Skip the import specifier and type positions: only calls have "(".
		let i = match.index + match[0].length;
		while (/\s/.test(code[i] ?? "")) i++;
		if (code[i] !== "{") {
			out.push(code[i] === ")" ? false : null);
			continue;
		}
		let depth = 0;
		let quote: string | null = null;
		let sawRelease = false;
		let sawSpread = false;
		for (; i < code.length; i++) {
			const ch = code[i]!;
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") quote = ch;
			else if (ch === "{" || ch === "(" || ch === "[") depth++;
			else if (ch === "}" || ch === ")" || ch === "]") {
				depth--;
				if (depth === 0) break;
			} else if (depth === 1) {
				if (code.startsWith("...", i)) sawSpread = true;
				if (/[\s{,]/.test(code[i - 1] ?? "") && /^release\s*[:,}(]/.test(code.slice(i, i + 20))) sawRelease = true;
			}
		}
		out.push(sawRelease ? true : sawSpread ? null : false);
	}
	return out;
}

export function detect(dir: string, env: NodeJS.ProcessEnv = process.env): Detected {
	const root = resolve(dir);
	const pkg = readJson<PackageJson>(join(root, "package.json"));
	if (!pkg) throw new Error(`no readable package.json in ${root}`);
	const git = gitRoot(root);
	const tool = buildTool(root, pkg);
	const facts = outputFacts(root, pkg, tool);
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const sdkPackage = deps["@autter/runtime-next"] ? "@autter/runtime-next" : deps["@autter/runtime-browser"] ? "@autter/runtime-browser" : null;
	const sdkInstalled = sdkPackage ? installedVersion(root, sdkPackage) : null;
	const skip = new Set(facts.outputDir ? [resolve(root, facts.outputDir.split("/")[0]!)] : []);
	return {
		dir: root,
		buildTool: tool,
		packageManager: packageManager(root, pkg, git),
		ci: ciProviders(root, git, env),
		outputDir: facts.outputDir,
		urlPrefix: facts.urlPrefix,
		sourceMaps: facts.sourceMaps,
		sdk: {
			package: sdkPackage,
			range: sdkPackage ? deps[sdkPackage]! : null,
			installed: sdkInstalled,
			debugIds: sdkPackage ? atLeast(sdkInstalled ?? deps[sdkPackage], "1.6.0") : null,
		},
		release: releaseFacts(root, skip),
		cli: { range: deps["@autter/runtime-cli"] ?? null, installed: installedVersion(root, "@autter/runtime-cli") },
		gitRoot: git,
	};
}
