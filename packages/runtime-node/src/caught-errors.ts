import { createRequire } from "node:module";
import { join } from "node:path";
import { format } from "node:util";
import type { Attributes } from "@opentelemetry/api";
import {
	BurstLimiter,
	caughtErrorAttributes,
	degradedAttributes,
	handledErrorKind,
	isError,
	loggedErrorSources,
	type CaptureLoggedErrorsOption,
	type LoggedErrorSource,
} from "@autter/runtime-core";
import { Hook } from "require-in-the-middle";
import { isCaptured, markCaptured } from "./captured.js";
import { sharedSlot } from "./shared.js";

/**
 * Handled errors (RF-01, RF-02; see runtime-core handled.ts).
 *
 * Caught errors: an `Error` passed to `console.error`, pino, winston,
 * bunyan or `runtimeLogger.error` is reported as an occurrence at `error`
 * severity, with the log line as context. Log lines without an error object
 * are untouched. The report waits for the current tick to end, so an error
 * the app also passes to `captureException` (or that a framework boundary
 * reports) in the same tick is reported once, by that call.
 *
 * Deliberate fallbacks: `runtimeContext.degraded(err, reason)` reports the
 * error at `warning` severity, never an incident.
 *
 * Both pass the same burst limit per kind (error type and throw site): ten
 * at once, then one every ten seconds. The count left out rides on the next
 * record of that kind (`autter.caught.dropped`); a count nothing came along
 * to carry is sent on its own as a warning log record once the kind has a
 * token again, so the ingester's `runtime_ingest_drops` sees every one.
 *
 * Loggers are patched at their prototypes (all instances and children),
 * whether loaded before the SDK started or after: copies already loaded are
 * found in the CommonJS module cache, later CommonJS loads through a
 * require hook. An ES module app that imports bunyan after the SDK started
 * is picked up by the cache scans in its first 10 s.
 */

export type HandledSeverity = "error" | "warning";
export type HandledCapture = (error: unknown, attributes: Attributes, severity: HandledSeverity) => void;

interface HandledSlot {
	/** Sources reporting (`captureLoggedErrors`); null while no SDK runs. */
	sources: Record<LoggedErrorSource, boolean> | null;
	/** Records one handled error (server.ts registers it). */
	capture: HandledCapture | null;
	/** Sends a count no sent record carried (logger.ts registers it). */
	tail: ((type: string, dropped: number) => void) | null;
	limiter: BurstLimiter;
	/** Logged errors already decided (reported or left out). */
	decided: WeakSet<object>;
	timer: ReturnType<typeof setTimeout> | null;
	hooked: boolean;
}
const S = sharedSlot<HandledSlot>("handled", () => ({
	sources: null,
	capture: null,
	tail: null,
	limiter: new BurstLimiter(),
	decided: new WeakSet<object>(),
	timer: null,
	hooked: false,
}));

/** Marks a console or logger prototype this package (any copy) patched. */
const PATCHED = Symbol.for("autter.runtime.logged-errors");

/** @internal server.ts: how a handled error is recorded. */
export function setHandledCapture(capture: HandledCapture): void {
	S.capture = capture;
}

/** @internal logger.ts: how a count no record carried is sent. */
export function setHandledTail(tail: (type: string, dropped: number) => void): void {
	S.tail = tail;
}

function scheduleTail(): void {
	if (S.timer) return;
	const at = S.limiter.nextDrainAt();
	if (at === null) return;
	S.timer = setTimeout(() => sendTails(false), Math.max(0, at - Date.now()) + 5);
	S.timer.unref?.();
}

function sendTails(all: boolean): void {
	if (S.timer) clearTimeout(S.timer);
	S.timer = null;
	for (const tail of S.limiter.drain(Date.now(), all)) {
		try {
			S.tail?.(tail.type, tail.dropped);
		} catch {
			/* a count never breaks the app */
		}
	}
	if (!all) scheduleTail();
}

/** The burst limit for one handled error: -1 when left out, else the count to carry. */
function limit(prefix: string, error: unknown): number {
	const kind = handledErrorKind(error);
	const dropped = S.limiter.take(`${prefix}\n${kind.key}`, kind.type);
	if (dropped < 0) scheduleTail();
	return dropped;
}

/**
 * @internal An error the app logged through `source`: reported after the
 * current tick unless something captured it meanwhile.
 */
