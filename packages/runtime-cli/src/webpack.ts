import { resolve } from "node:path";
import {
	logMapsNotGenerated,
	processBuildOutput,
	serverUrlPrefix,
	shouldGenerateMaps,
	type AutterSourceMapsOptions,
} from "./build.js";
import { BUNDLE_RE } from "./files.js";

export type { AutterSourceMapsOptions } from "./build.js";

const PLUGIN_NAME = "AutterSourceMapsWebpackPlugin";

/** The parts of webpack's types this plugin touches (structural, so webpack
 * is not a dependency). */
interface CompilationLike {
	outputOptions: { path?: string; publicPath?: unknown };
	getAssets(): ReadonlyArray<{ name: string }>;
}
interface CompilerLike {
	options: { mode?: string; devtool?: string | false; target?: unknown };
	/** The project directory webpack resolves from (`context`). */
	context?: string;
	outputPath?: string;
	hooks: {
		afterEmit: {
			tapPromise(name: string, fn: (compilation: CompilationLike) => Promise<void>): void;
		};
	};
}

/** webpack `target`s that build for a server runtime (Node, Electron main). */
const SERVER_TARGET_RE = /^(?:async-)?node|^electron-(?:main|preload)/;

/** Whether a webpack `target` (string, list or false) builds server code. */
export function isServerTarget(target: unknown): boolean {
	const targets = Array.isArray(target) ? target : [target];
	return targets.some((value) => typeof value === "string" && SERVER_TARGET_RE.test(value));
}

/**
 * webpack 5 plugin: turns on `hidden-source-map` in production builds that
 * have no `devtool`, gives every emitted JS asset a debug id after emit, and
 * uploads the maps when AUTTER_RUNTIME_KEY (or `key`) is set. Maps it turned
 * on are deleted after the upload step whatever its outcome; without a key
 * it turns none on. Development builds are left alone.
 *
 * Builds for a Node target (`target: "node"`, `"async-node"`,
 * `"electron-main"`) are server bundles (RF-05): their maps are stored under
 * the output directory's path in the project (`/dist/`), which the ingester
 * matches against the path Node runs them from, not under
 * `output.publicPath`. `serverBundles: false` leaves them alone.
 *
 * ```js
 * // webpack.config.js
 * const { AutterSourceMapsWebpackPlugin } = require("@autter/runtime-cli/webpack");
 * module.exports = { plugins: [new AutterSourceMapsWebpackPlugin()] };
 * ```
 */
export class AutterSourceMapsWebpackPlugin {
	constructor(
		private readonly options: AutterSourceMapsOptions = {},
		/** Set by withAutterSourceMaps, which chooses the devtool itself and
		 * knows which compilations are Next's server ones. */
		private readonly internal: { ownMaps?: boolean; server?: boolean } = {},
	) {}

	apply(compiler: CompilerLike): void {
		const mode = compiler.options.mode ?? (process.env.NODE_ENV === "development" ? "development" : undefined);
		if (mode === "development") return;
		const server = this.internal.server ?? isServerTarget(compiler.options.target);
		if (server && this.options.serverBundles === false) return;
		// Plugins are applied before webpack reads `devtool`, so this takes effect.
		let enabledMaps = this.internal.ownMaps ?? false;
		if (!compiler.options.devtool) {
			if (shouldGenerateMaps(this.options)) {
				compiler.options.devtool = "hidden-source-map";
				enabledMaps = true;
			} else {
				logMapsNotGenerated(this.options);
			}
		}
		compiler.hooks.afterEmit.tapPromise(PLUGIN_NAME, async (compilation) => {
			const dir = compilation.outputOptions.path ?? compiler.outputPath;
			if (!dir) return;
			const publicPath = compilation.outputOptions.publicPath;
			const urlPrefix = server
				? serverUrlPrefix(compiler.context ?? process.cwd(), dir)
				: typeof publicPath === "string" && publicPath !== "auto" && publicPath !== "" ? publicPath : "/";
			const assets = compilation.getAssets().map((asset) => asset.name);
			const files = assets.filter((name) => BUNDLE_RE.test(name)).map((name) => resolve(dir, name));
			// Every map webpack emitted (JS and CSS alike).
			const maps = assets.filter((name) => name.endsWith(".map")).map((name) => resolve(dir, name));
			await processBuildOutput({
				dir,
				files,
				maps,
				urlPrefix,
				options: this.options,
				deleteAfterUpload: enabledMaps,
				ownMaps: enabledMaps,
				...(server ? { server: true } : {}),
			});
		});
	}
}

/** Functional form: `plugins: [autterSourceMapsWebpack()]`. */
export function autterSourceMapsWebpack(options: AutterSourceMapsOptions = {}): AutterSourceMapsWebpackPlugin {
	return new AutterSourceMapsWebpackPlugin(options);
}

export default AutterSourceMapsWebpackPlugin;
