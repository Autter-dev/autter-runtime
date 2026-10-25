/**
 * Debug ids of the bundles in a server exception's stack (RF-05).
 *
 * `autter-runtime sourcemaps inject` (and the bundler plugins of
 * @autter/runtime-cli) put the same one-line snippet into server bundles as
 * into browser ones: `globalThis._autterDebugIds[new Error().stack] = "<id>"`.
 * The first frame of that stack names the file Node or the edge runtime ran
 * (`/app/dist/server.js`, `file:///app/dist/index.mjs`, `index.js` in a
 * Worker), so a stack that mentions the file names the exact build behind it,
 * and the ingester finds its source map by debug id whatever path the
 * process ran it from and whatever `release` says.
 */

/** The attribute the ingester reads: a JSON object of script path → debug id. */
export const DEBUG_IDS_ATTRIBUTE = "autter.debug_ids";

const REGISTRY = "_autterDebugIds";

/** Registry key (a stack string) → the script path of its first frame. Keys
 * are one per loaded bundle and never change, so this stays as small as the
 * registry itself. */
const pathOfKey = new Map<string, string | null>();

/** "path:line:col" → path. */
function withoutPosition(location: string): string | null {
	const match = /^(.*?):\d+:\d+$/.exec(location.trim());
	return match?.[1] ? match[1] : null;
}

/**
 * The script path of a stack's first frame, written exactly as stacks write
 * it (the ingester's stack parser reads frames the same way): V8
 * `at fn (path:1:2)` / `at path:1:2`, and `fn@path:1:2` (JSC, SpiderMonkey).
 */
export function firstFramePath(stack: string): string | null {
	for (const raw of stack.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("at ")) {
			const body = line.slice(3).trim();
			const withFn = /^(.*?)\s+\((.*)\)$/.exec(body);
			const path = withoutPosition(withFn ? withFn[2]! : body.replace(/^async /, ""));
			if (path) return path;
			continue;
		}
		const at = line.lastIndexOf("@");
		if (at >= 0) {
			const path = withoutPosition(line.slice(at + 1));
			if (path) return path;
		}
	}
	return null;
}

/**
 * Script path → debug id for every injected bundle that appears in one of
 * `stacks`; undefined when none does (or nothing was injected). Never throws.
 */
export function debugIdsForStacks(stacks: readonly string[]): Record<string, string> | undefined {
	try {
		const registry = (globalThis as unknown as Record<string, unknown>)[REGISTRY];
		if (!registry || typeof registry !== "object") return undefined;
		const texts = stacks.filter((stack) => typeof stack === "string" && stack !== "");
		if (texts.length === 0) return undefined;
		let found: Record<string, string> | undefined;
		for (const key of Object.keys(registry)) {
			const id = (registry as Record<string, unknown>)[key];
			if (typeof id !== "string" || !id) continue;
			let path = pathOfKey.get(key);
			if (path === undefined) {
				path = firstFramePath(key);
				pathOfKey.set(key, path);
			}
			if (path && texts.some((stack) => stack.includes(path!))) (found ??= {})[path] = id;
		}
		return found;
	} catch {
		// A hostile registry: report the error without ids.
		return undefined;
	}
}