export function reportLoggedError(
	error: unknown,
	source: LoggedErrorSource,
	message?: string,
	attributes?: Attributes,
): void {
	if (!S.sources?.[source] || !isError(error)) return;
	if (S.decided.has(error) || isCaptured(error)) return;
	S.decided.add(error);
	const run = () => {
		try {
			if (isCaptured(error) || !S.capture || !S.sources) return;
			const dropped = limit("caught", error);
			if (dropped < 0) return;
			markCaptured(error);
			S.capture(error, { ...attributes, ...caughtErrorAttributes(source, message, dropped) }, "error");
		} catch {
			/* reporting never breaks the app */
		}
	};
	try {
		setImmediate(run);
	} catch {
		/* no event loop left */
	}
}

/** @internal `runtimeContext.degraded`: recorded now, at warning severity. */
export function reportDegraded(error: unknown, reason: unknown, attributes?: Attributes): void {
	if (!S.capture) return;
	if (error && typeof error === "object") S.decided.add(error);
	const dropped = limit("deliberate", error);
	if (dropped < 0) return;
	markCaptured(error);
	S.capture(error, { ...attributes, ...degradedAttributes(reason, dropped) }, "warning");
}

// ── console ──────────────────────────────────────────────────────────────

function onConsoleError(args: unknown[]): void {
	if (!S.sources?.console) return;
	// The SDK's own diagnostics (`[autter] …`, `[autter-runtime] …`).
	if (typeof args[0] === "string" && args[0].startsWith("[autter")) return;
	for (const arg of args) {
		if (!isError(arg)) continue;
		let message = "";
		try {
			message = format(...args.filter((other) => other !== arg));
		} catch {
			/* unprintable arguments: the error alone */
		}
		reportLoggedError(arg, "console", message);
	}
}

function patchConsole(): void {
	const target = console as Console & Record<symbol, unknown>;
	try {
		if (target[PATCHED]) return;
		const original = target.error;
		if (typeof original !== "function") return;
		target.error = function (this: unknown, ...args: unknown[]) {
			try {
				onConsoleError(args);
			} catch {
				/* reporting never breaks logging */
			}
			return original.apply(this, args);
		};
		Object.defineProperty(target, PATCHED, { value: true });
	} catch {
		/* a frozen console stays as it is */
	}
}

// ── loggers ──────────────────────────────────────────────────────────────

/** The first own value of a log object that is an Error (`err`, `error`, …). */
function errorField(value: unknown): Error | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["err", "error"]) if (isError(record[key])) return record[key] as Error;
	let seen = 0;
	for (const key of Object.keys(record)) {
		if (++seen > 20) break;
		if (isError(record[key])) return record[key] as Error;
	}
	return undefined;
}

function wrapMethod(
	target: Record<PropertyKey, unknown>,
	key: PropertyKey,
	inspect: (self: unknown, args: unknown[]) => void,
): void {
	const original = target[key];
	if (typeof original !== "function") return;
	target[key] = function (this: unknown, ...args: unknown[]) {
		try {
			inspect(this, args);
		} catch {
			/* reporting never breaks logging */
		}
		return (original as (...a: unknown[]) => unknown).apply(this, args);
	};
}

function markPatched(target: object): boolean {
	const record = target as Record<symbol, unknown>;
	if (record[PATCHED]) return false;
	try {
		Object.defineProperty(target, PATCHED, { value: true });
		return true;
	} catch {
		return false;
	}
}

/** pino: `[pino.write](obj, msg, level)` on the shared prototype (pino ≥ 7). */
function patchPino(protoFactory: unknown): void {
	if (typeof protoFactory !== "function") return;
	const proto = Object.getPrototypeOf((protoFactory as () => object)()) as Record<PropertyKey, unknown> | null;
	if (!proto) return;
	const write = Object.getOwnPropertySymbols(proto).find((symbol) => symbol.description === "pino.write");
	if (!write || typeof proto[write] !== "function" || !markPatched(proto)) return;
	wrapMethod(proto, write, (_self, [obj, msg, level]) => {
		// 50 = error, 60 = fatal (custom levels above error included).
		if (!S.sources?.pino || typeof level !== "number" || level < 50) return;
		const error = isError(obj) ? obj : errorField(obj);
		if (error) reportLoggedError(error, "pino", typeof msg === "string" ? msg : undefined);
	});
}

const WINSTON_ERROR_LEVELS = /^(?:error|fatal|crit|alert|emerg)$/;

function winstonErrorLevel(logger: unknown, level: unknown): boolean {
	if (typeof level !== "string") return false;
	const levels = (logger as { levels?: Record<string, unknown> } | null)?.levels;
	if (levels && typeof levels[level] === "number" && typeof levels.error === "number")
		return (levels[level] as number) <= levels.error;
	return WINSTON_ERROR_LEVELS.test(level);
}

/**
 * winston 3: `Logger.prototype.log(level, msg, ...meta)`, and
 * `_addDefaultMeta(info)`, which every `logger.error(err)` call (children
 * included, before they copy the info) passes the error itself to.
 */
