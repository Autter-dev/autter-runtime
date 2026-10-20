/**
 * Debug ids (EI-13). `autter-runtime sourcemaps inject` (or the bundler
 * plugins in @autter/runtime-cli) puts a one-line snippet in each bundle that
 * runs `globalThis._autterDebugIds[new Error().stack] = "<id>"`. The first
 * frame of that stack names the script URL the browser loaded, so an
 * exception whose stack mentions the URL names the exact build behind it: the
 * ingester then finds the source map by debug id, whatever `release` says.
 * Size-capped bundle: keep this tiny.
 */

/**
 * Attach `debugIds` (script URL, query and hash stripped → debug id) for the
 * scripts that appear in the event's stack; nothing when none do. Never throws.
 */
export function attachDebugIds(event: { stack?: string; debugIds?: Record<string, string> }): void {
	try {
		const ids = (globalThis as { _autterDebugIds?: Record<string, string> })._autterDebugIds;
		for (const key in ids) {
			const url = /\w+:\/\/[^\s()]+?(?=(:\d+){2})/.exec(key)?.[0];
			if (url && event.stack!.indexOf(url) > -1) (event.debugIds = event.debugIds || {})[url.split(/[?#]/)[0]!] = ids[key]!;
		}
	} catch {
		/* No stack, or a hostile registry: report the error without ids. */
	}
}
