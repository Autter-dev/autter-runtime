/**
 * Unhandled promise rejections, recorded without changing whether the
 * process crashes.
 *
 * Node's `--unhandled-rejections` mode decides what an unhandled rejection
 * does, and most modes behave differently once ANY `unhandledRejection`
 * listener exists:
 *
 *   mode                   no listener                      with a listener
 *   throw (default)        crash (uncaught exception)        listener only — no crash
 *   strict                 crash, then the listener          same
 *   warn                   warning                           listener + warning
 *   warn-with-error-code   warning + exit code 1             listener only
 *   none                   nothing                           listener only
 *
 * Adding our listener would therefore silently stop the default crash. So
 * when ours is the only listener we do what Node would have done:
 *
 *   - throw: rethrow the reason (or Node's `UnhandledPromiseRejection`
 *     wrapper for a non-error reason) on the next tick. The process crashes
 *     with exit code 1 as before, and `uncaughtExceptionMonitor` records it
 *     as a crash (fatal), exactly as it did without this listener. The one
 *     visible difference: `uncaughtException` listeners and the monitor
 *     receive origin `"uncaughtException"` instead of `"unhandledRejection"`.
 *   - warn-with-error-code: print Node's warning and set `process.exitCode = 1`.
 *   - strict: no listener at all — Node raises the rejection as an uncaught
 *     exception first, which the crash monitor already records.
 *
 * Everything else — the app has its own listener (it decides what happens),
 * or the mode never crashes — is recorded as an error (severity "error", not
 * fatal) with `autter.unhandled_rejection: true`.
 */

export type UnhandledRejectionsMode =
	| "throw"
	| "strict"
	| "warn"
	| "warn-with-error-code"
	| "none";

const MODES = new Set<UnhandledRejectionsMode>([
	"throw",
	"strict",
	"warn",
	"warn-with-error-code",
	"none",
]);

/** Marks our listeners, so every copy of the SDK (ESM and CJS builds,
 * duplicated installs) recognises the others as "not the app's". */
const LISTENER_MARK = Symbol.for("autter.runtime.unhandledRejection.listener");
/** Promises one of our listeners already handled — shared across SDK copies
 * so two installed copies never rethrow (or record) the same rejection twice. */
const HANDLED_KEY = Symbol.for("autter.runtime.unhandledRejection.handled");

function handledPromises(): WeakSet<object> {
	const registry = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
	let set = registry[HANDLED_KEY];
	if (!set) {
		set = new WeakSet<object>();
		registry[HANDLED_KEY] = set;
	}
	return set;
}

/** Reasons just recorded as rejections: the crash monitor skips them, so an
 * app listener that rethrows does not turn one rejection into two
 * occurrences. Kept only until the next turn of the event loop. */
const recorded = new WeakSet<object>();

function markRecorded(reason: unknown): void {
	if (!reason || typeof reason !== "object") return;
	recorded.add(reason);
	setImmediate(() => recorded.delete(reason)).unref?.();
}

/** @internal True when `error` was already recorded as an unhandled rejection. */
export function recordedAsRejection(error: unknown): boolean {
	return !!error && typeof error === "object" && recorded.has(error);
}

function splitOptions(value: string | undefined): string[] {
	return value ? value.split(/\s+/).filter(Boolean) : [];
}

/**
 * Node's effective `--unhandled-rejections` mode: `NODE_OPTIONS` first, then
 * the command line (which wins), last occurrence wins. Default `"throw"`.
 */
export function unhandledRejectionsMode(
	execArgv: readonly string[] = process.execArgv,
	nodeOptions: string | undefined = process.env.NODE_OPTIONS,
): UnhandledRejectionsMode {
	const args = [...splitOptions(nodeOptions), ...execArgv];
	let mode: UnhandledRejectionsMode = "throw";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (!arg.startsWith("--")) continue;
		const eq = arg.indexOf("=");
		const name = (eq < 0 ? arg : arg.slice(0, eq)).replace(/_/g, "-");
		if (name !== "--unhandled-rejections") continue;
		const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
		if (value && MODES.has(value as UnhandledRejectionsMode))
			mode = value as UnhandledRejectionsMode;
	}
	return mode;
}

