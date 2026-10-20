/**
 * `autter-runtime sourcemaps setup [dir]`: wire source map upload into a
 * project, for people and coding agents alike. Non-interactive and safe to
 * re-run: it detects the build tool, package manager, CI and SDK, makes the
 * edits it can make confidently (devDependency, bundler plugin, postbuild
 * script, hidden maps), and reports everything else as a `manual` action
 * with the exact snippet. It never writes a key anywhere.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	angularInfo,
	atLeast,
	CRA_ENV_FILES,
	detect,
	readText,
	workflowsPassKey,
	type CiId,
	type Detected,
	type DetectedCi,
	type PackageJson,
} from "./setup-detect.js";
import { addBundlerPlugin, wrapNextConfig, type EditResult } from "./setup-edit.js";

export type SetupActionType = "edit" | "add-dependency" | "add-script" | "manual" | "set-secret";

export interface SetupAction {
	type: SetupActionType;
	/** File the action is about, relative to the project. */
	file?: string;
	description: string;
	/** Code or config to add by hand (manual actions), or what was added. */
	snippet?: string;
	/** A command to run (it never contains a key). */
	command?: string;
}

export interface SecretTarget {
	ci: CiId | "other";
	name: string;
	/** Reads the value from a prompt or stdin, never from argv. */
	command?: string;
	note: string;
}

export interface SetupResult {
	dir: string;
	dryRun: boolean;
	detected: Detected;
	actions: SetupAction[];
	secret: { name: "AUTTER_RUNTIME_KEY"; key: string; where: SecretTarget[] };
	next: string[];
	/** Exit code: 0 when everything was applied, 2 when manual actions remain. */
	exitCode: 0 | 2;
}

export interface SetupOptions {
	dryRun?: boolean;
	/** Run the package manager's install command after editing package.json. */
	install?: boolean;
	/** Where the install command's output goes (default: inherit). */
	installOutput?: "inherit" | "stderr";
	env?: NodeJS.ProcessEnv;
}

const PKG = "@autter/runtime-cli";
const KEY_TEXT = "An upload-only key (autter_rtu_…) is recommended: it can only upload source maps. The full server key (autter_rt_…) also works.";
/** Oldest CLI with setup, verify and `upload --best-effort`. */
const MIN_CLI = "1.2.0";

function ownVersion(): string {
	try {
		return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
	} catch {
		return MIN_CLI;
	}
}

/** Files to write at the end (absolute path → content); reads see pending writes. */
class Changes {
	readonly files = new Map<string, string>();
	constructor(readonly dir: string) {}
	read(file: string): string | null {
		const path = join(this.dir, file);
		return this.files.get(path) ?? readText(path);
	}
	write(file: string, content: string): void {
		this.files.set(join(this.dir, file), content);
	}
}

/** JSON.stringify with the file's own indentation and final newline. */
function rewriteJson(text: string, value: unknown): string {
	const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
	return `${JSON.stringify(value, null, indent)}${text.endsWith("\n") ? "\n" : ""}`;
}

/** `obj` with `key` inserted after `after` (or at the end), keeping order. */
function insertAfter<T>(obj: Record<string, T>, after: string | null, key: string, value: T): Record<string, T> {
	const out: Record<string, T> = {};
	let placed = false;
	for (const [k, v] of Object.entries(obj)) {
		out[k] = v;
		if (k === after) {
			out[key] = value;
			placed = true;
		}
	}
	if (!placed) out[key] = value;
	return out;
}

/** The package manager's command to add `spec` (a dev dependency by default). */
function addCommand(detected: Detected, spec: string, dev = true): { command: string; argv: string[] } {
	const pm = detected.packageManager.name;
	const verb = pm === "npm" ? "install" : "add";
	const flag = pm === "npm" || pm === "pnpm" ? "--save-dev" : "--dev";
	const argv = [pm, verb, ...(dev ? [flag] : []), spec];
	return { command: argv.join(" "), argv };
}

const shellArg = (value: string) => (/^[\w./@:~-]+$/.test(value) ? value : JSON.stringify(value));

