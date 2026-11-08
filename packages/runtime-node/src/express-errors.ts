import { createRequire } from "node:module";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { context, trace, type Context, type Span } from "@opentelemetry/api";
import { Hook } from "require-in-the-middle";
import { debugLog } from "./lifecycle.js";
import { isCaptured } from "./captured.js";
import { noteOperationError } from "./logger.js";
import { captureAtBoundary, requestStateOf } from "./requests.js";

/**
 * Express errors captured with no setup (initAutterServer alone).
 *
 * Express (4 and 5) runs every middleware and route handler through
 * `Layer#handle_request` (4) / `Layer#handleRequest` (5, the `router`
 * package). That method catches a synchronous throw, and in Express 5 a
 * rejected promise, and passes the error to the router's `next(err)`; a
 * handler's own `next(err)` reaches the same function. From there Express
 * looks for error middleware and, when none answers, finalhandler logs the
 * stack as a string and sends a 500. Nothing in that path reaches the SDK,
 * so without `autterErrorHandler()` the only trace of the error was the 500
 * status on the request span: a stackless `HttpServerError` ("GET /x returned
 * 500") at the ingester.
 *
 * So the SDK wraps the `next` each layer receives (once per `next` function,
 * which is per request) and notes on the request every error passed to it,
 * at its origin: the throwing handler, in whichever router it was mounted,
 * nested routers with their own error handlers included. Nothing is
 * reported then. When the response finishes with a 5xx (or fails before
 * finishing), the first noted error that does not declare a 4xx status is
 * recorded on the request span, with its stack: the error the 500 came
 * from. Errors that end in a 4xx, or that a handler answered without a 5xx,
 * are never reported by this path; `autterErrorHandler()` stays the way to
 * report coded or 4xx errors by your own rule. An error `autterErrorHandler`,
 * `autterErrorResponse` or `captureException` already reported is skipped,
 * so adding the handler never reports an error twice.
 *
 * The patch never changes what Express does: the same `next` is called
 * with the same arguments, and every step of ours is wrapped so a failure
 * in it is swallowed. Express 4 ignores a promise an async handler returns,
 * so an async throw there is an unhandled rejection, not a 500; that is
 * recorded by the unhandled-rejection capture, with the request's route and
 * id (see server.ts).
 */

/** On a Layer prototype: this package (any copy) patched it. */
const PATCHED = Symbol.for("autter.runtime.express.layer");
/** On a `next` function: its wrapper. */
const WRAPPED = Symbol.for("autter.runtime.express.next");
/** On a request: errors that went through Express's error path. */
const ERRORS = Symbol.for("autter.runtime.express.errors");
/** At most this many distinct errors are noted per request. */
const MAX_ERRORS = 8;

type Next = (...args: unknown[]) => unknown;

/** @internal Note `error` as having entered Express's error path for `req`. */
export function noteExpressError(req: unknown, error: unknown): void {
	if (error === undefined || error === null || error === false) return;
	if (error === "route" || error === "router") return;
	if (!req || typeof req !== "object") return;
	try {
		const target = req as Record<symbol, unknown[] | undefined>;
		let list = target[ERRORS];
		if (!list) {
			list = [];
			target[ERRORS] = list;
		}
		if (list.length < MAX_ERRORS && !list.includes(error)) list.push(error);
	} catch {
		/* a frozen request: nothing noted */
	}
}

function wrapNext(req: unknown, next: unknown): unknown {
	if (typeof next !== "function") return next;
	const fn = next as Next & { [WRAPPED]?: Next };
	const existing = fn[WRAPPED];
	if (existing) return existing;
	const wrapped = function autterExpressNext(this: unknown, ...args: unknown[]): unknown {
		if (args.length > 0) noteExpressError(req, args[0]);
		return fn.apply(this, args);
	};
	try {
		fn[WRAPPED] = wrapped;
	} catch {
		/* not extensible: wrap per call */
	}
	return wrapped;
}

/** Wrap the request and error methods of one Layer prototype. Idempotent
 * across copies of this package. Returns true when the prototype is (now)
 * patched. */
function patchLayerPrototype(proto: unknown): boolean {
	if (!proto || typeof proto !== "object") return false;
	const target = proto as Record<string | symbol, unknown>;
	if (target[PATCHED]) return true;
	// Express 4: handle_request / handle_error. router 2 (Express 5):
	// handleRequest / handleError.
	const requestName =
		typeof target.handleRequest === "function"
			? "handleRequest"
			: typeof target.handle_request === "function"
				? "handle_request"
				: null;
	const errorName =
		typeof target.handleError === "function"
			? "handleError"
			: typeof target.handle_error === "function"
				? "handle_error"
				: null;
	if (!requestName || !errorName) return false;
	const handleRequest = target[requestName] as (this: unknown, ...args: unknown[]) => unknown;
	const handleError = target[errorName] as (this: unknown, ...args: unknown[]) => unknown;
	// Named: these frames show in the stacks of errors thrown in handlers.
	target[requestName] = function autterHandleRequest(this: unknown, req: unknown, res: unknown, next: unknown) {
		let wrapped = next;
		try {
			wrapped = wrapNext(req, next);
		} catch {
			wrapped = next;
		}
		return handleRequest.call(this, req, res, wrapped);
	};
	target[errorName] = function autterHandleError(
		this: unknown,
		error: unknown,
		req: unknown,
		res: unknown,
		next: unknown,
	) {
		let wrapped = next;
		try {
			// An error that reached the router without passing a wrapped
			// `next` (a param callback, a router-level failure).
			noteExpressError(req, error);
			wrapped = wrapNext(req, next);
		} catch {
			wrapped = next;
		}
		return handleError.call(this, error, req, res, wrapped);
	};
	try {
		Object.defineProperty(target, PATCHED, { value: true });
	} catch {
		target[PATCHED] = true;
	}
	return true;
}

