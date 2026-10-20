import { dirname, resolve } from "node:path";
import { processBuildOutput, type AutterSourceMapsOptions } from "./build.js";

export type { AutterSourceMapsOptions } from "./build.js";

type SourcemapSetting = boolean | "inline" | "hidden";

/** The parts of Vite's / Rollup's types this plugin touches (structural, so
 * neither bundler is a dependency). */
interface UserConfigLike {
	build?: { sourcemap?: SourcemapSetting; ssr?: boolean | string };
}
interface ResolvedConfigLike {
	base?: string;
	build?: { sourcemap?: SourcemapSetting; ssr?: boolean | string };
}
interface OutputOptionsLike {
	dir?: string;
	file?: string;
	sourcemap?: SourcemapSetting;
}
interface OutputFileLike {
	type: "chunk" | "asset";
	fileName: string;
}

export interface AutterSourceMapsPlugin {
	name: string;
	apply: "build";
	enforce: "post";
	config(config: UserConfigLike): { build: { sourcemap: "hidden" } } | undefined;
	configResolved(config: ResolvedConfigLike): void;
	outputOptions(options: OutputOptionsLike): OutputOptionsLike | null;
	writeBundle(this: unknown, options: OutputOptionsLike, bundle: Record<string, OutputFileLike>): Promise<void>;
}

/**
 * Vite and Rollup plugin: turns on hidden source maps, gives every emitted
 * chunk a debug id after the bundle is written, and uploads the maps when
 * AUTTER_RUNTIME_KEY (or `key`) is set.
 *
 * ```ts
 * // vite.config.ts
 * import { autterSourceMaps } from "@autter/runtime-cli/vite";
 * export default defineConfig({ plugins: [autterSourceMaps()] });
 * ```
 */
export function autterSourceMaps(options: AutterSourceMapsOptions = {}): AutterSourceMapsPlugin {
	let isVite = false;
	let enabledMaps = false;
	let ssr = false;
	let base = "/";
	return {
		name: "autter-runtime-sourcemaps",
		apply: "build",
		enforce: "post",
		config(config) {
			isVite = true;
			const current = config.build?.sourcemap;
			if (current === undefined || current === false) {
				enabledMaps = true;
				return { build: { sourcemap: "hidden" } };
			}
			return undefined;
		},
		configResolved(config) {
			ssr = Boolean(config.build?.ssr);
			// A relative base ("./") is resolved against the page at run time;
			// "/" is the right guess for where the assets are then served.
			if (config.base && /^(\/|[a-z][\w+.-]*:\/\/)/i.test(config.base)) base = config.base;
			if (config.build?.sourcemap === "inline" && !options.silent) {
				console.warn("[autter-runtime] build.sourcemap is \"inline\": there are no map files to upload; use \"hidden\"");
			}
		},
		outputOptions(output) {
			// Plain Rollup (Vite already set build.sourcemap in `config`).
			if (isVite || (output.sourcemap !== undefined && output.sourcemap !== false)) return null;
			enabledMaps = true;
			return { ...output, sourcemap: "hidden" };
		},
		async writeBundle(output, bundle) {
			// Server bundles (Vite SSR builds or a Vite 6+ server environment)
			// never reach the browser SDK.
			const environment = (this as { environment?: { config?: { consumer?: string } } } | undefined)?.environment;
			if (ssr || environment?.config?.consumer === "server") return;
			const dir = output.dir ?? (output.file ? dirname(output.file) : undefined);
			if (!dir) return;
			const files = Object.values(bundle)
				.filter((file) => file.type === "chunk")
				.map((file) => resolve(dir, file.fileName));
			await processBuildOutput({
				dir,
				files,
				urlPrefix: base,
				options,
				deleteAfterUpload: enabledMaps,
			});
		},
	};
}

export default autterSourceMaps;
