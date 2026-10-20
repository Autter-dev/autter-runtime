import pkg from "../package.json" with { type: "json" };
import { debugLog } from "./lifecycle.js";

/**
 * Process-wide SDK state, shared by every copy of @autter/runtime-node in the
 * process.
 *
 * A process can load this package more than once. Next.js bundles one copy
 * into `instrumentation.ts` and another into each route unless the package
 * is in `serverExternalPackages`; a process can also load both the ESM and
 * the CJS build. With module-level state each copy would have its own SDK:
 * code in a route would reach a copy `initAutterServer` never started, so
 * its records went to the console and its errors were reported again by the
 * started copy. Instead, every piece of state that describes "the started
 * SDK" lives on `globalThis[Symbol.for("@autter/runtime-node")]`, and every
 * copy reads and writes the same object.
 *
 * The object is one small interface:
 *
 *   { v: 1, sdk: "<version of the copy that created it>", ...slots }
 *
 * Slots (each owned by the module named, created on first use):
 *
 *   logger      AsyncLocalStorage of the current operation, the logger
 *               configuration and sinks of the started SDK, and test sinks
 *   requests    errors already reported (a WeakSet)
 *   server      the initAutterServer tracker, its always-on provider,
 *               redactor and the logger-only capture
 *   logging     the initAutterLogging handle
 *   breadcrumbs trails outside operations
 *   compat      the ingester compatibility check
 *   sinks       the shared drop counter
 *
 * Versions: `v` is the layout of this object, not the package version.
 * Within layout 1, fields are only ever added. A copy fills in the slots and
 * fields an older copy did not create, and treats fields a newer copy may
 * not set as optional (functions are checked before they are called). A
 * change that is not additive must bump `v`. A copy that finds a layout it
 * does not know leaves that object alone and keeps private state, which is
 * exactly how a single copy behaved before 1.6.1 (and how this copy behaves
 * when nothing else is loaded).
 *
 * `shutdown()` clears the "started" fields (tracker, logger configuration,
 * sinks) but keeps the object itself: copies hold references to its slots,
 * so replacing it would split them again.
 */

/** Key on `globalThis`. `Symbol.for` so every copy computes the same one. */
export const SHARED_STATE_KEY = Symbol.for("@autter/runtime-node");
/** Layout version of the shared object. Bump only for a non-additive change. */
export const SHARED_STATE_LAYOUT = 1;

export interface SharedState {
	readonly v: number;
	/** Package version of the copy that created the object (diagnostics). */
	readonly sdk: string;
	[slot: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const VERSION = (pkg as { version: string }).version;

function resolveShared(): SharedState {
	const fresh: SharedState = { v: SHARED_STATE_LAYOUT, sdk: VERSION };
	const host = globalThis as unknown as Record<symbol, unknown>;
	let existing: unknown;
	try {
		existing = host[SHARED_STATE_KEY];
		if (existing === undefined) {
			Object.defineProperty(host, SHARED_STATE_KEY, {
				value: fresh,
				configurable: true,
				enumerable: false,
				writable: false,
			});
			return fresh;
		}
	} catch {
		return fresh; // frozen or hostile globalThis: private state
	}
	if (isObject(existing) && existing.v === SHARED_STATE_LAYOUT) return existing as SharedState;
	// Another layout (or not ours): never touch it.
	debugLog(
		`another copy of @autter/runtime-node uses shared state layout ${String(isObject(existing) ? existing.v : typeof existing)}; ` +
			`this copy (${VERSION}, layout ${SHARED_STATE_LAYOUT}) keeps its own state`,
	);
	return fresh;
}

const shared = resolveShared();

/**
 * The process-wide slot `name`, created from `init()` when no copy has
 * created it yet. Fields `init()` has and the existing slot lacks (an older
 * copy created it) are added; existing fields are never replaced.
 */
export function sharedSlot<T extends object>(name: string, init: () => T): T {
	const fresh = init();
	try {
		const existing = shared[name];
		if (!isObject(existing)) {
			shared[name] = fresh;
			return fresh;
		}
		for (const [key, value] of Object.entries(fresh)) {
			if (existing[key] === undefined) existing[key] = value;
		}
		return existing as T;
	} catch {
		return fresh; // a frozen object: this slot stays private
	}
}