function patchWinston(Logger: unknown): void {
	const proto = (Logger as { prototype?: Record<PropertyKey, unknown> } | null)?.prototype;
	if (!proto || typeof proto.log !== "function" || !markPatched(proto)) return;
	wrapMethod(proto, "log", (self, [level, msg, ...meta]) => {
		if (!S.sources?.winston || !winstonErrorLevel(self, level)) return;
		for (const arg of [msg, ...meta]) {
			const error = isError(arg) ? arg : errorField(arg);
			if (error) reportLoggedError(error, "winston", typeof msg === "string" ? msg : undefined);
		}
	});
	wrapMethod(proto, "_addDefaultMeta", (self, [info]) => {
		if (!S.sources?.winston || !info || typeof info !== "object") return;
		if (!winstonErrorLevel(self, (info as { level?: unknown }).level)) return;
		if (isError(info)) reportLoggedError(info, "winston");
		else {
			const error = errorField(info);
			const message = (info as { message?: unknown }).message;
			if (error) reportLoggedError(error, "winston", typeof message === "string" ? message : undefined);
		}
	});
}

/** bunyan: `Logger.prototype.error(err | { err }, msg…)` and `.fatal`. */
function patchBunyan(Logger: unknown): void {
	const proto = (Logger as { prototype?: Record<PropertyKey, unknown> } | null)?.prototype;
	if (!proto || typeof proto.error !== "function" || !markPatched(proto)) return;
	for (const [method, level] of [["error", 50], ["fatal", 60]] as const) {
		wrapMethod(proto, method, (self, args) => {
			if (!S.sources?.bunyan || args.length === 0) return;
			const min = (self as { _level?: unknown } | null)?._level;
			if (typeof min === "number" && min > level) return;
			const error = isError(args[0]) ? args[0] : errorField(args[0]);
			if (!error) return;
			let message = "";
			try {
				message = format(...args.slice(1));
			} catch {
				/* unprintable arguments */
			}
			reportLoggedError(error, "bunyan", message);
		});
	}
}

/** Module files patched, by the path that ends their CommonJS cache key. */
const TARGETS: Array<{ file: string; patch: (exports: unknown) => void }> = [
	{ file: "pino/lib/proto.js", patch: patchPino },
	{ file: "winston/lib/winston/logger.js", patch: patchWinston },
	{ file: "bunyan/lib/bunyan.js", patch: patchBunyan },
];

function patchModule(file: string, exports: unknown): void {
	const target = TARGETS.find((entry) => entry.file === file);
	if (!target) return;
	try {
		target.patch(exports);
	} catch {
		/* an unexpected logger version stays unpatched */
	}
}

/** Patch every copy of a supported logger already in the module cache. */
function scanModuleCache(): void {
	try {
		const cache = createRequire(join(process.cwd(), "autter-runtime-loggers.cjs")).cache;
		for (const [key, entry] of Object.entries(cache)) {
			const path = key.replace(/\\/g, "/");
			for (const target of TARGETS)
				if (path.endsWith(`/node_modules/${target.file}`)) patchModule(target.file, entry?.exports);
		}
	} catch {
		/* no CommonJS loader */
	}
}

function hookLaterLoads(): void {
	if (S.hooked) return;
	S.hooked = true;
	try {
		new Hook(["pino", "winston", "bunyan"], { internals: true }, (exports, name) => {
			const file = name.replace(/\\/g, "/");
			patchModule(file === "bunyan" ? "bunyan/lib/bunyan.js" : file, exports);
			return exports;
		});
	} catch {
		/* no require hook: the cache scans still apply */
	}
	// ES module imports skip the require hook; a logger imported while the
	// app starts is in the module cache by then.
	for (const delay of [0, 1_000, 10_000]) {
		const timer = setTimeout(scanModuleCache, delay);
		timer.unref?.();
	}
}

/**
 * @internal Start reporting logged errors (initAutterServer /
 * initAutterLogging). Patches are installed once per process and stay;
 * `stopLoggedErrorCapture` only switches them off.
 */
export function startLoggedErrorCapture(option: CaptureLoggedErrorsOption | undefined): void {
	const sources = loggedErrorSources(option);
	S.sources = sources;
	if (!Object.values(sources).some(Boolean)) return;
	if (sources.console) patchConsole();
	if (sources.pino || sources.winston || sources.bunyan) {
		scanModuleCache();
		hookLaterLoads();
	}
}

/** @internal Shutdown: stop reporting and send every count still held. */
export function stopLoggedErrorCapture(): void {
	S.sources = null;
	sendTails(true);
}