/** Layer modules, by the path that ends their CommonJS cache key. */
const LAYER_FILES = ["express/lib/router/layer.js", "router/lib/layer.js"];

function patchLayerModule(exports: unknown): void {
	try {
		const Layer = exports as { prototype?: unknown } | null;
		if (typeof Layer === "function" && patchLayerPrototype(Layer.prototype))
			debugLog("express: error capture installed");
	} catch {
		/* an unexpected Express version stays unpatched */
	}
}

function scanModuleCache(): void {
	try {
		const cache = createRequire(join(process.cwd(), "autter-runtime-express.cjs")).cache;
		for (const [key, entry] of Object.entries(cache)) {
			const path = key.replace(/\\/g, "/");
			if (LAYER_FILES.some((file) => path.endsWith(`/node_modules/${file}`)))
				patchLayerModule(entry?.exports);
		}
	} catch {
		/* no CommonJS loader */
	}
}

let installed = false;

/**
 * @internal Patch Express's Layer wherever it is: copies already loaded
 * (an ES module app imports Express before it calls initAutterServer, and
 * Express's own modules are CommonJS, so they are in the module cache) and
 * copies loaded later (require hook). A bundled Express is patched through
 * the app on its first request (`patchFromRequest`).
 */
export function installExpressErrorCapture(): void {
	if (installed) return;
	installed = true;
	scanModuleCache();
	try {
		new Hook(["express", "router"], { internals: true }, (exports, name) => {
			const file = name.replace(/\\/g, "/");
			if (LAYER_FILES.includes(file)) patchLayerModule(exports);
			return exports;
		});
	} catch {
		/* no require hook: the cache scan and the per-request fallback apply */
	}
}

/** A bundled Express has no module cache entry: find its Layer through the
 * app a finished request ran in. */
function patchFromRequest(req: unknown): void {
	try {
		const app = (req as { app?: Record<string, unknown> } | null)?.app;
		if (!app || typeof app !== "function" && typeof app !== "object") return;
		// Express 4: app._router (a plain property). Express 5: app.router, a
		// getter that creates the router when missing; by the time a request
		// finished it exists.
		const router = (app._router ?? app.router) as { stack?: unknown[] } | undefined;
		const layer = router?.stack?.[0];
		if (layer && typeof layer === "object" && patchLayerPrototype(Object.getPrototypeOf(layer)))
			debugLog("express: error capture installed (from a request)");
	} catch {
		/* not Express */
	}
}

/** The status an error declares (`status` / `statusCode`), if any. */
function declaredStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	try {
		const value =
			(error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
		const status = typeof value === "string" ? Number(value) : value;
		return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600
			? status
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * @internal Called from the HTTP instrumentation's response hook for every
 * incoming request: when the response finishes with a 5xx (or closes before
 * finishing), report the Express error it came from on `span`. Listeners
 * are prepended so they run before the instrumentation ends the span and
 * before the request summary is sealed.
 */
export function watchExpressResponse(
	span: Span,
	res: ServerResponse,
	enabled: () => boolean,
): void {
	const req = (res as ServerResponse & { req?: IncomingMessage }).req;
	if (!req) return;
	const ctx: Context = context.active();
	let done = false;
	const settle = (finished: boolean) => {
		if (done) return;
		done = true;
		try {
			const errors = (req as unknown as Record<symbol, unknown[] | undefined>)[ERRORS];
			if (!errors?.length) {
				patchFromRequest(req);
				return;
			}
			(req as unknown as Record<symbol, unknown>)[ERRORS] = undefined;
			if (!enabled()) return;
			if (finished && !(res.statusCode >= 500)) return;
			if (errors.some((error) => isCaptured(error))) return;
			const error = errors.find((candidate) => {
				const status = declaredStatus(candidate);
				return status === undefined || status >= 500;
			});
			if (error === undefined) return;
			const state = requestStateOf(req);
			if (state && !state.sealed) noteOperationError(error, false, state);
			const run = () => captureAtBoundary(error, state, true);
			if (span.isRecording()) context.with(trace.setSpan(ctx, span), run);
			else context.with(ctx, run);
		} catch {
			/* reporting never changes the response */
		}
	};
	try {
		res.prependListener("finish", () => settle(true));
		res.prependListener("close", () => settle(false));
	} catch {
		/* not an emitter */
	}
}
