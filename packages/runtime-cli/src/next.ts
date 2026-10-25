import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
	logMapsNotGenerated,
	processBuildOutput,
	serverUrlPrefix,
	shouldGenerateMaps,
	type AutterSourceMapsOptions,
} from "./build.js";
import { findMapFiles } from "./files.js";
import { AutterSourceMapsWebpackPlugin } from "./webpack.js";

export type { AutterSourceMapsOptions } from "./build.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NextConfigObject = Record<string, any>;
type NextConfigFunction = (
	phase: string,
	context: { defaultConfig: NextConfigObject },
) => NextConfigObject | Promise<NextConfigObject>;

interface WebpackContextLike {
	isServer: boolean;
	dev: boolean;
	/** "nodejs" or "edge" on server compilations. */
	nextRuntime?: string;
	/** The project directory. */
	dir?: string;
}
interface WebpackConfigLike {
	devtool?: string | false;
	plugins?: unknown[];
}

/** First Next.js release with `compiler.runAfterProductionCompile`, which
 * runs after both webpack and Turbopack production builds. */
const AFTER_COMPILE_HOOK_SINCE = [15, 4, 1] as const;

/** The project's installed Next.js version, or null. */
export function installedNextVersion(cwd: string = process.cwd()): string | null {
	try {
		const version = (createRequire(join(cwd, "package.json"))("next/package.json") as { version?: unknown }).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

function hasAfterCompileHook(version: string | null): boolean {
	const match = version ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
	if (!match) return false;
	const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
	for (let i = 0; i < 3; i++) {
		if (parts[i]! !== AFTER_COMPILE_HOOK_SINCE[i]) return parts[i]! > AFTER_COMPILE_HOOK_SINCE[i]!;
	}
	return true;
}

function wrapConfig(config: NextConfigObject, options: AutterSourceMapsOptions): NextConfigObject {
	// Maps the user already serves publicly stay public and stay on disk.
	const publicMaps = config.productionBrowserSourceMaps === true;
	// Otherwise client maps exist only because of this wrapper: only when they
	// can be uploaded (see shouldGenerateMaps), and never left in .next/static.
	const ownMaps = !publicMaps && shouldGenerateMaps(options);
	const deleteAfterUpload = options.deleteAfterUpload ?? !publicMaps;
	// Server output (RF-05): `.next/server` (Node and edge) gets debug ids and
	// its maps uploaded too, stored under `/<distDir>/server/` so the ingester
	// matches the path Node runs it from (`/var/task/.next/server/app/page.js`).
	// Maps the user (`experimental.serverSourceMaps`) or Next configured stay;
	// maps the wrapper turned on are deleted after the upload step.
	const serverBundles = options.serverBundles !== false;
	const userServerMaps = config.experimental?.serverSourceMaps !== undefined;
	const ownServerMaps = serverBundles && !userServerMaps && shouldGenerateMaps(options);
	// A server compilation whose devtool the user's webpack function chose:
	// those maps are theirs, uploaded but never deleted.
	let serverDevtoolPreset = false;
	let notified = false;
	const notifyNoMaps = () => {
		if (!publicMaps && !ownMaps && !notified) {
			notified = true;
			logMapsNotGenerated(options);
		}
	};
	const base = String(config.assetPrefix || config.basePath || "").replace(/\/+$/, "");
	const nextPrefix = `${base}/_next/`;
	const useHook = hasAfterCompileHook(installedNextVersion());
	const userWebpack = config.webpack as
		| ((webpackConfig: WebpackConfigLike, context: WebpackContextLike) => WebpackConfigLike)
		| undefined;

	const wrapped: NextConfigObject = {
		...config,
		webpack(webpackConfig: WebpackConfigLike, context: WebpackContextLike): WebpackConfigLike {
			// Next's own devtool, before the user's function may change it.
			const nextDevtool = webpackConfig.devtool;
			const result = typeof userWebpack === "function" ? userWebpack(webpackConfig, context) : webpackConfig;
			// Production builds only: Next reverts devtool changes in dev.
			if (context.dev) return result;
			if (!context.isServer) {
				// Without a key Next's own setting stays (no client maps); the
				// webpack plugin or the after-compile hook says so once.
				if (ownMaps) result.devtool = "hidden-source-map";
				if (!useHook) {
					result.plugins = [
						...(result.plugins ?? []),
						new AutterSourceMapsWebpackPlugin(
							{ ...options, urlPrefix: options.urlPrefix ?? nextPrefix, deleteAfterUpload },
							{ ownMaps },
						),
					];
				}
				return result;
			}
			if (!serverBundles) return result;
			// Maps the user's webpack function asked for stay theirs. Otherwise,
			// with a key, the wrapper owns server maps: hidden ones, whatever
			// Next set (on 15.4.1+ its devtool follows the serverSourceMaps flag
			// the wrapper itself turned on for Turbopack).
			const preset = Boolean(result.devtool) && (result.devtool !== nextDevtool || !ownServerMaps);
			if (preset) serverDevtoolPreset = true;
			const turnedOn = !preset && ownServerMaps;
			if (turnedOn) result.devtool = "hidden-source-map";
			// Older Next: the plugin on each server compilation (Node and edge)
			// does the work, when it will find maps.
			if (!useHook && (turnedOn || preset)) {
				result.plugins = [
					...(result.plugins ?? []),
					new AutterSourceMapsWebpackPlugin(
						{ ...options, deleteAfterUpload: options.deleteAfterUpload ?? turnedOn },
						{ ownMaps: turnedOn, server: true },
					),
				];
			}
			return result;
		},
	};
	if (useHook) {
		// Turbopack emits client maps only with productionBrowserSourceMaps; the
		// hook hides them (drops the sourceMappingURL comment) after the build
		// and deletes them once the upload step is over. Server maps likewise
		// come from experimental.serverSourceMaps.
		if (ownMaps) wrapped.productionBrowserSourceMaps = true;
		if (ownServerMaps) wrapped.experimental = { ...config.experimental, serverSourceMaps: true };
		const userHook = config.compiler?.runAfterProductionCompile as ((ctx: unknown) => unknown) | undefined;
		wrapped.compiler = {
			...config.compiler,
			async runAfterProductionCompile(ctx: { distDir?: string; projectDir?: string } = {}) {
				if (typeof userHook === "function") await userHook(ctx);
				const projectDir = ctx.projectDir ?? process.cwd();
				const distDir = ctx.distDir ?? resolve(projectDir, String(config.distDir ?? ".next"));
				const staticDir = join(distDir, "static");
				notifyNoMaps();
				await processBuildOutput({
					dir: staticDir,
					urlPrefix: options.urlPrefix ?? `${nextPrefix}static/`,
					options: { ...options, deleteAfterUpload },
					deleteAfterUpload,
					stripSourceMappingUrl: !publicMaps,
					ownMaps,
					// Every client map (JS and CSS): .next/static is deployed as is.
					maps: ownMaps ? await findMapFiles(staticDir) : undefined,
				});
				if (!serverBundles) return;
				const serverDir = join(distDir, "server");
				const ownServer = ownServerMaps && !serverDevtoolPreset;
				await processBuildOutput({
					dir: serverDir,
					urlPrefix: serverUrlPrefix(projectDir, serverDir),
					options: { ...options, deleteAfterUpload: options.deleteAfterUpload ?? ownServer },
					deleteAfterUpload: ownServer,
					stripSourceMappingUrl: ownServer,
					ownMaps: ownServer,
					maps: ownServer ? await findMapFiles(serverDir) : undefined,
					server: true,
				});
			},
		};
	}
	return wrapped;
}

/**
 * Next.js config wrapper: hidden source maps for client production builds,
 * debug ids injected into every client chunk, maps uploaded after the build
 * when AUTTER_RUNTIME_KEY (or `key`) is set, then deleted whatever the
 * upload's outcome (without a key, no maps are turned on at all). The server
 * output (`.next/server`, Node and edge) gets the same, stored under
 * `/.next/server/` (RF-05; `serverBundles: false` leaves it alone). Works
 * with webpack builds, and with Turbopack builds on Next.js 15.4.1+
 * (`compiler.runAfterProductionCompile`).
 *
 * ```js
 * // next.config.mjs
 * import { withAutterSourceMaps } from "@autter/runtime-cli/next";
 * export default withAutterSourceMaps({ reactStrictMode: true });
 * ```
 */
export function withAutterSourceMaps<C extends NextConfigObject | NextConfigFunction>(
	nextConfig: C = {} as C,
	options: AutterSourceMapsOptions = {},
): C {
	if (typeof nextConfig === "function") {
		const fn: NextConfigFunction = async (phase, context) => wrapConfig(await nextConfig(phase, context), options);
		return fn as C;
	}
	return wrapConfig(nextConfig, options) as C;
}

export default withAutterSourceMaps;