/** Node's `isErrorLike`: an object with an own `stack`. */
function isErrorLike(value: unknown): value is object {
	try {
		return (
			typeof value === "object" &&
			value !== null &&
			Object.prototype.hasOwnProperty.call(value, "stack")
		);
	} catch {
		return false;
	}
}

/** Side-effect-free description, like Node's `noSideEffectsToString`. */
function describeReason(reason: unknown): string {
	if ((typeof reason !== "object" && typeof reason !== "function") || reason === null) {
		try {
			return String(reason);
		} catch {
			return typeof reason;
		}
	}
	try {
		const proto = Object.getPrototypeOf(reason) as { constructor?: unknown } | null;
		const ctor = proto?.constructor;
		const name = typeof ctor === "function" ? ctor.name : "";
		return name ? `#<${name}>` : "[object Object]";
	} catch {
		return "[object Object]";
	}
}

/** What Node throws for an unhandled rejection: the reason itself when it is
 * error-like, else an `UnhandledPromiseRejection` (code ERR_UNHANDLED_REJECTION). */
function toUncaught(reason: unknown, from: Function): unknown {
	if (isErrorLike(reason)) return reason;
	const error = new Error(
		"This error originated either by throwing inside of an async function without a catch block, " +
			"or by rejecting a promise which was not handled with .catch(). " +
			`The promise rejected with the reason "${describeReason(reason)}".`,
	);
	error.name = "UnhandledPromiseRejection";
	(error as Error & { code?: string }).code = "ERR_UNHANDLED_REJECTION";
	Error.captureStackTrace?.(error, from);
	return error;
}

let warningId = 0;

/** Node's warn-with-error-code output for a rejection nobody listened to. */
function emitNodeWarning(reason: unknown): void {
	try {
		const text = isErrorLike(reason)
			? String((reason as { stack?: unknown }).stack)
			: describeReason(reason);
		process.emitWarning(text, "UnhandledPromiseRejectionWarning");
		process.emitWarning(
			"Unhandled promise rejection. This error originated either by throwing inside of an async function " +
				"without a catch block, or by rejecting a promise which was not handled with .catch(). " +
				"To terminate the node process on unhandled promise rejection, use the CLI flag " +
				"`--unhandled-rejections=strict` (see https://nodejs.org/api/cli.html#cli_unhandled_rejections_mode). " +
				`(rejection id: ${++warningId})`,
			"UnhandledPromiseRejectionWarning",
		);
	} catch {
		/* warnings are best effort */
	}
}

/**
 * @internal Listen for unhandled rejections and pass each one Node would NOT
 * crash on to `capture`. Returns the uninstall function.
 */
export function installUnhandledRejectionCapture(
	capture: (reason: unknown) => void,
	mode: UnhandledRejectionsMode = unhandledRejectionsMode(),
): () => void {
	// strict raises the rejection as an uncaught exception before emitting
	// `unhandledRejection`; the crash monitor has already recorded it.
	if (mode === "strict") return () => {};
	const listener = (reason: unknown, promise: unknown): void => {
		try {
			if (promise && typeof promise === "object") {
				const handled = handledPromises();
				if (handled.has(promise)) return;
				handled.add(promise);
			}
			const alone = process
				.listeners("unhandledRejection")
				.every((fn) => (fn as unknown as Record<symbol, unknown>)[LISTENER_MARK] === true);
			if (alone && mode === "throw") {
				// Node would crash here: keep it that way. The crash monitor
				// records the rethrown error as fatal, as it always has.
				const error = toUncaught(reason, listener);
				process.nextTick(() => {
					throw error;
				});
				return;
			}
			if (alone && mode === "warn-with-error-code") {
				emitNodeWarning(reason);
				process.exitCode = 1;
			}
			markRecorded(reason);
			capture(reason);
		} catch {
			/* capture never throws into the process */
		}
	};
	(listener as unknown as Record<symbol, unknown>)[LISTENER_MARK] = true;
	process.on("unhandledRejection", listener);
	return () => {
		process.off("unhandledRejection", listener);
	};
}
