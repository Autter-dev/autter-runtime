import { dirname, resolve } from "node:path";
import {
	logMapsNotGenerated,
	processBuildOutput,
	serverUrlPrefix,
	shouldGenerateMaps,
	type AutterSourceMapsOptions,
} from "./build.js";
import { removeSourceMaps } from "./files.js";

export type { AutterSourceMapsOptions } from "./build.js";

type SourcemapSetting = boolean | "inline" | "hidden";

/** The parts of Vite's / Rollup's types this plugin touches (structural, so
 * neither bundler is a dependency). */
interface UserConfigLike {
	build?: { sourcemap?: SourcemapSetting; ssr?: boolean | string };
}
interface ResolvedConfigLike {
	base?: string;
	root?: string;
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
 * AUTTER_RUNTIME_KEY (or `key`) is set. Maps it turned on are deleted after
 * the upload step whatever its outcome; without a key it turns none on.
 * SSR builds and Vite 6 server environments are uploaded too (RF-05), under
 * their output directory's path in the project (`/dist/server/`), unless
 * `serverBundles: false`.
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
	let root = process.cwd();
	const serverBundles = options.serverBundles !== false;
	return {
		name: "autter-runtime-sourcemaps",
		apply: "build",
		enforce: "post",
		config(config) {
			isVite = true;
			const current = config.build?.sourcemap;
			// SSR builds get maps only when server bundles are uploaded (RF-05).
			if ((current === undefined || current === false) && (serverBundles || !config.build?.ssr)) {
				if (!shouldGenerateMaps(options)) {
					logMapsNotGenerated(options);
					return undefined;
				}
				enabledMaps = true;
				return { build: { sourcemap: "hidden" } };
			}
			return undefined;
		},
		configResolved(config) {
			ssr = Boolean(config.build?.ssr);
			if (config.root) root = config.root;
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
			if (!shouldGenerateMaps(options)) {
				logMapsNotGenerated(options);
				return null;
			}
			enabledMaps = true;
			return { ...output, sourcemap: "hidden" };
		},
		async writeBundle(output, bundle) {
			const dir = output.dir ?? (output.file ? dirname(output.file) : undefined);
			if (!dir) return;
			// Every map file Rollup wrote (JS and CSS alike).
			const maps = Object.values(bundle)
				.filter((file) => file.fileName.endsWith(".map"))
				.map((file) => resolve(dir, file.fileName));
			const files = Object.values(bundle)
				.filter((file) => file.type === "chunk")
				.map((file) => resolve(dir, file.fileName));
			// Server bundles (Vite SSR builds or a Vite 6+ server environment):
			// uploaded under their directory's path in the project, which the
			// ingester matches against the path Node runs them from (RF-05).
			const environment = (this as { environment?: { config?: { consumer?: string } } } | undefined)?.environment;
			const server = ssr || environment?.config?.consumer === "server";
			if (server && serverBundles) {
				await processBuildOutput({
					dir,
					files,
					maps,
					urlPrefix: serverUrlPrefix(root, dir),
					options,
					deleteAfterUpload: enabledMaps,
					ownMaps: enabledMaps,
					server: true,
				});
				return;
			}
			// `serverBundles: false`: server output is left alone, and maps we
			// turned on for it go.
			if (server) {
				if (enabledMaps && options.deleteAfterUpload !== false) {
					try {
						const removed = await removeSourceMaps(maps);
						if (removed.length && !options.silent) {
							console.log(`[autter-runtime] removed ${removed.length} source map(s) this plugin generated for a server bundle (not uploaded)`);
						}
					} catch (err) {
						if (!options.silent) console.warn(`[autter-runtime] could not delete server source maps: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				return;
			}
			await processBuildOutput({
				dir,
				files,
				maps,
				urlPrefix: base,
				options,
				deleteAfterUpload: enabledMaps,
				ownMaps: enabledMaps,
			});
		},
	};
}

export default autterSourceMaps;
