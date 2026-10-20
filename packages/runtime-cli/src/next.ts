import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { processBuildOutput, type AutterSourceMapsOptions } from "./build.js";
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
	const deleteAfterUpload = options.deleteAfterUpload ?? !publicMaps;
	const base = String(config.assetPrefix || config.basePath || "").replace(/\/+$/, "");
	const nextPrefix = `${base}/_next/`;
	const useHook = hasAfterCompileHook(installedNextVersion());
	const userWebpack = config.webpack as
		| ((webpackConfig: WebpackConfigLike, context: WebpackContextLike) => WebpackConfigLike)
		| undefined;

	const wrapped: NextConfigObject = {
		...config,
		webpack(webpackConfig: WebpackConfigLike, context: WebpackContextLike): WebpackConfigLike {
			const result = typeof userWebpack === "function" ? userWebpack(webpackConfig, context) : webpackConfig;
			// Client production builds only: Next reverts devtool changes in dev,
			// and server bundles never reach the browser SDK.
			if (!context.isServer && !context.dev) {
				if (!publicMaps) result.devtool = "hidden-source-map";
				if (!useHook) {
					result.plugins = [
						...(result.plugins ?? []),
						new AutterSourceMapsWebpackPlugin({ ...options, urlPrefix: options.urlPrefix ?? nextPrefix, deleteAfterUpload }),
					];
				}
			}
			return result;
		},
	};
	if (useHook) {
		// Turbopack emits client maps only with productionBrowserSourceMaps; the
		// hook hides them (drops the sourceMappingURL comment) after the build.
		wrapped.productionBrowserSourceMaps = true;
		const userHook = config.compiler?.runAfterProductionCompile as ((ctx: unknown) => unknown) | undefined;
		wrapped.compiler = {
			...config.compiler,
			async runAfterProductionCompile(ctx: { distDir?: string; projectDir?: string } = {}) {
				if (typeof userHook === "function") await userHook(ctx);
				const distDir = ctx.distDir ?? resolve(ctx.projectDir ?? process.cwd(), String(config.distDir ?? ".next"));
				await processBuildOutput({
					dir: join(distDir, "static"),
					urlPrefix: options.urlPrefix ?? `${nextPrefix}static/`,
					options: { ...options, deleteAfterUpload },
					deleteAfterUpload,
					stripSourceMappingUrl: !publicMaps,
				});
			},
		};
	}
	return wrapped;
}

/**
 * Next.js config wrapper: hidden source maps for client production builds,
 * debug ids injected into every client chunk, maps uploaded after the build
 * when AUTTER_RUNTIME_KEY (or `key`) is set. Works with webpack builds, and
 * with Turbopack builds on Next.js 15.4.1+ (`compiler.runAfterProductionCompile`).
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