/** What a build without a bundler plugin runs after building. */
export function sourcemapsScript(outputDir: string, urlPrefix: string): string {
	const out = shellArg(outputDir);
	return (
		`autter-runtime sourcemaps inject ${out} && autter-runtime sourcemaps upload ${out}` +
		`${urlPrefix && urlPrefix !== "/" ? ` --url-prefix ${shellArg(urlPrefix)}` : ""} --delete-after-upload --best-effort`
	);
}

/** Commit variables of the detected CIs (hosting platforms first), then GIT_SHA. */
function commitVars(ci: DetectedCi[]): string[] {
	const byCi: Record<CiId, string> = {
		vercel: "VERCEL_GIT_COMMIT_SHA",
		netlify: "COMMIT_REF",
		"cloudflare-pages": "CF_PAGES_COMMIT_SHA",
		gitlab: "CI_COMMIT_SHA",
		github: "GITHUB_SHA",
	};
	const order: CiId[] = ["vercel", "netlify", "cloudflare-pages", "gitlab", "github"];
	const vars = order.filter((id) => ci.some((c) => c.id === id)).map((id) => byCi[id]);
	return [...vars, "GIT_SHA"];
}

function releaseSnippet(detected: Detected): { file: string | undefined; snippet: string } {
	const vars = commitVars(detected.ci);
	const expr = `${vars.map((v) => `process.env.${v}`).join(" ?? ")} ?? ""`;
	const shellVar = `$${vars[0]}`;
	const init = detected.release.file ?? "the file that calls initAutterBrowser";
	const tool = detected.buildTool;
	const config = tool.config ?? undefined;
	const call = (value: string) => `// ${init}\ninitAutterBrowser({ /* existing options */ release: ${value} });`;
	switch (tool.id) {
		case "vite": {
			const define = `define: {\n  "import.meta.env.VITE_AUTTER_RELEASE": JSON.stringify(${expr}),\n},`;
			const wrapped = tool.framework === "nuxt" || tool.framework === "astro" ? `vite: {\n  ${define.replace(/\n/g, "\n  ")}\n},` : define;
			return {
				file: config,
				snippet: `// ${config ?? "vite.config.ts"}: the commit SHA is not a secret\n${wrapped}\n\n${call("import.meta.env.VITE_AUTTER_RELEASE")}`,
			};
		}
		case "next":
			return {
				file: config,
				snippet: `// ${config ?? "next.config.mjs"}: the commit SHA is not a secret\nenv: { NEXT_PUBLIC_AUTTER_RELEASE: ${expr} },\n\n${call("process.env.NEXT_PUBLIC_AUTTER_RELEASE")}`,
			};
		case "webpack":
			return {
				file: config,
				snippet: `// ${config ?? "webpack.config.js"}\nnew webpack.DefinePlugin({ "process.env.AUTTER_RELEASE": JSON.stringify(${expr}) }),\n\n${call("process.env.AUTTER_RELEASE")}`,
			};
		case "rollup":
			return {
				file: config,
				snippet: `// ${config ?? "rollup.config.js"} (@rollup/plugin-replace)\nreplace({ preventAssignment: true, "process.env.AUTTER_RELEASE": JSON.stringify(${expr}) }),\n\n${call("process.env.AUTTER_RELEASE")}`,
			};
		case "cra":
			return {
				file: "package.json",
				snippet: `// package.json: CRA inlines REACT_APP_* variables\n"build": "REACT_APP_AUTTER_RELEASE=${shellVar} react-scripts build",\n\n${call("process.env.REACT_APP_AUTTER_RELEASE")}`,
			};
		case "angular":
			return {
				file: "package.json",
				snippet:
					`// package.json (Angular 17.2+ application builder)\n"build": "ng build --define \\"AUTTER_RELEASE='${shellVar}'\\"",\n\n` +
					`// ${init}\ndeclare const AUTTER_RELEASE: string | undefined;\n` +
					`initAutterBrowser({ /* existing options */ release: typeof AUTTER_RELEASE === "string" ? AUTTER_RELEASE : undefined });`,
			};
		case "parcel":
			return {
				file: "package.json",
				snippet: `// package.json: Parcel inlines process.env values at build time\n"build": "AUTTER_RELEASE=${shellVar} ${tool.buildScript ?? "parcel build"}",\n\n${call("process.env.AUTTER_RELEASE")}`,
			};
		case "esbuild":
			return {
				file: "package.json",
				snippet: `// the esbuild command\n--define:process.env.AUTTER_RELEASE=\\"${shellVar}\\"\n\n${call("process.env.AUTTER_RELEASE")}`,
			};
		default:
			return {
				file: undefined,
				snippet: `// Inline the commit SHA (${vars.join(", ")}) into the browser bundle with your build tool's define/env mechanism, then:\n${call("<the inlined commit SHA>")}`,
			};
	}
}

