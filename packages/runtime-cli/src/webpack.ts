import { resolve } from "node:path";
import { processBuildOutput, type AutterSourceMapsOptions } from "./build.js";
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
	options: { mode?: string; devtool?: string | false };
	outputPath?: string;
	hooks: {
		afterEmit: {
			tapPromise(name: string, fn: (compilation: CompilationLike) => Promise<void>): void;
		};
	};
}

/**
 * webpack 5 plugin: turns on `hidden-source-map` in production builds that
 * have no `devtool`, gives every emitted JS asset a debug id after emit, and
 * uploads the maps when AUTTER_RUNTIME_KEY (or `key`) is set. Development
 * builds are left alone.
 *
 * ```js
 * // webpack.config.js
 * const { AutterSourceMapsWebpackPlugin } = require("@autter/runtime-cli/webpack");
 * module.exports = { plugins: [new AutterSourceMapsWebpackPlugin()] };
 * ```
 */
export class AutterSourceMapsWebpackPlugin {
	constructor(private readonly options: AutterSourceMapsOptions = {}) {}

	apply(compiler: CompilerLike): void {
		const mode = compiler.options.mode ?? (process.env.NODE_ENV === "development" ? "development" : undefined);
		if (mode === "development") return;
		// Plugins are applied before webpack reads `devtool`, so this takes effect.
		let enabledMaps = false;
		if (!compiler.options.devtool) {
			compiler.options.devtool = "hidden-source-map";
			enabledMaps = true;
		}
		compiler.hooks.afterEmit.tapPromise(PLUGIN_NAME, async (compilation) => {
			const dir = compilation.outputOptions.path ?? compiler.outputPath;
			if (!dir) return;
			const publicPath = compilation.outputOptions.publicPath;
			const urlPrefix = typeof publicPath === "string" && publicPath !== "auto" && publicPath !== "" ? publicPath : "/";
			const files = compilation
				.getAssets()
				.map((asset) => asset.name)
				.filter((name) => BUNDLE_RE.test(name))
				.map((name) => resolve(dir, name));
			await processBuildOutput({ dir, files, urlPrefix, options: this.options, deleteAfterUpload: enabledMaps });
		});
	}
}

/** Functional form: `plugins: [autterSourceMapsWebpack()]`. */
export function autterSourceMapsWebpack(options: AutterSourceMapsOptions = {}): AutterSourceMapsWebpackPlugin {
	return new AutterSourceMapsWebpackPlugin(options);
}

export default AutterSourceMapsWebpackPlugin;