function secretTargets(detected: Detected): SecretTarget[] {
	const where: SecretTarget[] = [];
	for (const ci of detected.ci) {
		switch (ci.id) {
			case "github":
				where.push({
					ci: ci.id,
					name: ci.name,
					command: `gh secret set AUTTER_RUNTIME_KEY${ci.repo ? ` --repo ${ci.repo}` : ""}`,
					note: "gh prompts for the value (or reads it from stdin), so the key never reaches your shell history. Then pass it to the step that runs the production build: env: AUTTER_RUNTIME_KEY: ${{ secrets.AUTTER_RUNTIME_KEY }}",
				});
				break;
			case "vercel":
				where.push({
					ci: ci.id,
					name: ci.name,
					command: "vercel env add AUTTER_RUNTIME_KEY production",
					note: "vercel prompts for the value (or reads it from stdin). Add it for preview too (vercel env add AUTTER_RUNTIME_KEY preview) if preview builds should upload.",
				});
				break;
			case "netlify":
				where.push({
					ci: ci.id,
					name: ci.name,
					command: 'netlify env:set AUTTER_RUNTIME_KEY "$(cat)" --context production --scope builds --secret',
					note: "Paste the key, press Enter, then Ctrl-D: $(cat) reads it from stdin, so it stays out of your shell history. netlify env:set has no prompt; without a value it stores an empty one.",
				});
				break;
			case "cloudflare-pages":
				where.push({
					ci: ci.id,
					name: ci.name,
					note: "Cloudflare dashboard → Workers & Pages → your project → Settings → Variables and Secrets → Add: type Secret, name AUTTER_RUNTIME_KEY, for Production (and Preview if preview builds should upload). Builds read it from the environment.",
				});
				break;
			case "gitlab":
				where.push({
					ci: ci.id,
					name: ci.name,
					note: "GitLab → Settings → CI/CD → Variables → Add variable: key AUTTER_RUNTIME_KEY, visibility Masked (and Protected when only protected branches deploy). Jobs get it as an environment variable.",
				});
				break;
		}
	}
	if (!where.length) {
		where.push({
			ci: "other",
			name: "your build environment",
			note: "Add AUTTER_RUNTIME_KEY as a secret environment variable wherever the production build runs. Never in a committed .env file, and never under a public prefix (VITE_, NEXT_PUBLIC_, REACT_APP_, PUBLIC_).",
		});
	}
	return where;
}

const PLUGINS = {
	vite: { name: "autterSourceMaps", spec: "@autter/runtime-cli/vite", element: "autterSourceMaps()" },
	rollup: { name: "autterSourceMaps", spec: "@autter/runtime-cli/rollup", element: "autterSourceMaps()" },
	webpack: { name: "AutterSourceMapsWebpackPlugin", spec: "@autter/runtime-cli/webpack", element: "new AutterSourceMapsWebpackPlugin()" },
} as const;

function pluginSnippet(kind: keyof typeof PLUGINS, container: string | undefined, cjs: boolean): string {
	const plugin = PLUGINS[kind];
	const importLine = cjs ? `const { ${plugin.name} } = require("${plugin.spec}");` : `import { ${plugin.name} } from "${plugin.spec}";`;
	const plugins = `plugins: [/* existing plugins */ ${plugin.element}],`;
	const body = container ? `${container}: {\n    ${plugins}\n  },` : plugins;
	return `${importLine}\n\n// in the exported config object:\n  ${body}`;
}

/**
 * Detect, plan and (unless dryRun) apply. Throws only for a project setup
 * cannot read at all (no package.json).
 */
export function runSetup(dir: string, options: SetupOptions = {}): SetupResult {
	const env = options.env ?? process.env;
	const detected = detect(dir, env);
	const changes = new Changes(detected.dir);
	const actions: SetupAction[] = [];
	const next: string[] = [];
	const tool = detected.buildTool;
	const pkgText = changes.read("package.json")!;
	let pkg = JSON.parse(pkgText) as PackageJson;
	const version = ownVersion();
	const range = `^${atLeast(version, MIN_CLI) ? version : MIN_CLI}`;
	const install = addCommand(detected, `${PKG}@${range}`);
	const manual = (description: string, file?: string, snippet?: string, command?: string) =>
		actions.push({ type: "manual", ...(file ? { file } : {}), description, ...(snippet ? { snippet } : {}), ...(command ? { command } : {}) });
	const savePkg = () => changes.write("package.json", rewriteJson(changes.read("package.json")!, pkg));

	if (tool.id === "unknown" && !pkg.scripts?.build) {
		// Nothing builds JavaScript here: nothing to wire, nothing to install.
		manual(
			"No build tool and no build script: if this app ships hand-written, unminified scripts there is nothing to upload. If another step builds its JavaScript, run this after it, on the output directory",
			"package.json",
			sourcemapsScript("<output dir>", "/"),
		);
		return {
			dir: detected.dir,
			dryRun: Boolean(options.dryRun),
			detected,
			actions,
			secret: { name: "AUTTER_RUNTIME_KEY", key: KEY_TEXT, where: [] },
			next: ["Nothing was changed."],
			exitCode: 2,
		};
	}

	// 1. The dependency.
	const current = pkg.devDependencies?.[PKG] ?? pkg.dependencies?.[PKG];
	let dependencyChanged = false;
	if (!current) {
		const devDependencies = { ...pkg.devDependencies };
		const keys = Object.keys(devDependencies);
		const sorted = keys.every((k, i) => i === 0 || keys[i - 1]!.localeCompare(k) <= 0);
		devDependencies[PKG] = range;
		pkg = {
			...pkg,
			devDependencies: sorted ? Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b))) : devDependencies,
		};
		if (!("devDependencies" in JSON.parse(pkgText))) pkg = insertAfter(pkg as Record<string, unknown>, "dependencies", "devDependencies", pkg.devDependencies) as PackageJson;
		dependencyChanged = true;
		actions.push({ type: "add-dependency", file: "package.json", description: `Add ${PKG}@${range} to devDependencies`, command: install.command });
	} else if (atLeast(current, MIN_CLI) === false) {
		const section = pkg.devDependencies?.[PKG] ? "devDependencies" : "dependencies";
		pkg = { ...pkg, [section]: { ...pkg[section], [PKG]: range } };
		dependencyChanged = true;
		actions.push({
			type: "add-dependency",
			file: "package.json",
			description: `Raise ${PKG} from ${current} to ${range} (setup, verify and upload --best-effort need ${MIN_CLI})`,
			command: install.command,
		});
	}
	if (dependencyChanged) savePkg();

	// 2. The integration.
	const applyEdit = (result: EditResult, file: string, description: string, fallback: string) => {
		if (result.status === "edited") {
			changes.write(file, result.code);
			actions.push({ type: "edit", file, description });
		} else if (result.status === "manual") {
			manual(`${result.reason}: ${description[0]!.toLowerCase()}${description.slice(1)} by hand`, file, fallback);
		} else if (result.note) {
			next.push(result.note);
		}
	};
	const addScript = () => {
		const out = detected.outputDir;
		const scripts = { ...pkg.scripts };
		if (Object.values(scripts).some((s) => /autter-runtime\s+sourcemaps\s+(inject|upload)/.test(s))) return;
		if (!out) {
			manual("Could not tell where the build writes its output: after the production build, inject and upload from that directory", undefined, sourcemapsScript("<output dir>", "/"));
			return;
		}
		const script = sourcemapsScript(out, detected.urlPrefix);
		if (!scripts.build) {
			manual(`No build script in package.json: run this after the production build (it writes ${out})`, "package.json", script);
			return;
		}
		const { name: pm, yarnBerry } = detected.packageManager;
		// pnpm, Yarn 2+ and Bun skip pre/post scripts by default.
		const post = pm === "npm" || (pm === "yarn" && !yarnBerry);
		if (post) {
			pkg = { ...pkg, scripts: scripts.postbuild ? { ...scripts, postbuild: `${scripts.postbuild} && ${script}` } : insertAfter(scripts, "build", "postbuild", script) };
			actions.push({
				type: "add-script",
				file: "package.json",
				description: `${scripts.postbuild ? "Extend" : "Add"} the postbuild script: inject debug ids into ${out}, upload its maps, then delete them (with or without a key, so maps are never deployed; never fails the build)`,
				snippet: `"postbuild": ${JSON.stringify(pkg.scripts!.postbuild)}`,
			});
		} else {
			pkg = { ...pkg, scripts: { ...scripts, build: `${scripts.build} && ${script}` } };
			actions.push({
				type: "add-script",
				file: "package.json",
				description: `Append to the build script (${pm}${pm === "yarn" ? " 2+" : ""} does not run postbuild): inject debug ids into ${out}, upload its maps, then delete them (never fails the build)`,
				snippet: `"build": ${JSON.stringify(pkg.scripts!.build)}`,
			});
		}
		savePkg();
	};

	switch (tool.id) {
		case "vite":
		case "rollup": {
			const kind = tool.id;
			const container = tool.framework === "nuxt" || tool.framework === "astro" ? "vite" : undefined;
			if (tool.framework === "solid-start") {
				manual(
					"SolidStart's app.config wraps Vite through vinxi: add the plugin to the client router's Vite config by hand",
					tool.config ?? "app.config.ts",
					pluginSnippet("vite", "vite", false),
				);
				break;
			}
			if (!tool.config) {
				if (kind === "vite" && !tool.framework) {
					const file = existsSync(join(detected.dir, "tsconfig.json")) ? "vite.config.ts" : "vite.config.js";
					changes.write(
						file,
						`import { defineConfig } from "vite";\nimport { autterSourceMaps } from "@autter/runtime-cli/vite";\n\nexport default defineConfig({\n\tplugins: [autterSourceMaps()],\n});\n`,
					);
					actions.push({ type: "edit", file, description: `Create ${file} with the autterSourceMaps() plugin (the project had no Vite config)` });
				} else {
					manual(`No ${tool.framework ?? kind} config file found: create one with the plugin`, undefined, pluginSnippet(kind, container, false));
				}
				break;
			}
			const code = changes.read(tool.config)!;
			const cjs = /\bmodule\.exports\b/.test(code);
			applyEdit(
				addBundlerPlugin(code, tool.config, { ...PLUGINS[kind], container }),
				tool.config,
				`Add ${PLUGINS[kind].element} to the ${container ? `${container}.` : ""}plugins in ${tool.config}`,
				pluginSnippet(kind, container, cjs),
			);
			if (detected.sourceMaps.state === "inline") {
				manual(
					`${tool.config} writes inline source maps (${detected.sourceMaps.setting}): there are no map files to upload. Use "hidden"`,
					tool.config,
					kind === "vite" ? `build: { sourcemap: "hidden" },` : `output: { sourcemap: "hidden" },`,
				);
			}
			break;
		}
		case "webpack": {
			const container = tool.framework === "vue-cli" ? "configureWebpack" : undefined;
			if (!tool.config) {
				manual(
					`No ${tool.framework === "vue-cli" ? "vue.config.js" : "webpack config"} found: add the plugin to the config your build uses`,
					undefined,
					pluginSnippet("webpack", container, true),
				);
				break;
			}
			const code = changes.read(tool.config)!;
			const cjs = /\bmodule\.exports\b/.test(code) || !/\b(import|export)\b/.test(code);
			applyEdit(
				addBundlerPlugin(code, tool.config, { ...PLUGINS.webpack, container }),
				tool.config,
				`Add new AutterSourceMapsWebpackPlugin() to the ${container ? `${container}.` : ""}plugins in ${tool.config}`,
				pluginSnippet("webpack", container, cjs),
			);
			if (detected.sourceMaps.state === "inline") {
				manual(`${tool.config} uses an inline/eval devtool: there are no map files to upload. Use "hidden-source-map" for production`, tool.config, `devtool: "hidden-source-map",`);
			}
			break;
		}
		case "next": {
			const snippet =
				`import { withAutterSourceMaps } from "@autter/runtime-cli/next";\n\n` +
				`// outermost, around any other wrappers:\nexport default withAutterSourceMaps(withOtherPlugins(nextConfig));`;
			if (!tool.config) {
				changes.write("next.config.mjs", `import { withAutterSourceMaps } from "@autter/runtime-cli/next";\n\n/** @type {import("next").NextConfig} */\nconst nextConfig = {};\n\nexport default withAutterSourceMaps(nextConfig);\n`);
				actions.push({ type: "edit", file: "next.config.mjs", description: "Create next.config.mjs exporting withAutterSourceMaps(nextConfig) (the project had none)" });
			} else {
				applyEdit(wrapNextConfig(changes.read(tool.config)!, tool.config), tool.config, `Wrap the exported config in withAutterSourceMaps(...), outermost, in ${tool.config}`, snippet);
			}
			if (/--turbo(pack)?\b/.test(tool.buildScript ?? "") && atLeast(tool.version, "15.4.1") === false) {
				next.push(`Next.js ${tool.version} builds with Turbopack: withAutterSourceMaps covers Turbopack production builds from Next.js 15.4.1 (runAfterProductionCompile). Upgrade Next.js, or build with webpack.`);
			}
			break;
		}
		case "cra": {
			addScript();
			const sm = detected.sourceMaps;
			if (sm.state === "off" && sm.file && CRA_ENV_FILES.includes(sm.file)) {
				const text = changes.read(sm.file)!;
				changes.write(sm.file, text.replace(/^(\s*GENERATE_SOURCEMAP\s*=\s*)["']?false["']?/m, "$1true"));
				actions.push({
					type: "edit",
					file: sm.file,
					description: `Set GENERATE_SOURCEMAP=true in ${sm.file}: the postbuild step uploads the maps and deletes them, so they are never deployed`,
				});
			} else if (sm.state === "off") {
				manual("The build script sets GENERATE_SOURCEMAP=false: remove it (or set true) so there are maps to upload; the postbuild step deletes them", "package.json", `"build": "react-scripts build"`);
			}
			break;
		}
		case "angular": {
			addScript();
			const text = changes.read("angular.json");
			let json: Record<string, unknown> | null = null;
			try {
				json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
			} catch {
				json = null;
			}
			const info = json ? angularInfo(json) : null;
			const hidden = { scripts: true, styles: false, hidden: true, vendor: false };
			const sm = detected.sourceMaps.state;
			if (!json || !info) {
				manual("angular.json could not be read: turn on hidden script source maps for the production build", "angular.json", `"sourceMap": ${JSON.stringify(hidden)}`);
			} else if (sm === "default-off" || sm === "off") {
				const architect = ((json.projects as Record<string, Record<string, unknown>>)[info.project]!.architect ??
					(json.projects as Record<string, Record<string, unknown>>)[info.project]!.targets) as Record<string, Record<string, unknown>>;
				const build = architect.build!;
				const configurations = (build.configurations ?? {}) as Record<string, Record<string, unknown>>;
				if (configurations.production) configurations.production.sourceMap = hidden;
				else build.options = { ...(build.options as object), sourceMap: hidden };
				changes.write("angular.json", rewriteJson(text!, json));
				actions.push({
					type: "edit",
					file: "angular.json",
					description: `Turn on hidden script source maps for ${info.project}'s ${configurations.production ? "production " : ""}build (written next to the bundles, not referenced by them; the postbuild step uploads and deletes them)`,
					snippet: `"sourceMap": ${JSON.stringify(hidden)}`,
				});
			} else if (sm === "public") {
				next.push("angular.json emits public source maps (referenced by the bundles); the postbuild step deletes them after upload. Use \"sourceMap\": { \"scripts\": true, \"hidden\": true } to stop referencing them.");
			}
			break;
		}
		case "parcel":
			addScript();
			if (detected.sourceMaps.state === "off") {
				manual("The build script passes --no-source-maps: remove it so there are maps to upload (the postbuild step deletes them)", "package.json", (tool.buildScript ?? "").replace(/\s*--no-source-maps\b/, ""));
			}
			break;
		case "esbuild":
			addScript();
			if (detected.sourceMaps.state === "off" || detected.sourceMaps.state === "unknown") {
				manual(
					"Make esbuild write external source maps (written next to the bundles, not referenced by them): add --sourcemap=external to the esbuild command, or sourcemap: \"external\" to its build() options",
					"package.json",
					"--sourcemap=external",
				);
			} else if (detected.sourceMaps.state === "inline") {
				manual("esbuild writes inline source maps: there are no map files to upload. Use --sourcemap=external", "package.json", "--sourcemap=external");
			}
			break;
		default:
			if (detected.outputDir && pkg.scripts?.build) {
				addScript();
				manual(
					`Build tool not recognised: make sure the production build writes source maps (hidden if it can) into ${detected.outputDir}, and that ${detected.outputDir} is the deployed output`,
					undefined,
				);
			} else {
				manual(
					"Build tool not recognised: after the production build, inject debug ids and upload the maps from the output directory",
					undefined,
					sourcemapsScript(detected.outputDir ?? "<output dir>", "/"),
				);
			}
	}

	// 3. The release the browser SDK reports.
	if (detected.sdk.package && detected.release.file && detected.release.passed === false) {
		const { file, snippet } = releaseSnippet(detected);
		manual(
			`initAutterBrowser in ${detected.release.file} gets no release: pass the commit SHA through ${tool.id === "unknown" ? "your build tool's" : `${tool.id}'s`} public env or define mechanism, so release-based features match the upload (debug ids match maps either way)`,
			file ?? detected.release.file,
			snippet,
		);
	} else if (detected.sdk.package && detected.release.file && detected.release.passed === null) {
		next.push(`Check that initAutterBrowser in ${detected.release.file} passes release: the commit SHA (setup could not read its options).`);
	}
	if (detected.sdk.package && detected.sdk.debugIds === false) {
		manual(
			`${detected.sdk.package} ${detected.sdk.installed ?? detected.sdk.range} predates 1.6.0, so exceptions carry no debug ids: upgrade it`,
			"package.json",
			undefined,
			addCommand(detected, `${detected.sdk.package}@latest`, false).command,
		);
	}
	if (!detected.sdk.package) {
		next.push("No Autter browser SDK in package.json: source maps resolve browser errors that @autter/runtime-browser (or @autter/runtime-next) 1.6.0+ reports. Set it up first, or alongside.");
	}
	if (detected.sourceMaps.state === "public" && tool.id !== "angular") {
		next.push(
			`${detected.sourceMaps.file ?? "The build"} emits public source maps (${detected.sourceMaps.setting}): your source is downloadable from production. Switch to hidden maps, or set deleteAfterUpload: true on the plugin, if you don't publish them on purpose.`,
		);
	}

	// 4. The key.
	const where = secretTargets(detected);
	for (const target of where) {
		actions.push({
			type: "set-secret",
			description: `Store AUTTER_RUNTIME_KEY in ${target.name}${target.command ? "" : `: ${target.note}`}`,
			...(target.command ? { command: target.command } : {}),
		});
	}
	const hosting = detected.ci.some((c) => c.id === "vercel" || c.id === "netlify" || c.id === "cloudflare-pages");
	if (detected.ci.some((c) => c.id === "github") && !workflowsPassKey(detected.dir, detected.gitRoot)) {
		const snippet = `- run: ${detected.packageManager.name === "npm" ? "npm run" : detected.packageManager.name} build\n  env:\n    AUTTER_RUNTIME_KEY: \${{ secrets.AUTTER_RUNTIME_KEY }}`;
		if (hosting) {
			next.push(`If a GitHub workflow builds the deployed output, give that step the key:\n${snippet}`);
		} else {
			manual(
				"Pass the secret to the GitHub Actions step that runs the production build (only that job; never to jobs that run untrusted pull request code)",
				detected.ci.find((c) => c.id === "github")!.evidence,
				snippet,
			);
		}
	}

	// 5. Write.
	if (!options.dryRun) {
		for (const [path, content] of changes.files) writeFileSync(path, content);
	}
	const needsInstall = dependencyChanged || !detected.cli.installed;
	if (needsInstall && options.install && !options.dryRun) {
		const [command, ...args] = install.argv;
		const result = spawnSync(command!, args, {
			cwd: detected.dir,
			stdio: options.installOutput === "stderr" ? ["ignore", 2, 2] : "inherit",
			shell: process.platform === "win32",
		});
		if (result.status !== 0) throw new Error(`${install.command} failed (exit ${result.status ?? result.signal ?? "unknown"})`);
	} else if (needsInstall) {
		next.push(`Install it: ${install.command}`);
	}
	next.push(
		"Get an upload-only key (autter_rtu_…) for this repository from Autter: it can only upload source maps, so it is the right key for CI. The full server key (autter_rt_…) also works. Never paste it into chat or commit it.",
		`Store it as AUTTER_RUNTIME_KEY where the production build runs (see secret.where). Without it, builds still pass and upload nothing.`,
	);
	if (detected.outputDir) {
		next.push(`After a production build with the key set, check it: npx autter-runtime sourcemaps verify ${shellArg(detected.outputDir)}`);
	}

	return {
		dir: detected.dir,
		dryRun: Boolean(options.dryRun),
		detected,
		actions,
		secret: {
			name: "AUTTER_RUNTIME_KEY",
			key: KEY_TEXT,
			where,
		},
		next,
		exitCode: actions.some((a) => a.type === "manual") ? 2 : 0,
	};
}

const LABEL: Record<SetupActionType, string> = {
	edit: "edit",
	"add-dependency": "dependency",
	"add-script": "script",
	manual: "manual",
	"set-secret": "secret",
};

/** Human-readable report. */
export function formatSetup(result: SetupResult): string[] {
	const d = result.detected;
	const lines: string[] = [`autter-runtime sourcemaps setup${result.dryRun ? " (dry run: nothing written)" : ""}: ${d.dir}`, "", "Detected"];
	const row = (label: string, value: string) => lines.push(`  ${label.padEnd(16)} ${value}`);
	const tool = d.buildTool;
	row("build tool", `${tool.id}${tool.framework ? ` (${tool.framework})` : ""}${tool.config ? `, ${tool.config}` : ""}${tool.version ? `, ${tool.version}` : ""}`);
	row("package manager", `${d.packageManager.name}${d.packageManager.lockfile ? ` (${d.packageManager.lockfile})` : ""}`);
	row("CI", d.ci.length ? d.ci.map((c) => `${c.name} (${c.evidence}${c.repo ? `, ${c.repo}` : ""})`).join("; ") : "none found");
	row("output", `${d.outputDir ?? "unknown"}${d.urlPrefix !== "/" ? `, served from ${d.urlPrefix}` : ""}`);
	row("source maps", `${d.sourceMaps.state}${d.sourceMaps.setting ? ` (${d.sourceMaps.setting})` : ""}`);
	row(
		"browser SDK",
		d.sdk.package ? `${d.sdk.package} ${d.sdk.installed ?? d.sdk.range}${d.sdk.debugIds === false ? " (no debug ids: needs 1.6.0+)" : ""}` : "none in package.json",
	);
	row(
		"release",
		d.release.file ? `${d.release.file}: ${d.release.passed === true ? "passed" : d.release.passed === false ? "not passed" : "could not tell"}` : "no initAutterBrowser call found",
	);
	row("runtime-cli", d.cli.range ? `${d.cli.range}${d.cli.installed ? ` (installed ${d.cli.installed})` : " (not installed)"}` : "not in package.json");
	lines.push("", "Actions");
	if (!result.actions.length) lines.push("  nothing to do");
	for (const action of result.actions) {
		const status = action.type === "manual" ? "TODO" : action.type === "set-secret" ? "KEY " : result.dryRun ? "PLAN" : "DONE";
		lines.push(`  ${status} ${LABEL[action.type].padEnd(10)} ${action.file ? `${action.file}: ` : ""}${action.description}`);
		if (action.command) lines.push(`         run: ${action.command}`);
		if (action.snippet && action.type === "manual") for (const line of action.snippet.split("\n")) lines.push(`         | ${line}`);
	}
	lines.push("", `Secret: ${result.secret.name}. ${result.secret.key}`);
	for (const target of result.secret.where) {
		lines.push(`  ${target.name}: ${target.command ?? ""}${target.command ? "" : target.note}`);
		if (target.command) lines.push(`    ${target.note}`);
	}
	lines.push("", "Next");
	result.next.forEach((item, i) => lines.push(`  ${i + 1}. ${item.replace(/\n/g, "\n     ")}`));
	return lines;
}
