import type { IncomingMessage, ServerResponse } from "node:http";
import { noteOperationError } from "./logger.js";
import { captureAtBoundary, requestStateOf } from "./requests.js";

/**
 * Server error hooks for Express, Fastify and Koa. Each records the error,
 * with its stack, on the request's span through `captureException`, then
 * lets the framework carry on exactly as before (same error, same response).
 * Without them a thrown error only reaches Autter as the 500 the framework
 * answers with: a stackless `HttpServerError` grouped by route.
 *
 * No framework is a dependency: the request/reply shapes are structural.
 */

export interface AutterErrorHandlerOptions {
	/**
	 * Which errors to report. Default: errors with status ≥ 500 (or no
	 * status), RuntimeErrors and any error with a valid code — so 4xx errors
	 * such as `ctx.throw(404)` or validation failures stay out of your issues.
	 * `true` reports every error; a predicate decides per error.
	 */
	capture?: boolean | ((error: unknown) => boolean);
}

/** Record `error` on the request's summary (if `autterRequests` & co. made
 * one) and report it per `rule`. Never throws. */
function recordBoundaryError(
	error: unknown,
	req: unknown,
	rule: AutterErrorHandlerOptions["capture"],
): void {
	try {
		const state = requestStateOf(req);
		// The final status decides the summary's outcome; the error adds its
		// code/why/fix to the summary either way.
		if (state) noteOperationError(error, false, state);
		captureAtBoundary(error, state, rule);
	} catch {
		/* error reporting never changes the framework's error path */
	}
}

// ---------------------------------------------------------------------------
// Express / Connect
// ---------------------------------------------------------------------------

/**
 * Express (4/5) / Connect error middleware that reports the error and calls
 * `next(err)` unchanged. Mount it after your routes and before your own
 * error handlers:
 *
 *   app.use(autterErrorHandler());
 *   app.use((err, req, res, next) => res.status(500).send("…"));   // yours
 *
 * (`autterErrorResponse()` reports too, and also answers the request.)
 */
export function autterErrorHandler(options: AutterErrorHandlerOptions = {}) {
	// Four declared parameters: that is how Express recognises error middleware.
	return function autterErrorHandlerMiddleware(
		error: unknown,
		req: IncomingMessage,
		_res: ServerResponse,
		next: (error?: unknown) => void,
	): void {
		recordBoundaryError(error, req, options.capture);
		next(error);
	};
}

// ---------------------------------------------------------------------------
// Fastify (4/5)
// ---------------------------------------------------------------------------

interface FastifyErrorRequest {
	raw?: IncomingMessage;
}
interface FastifyHookInstance {
	addHook(name: string, hook: (...args: never[]) => unknown): unknown;
}

/**
 * Fastify (4/5) `onError` hook that reports the error; Fastify's error
 * handler still builds the response. Register it as a plugin, or call it on
 * the instance directly:
 *
 *   app.register(autterFastifyErrors);            // or: autterFastifyErrors(app)
 *   app.register(autterFastifyErrors, { capture: true });
 *
 * It skips plugin encapsulation, so it covers every route. `autterFastify`
 * (request summaries) already includes the same hook; you don't need both.
 */
export function autterFastifyErrors(
	fastify: FastifyHookInstance,
	options?: AutterErrorHandlerOptions,
	done?: (error?: Error) => void,
): void {
	const rule = options?.capture;
	fastify.addHook("onError", ((
		request: FastifyErrorRequest,
		_reply: unknown,
		error: unknown,
		next: () => void,
	) => {
		recordBoundaryError(error, request?.raw, rule);
		next();
	}) as never);
	done?.();
}
(autterFastifyErrors as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(autterFastifyErrors as unknown as Record<symbol, unknown>)[Symbol.for("fastify.display-name")] =
	"autter-runtime-errors";

// ---------------------------------------------------------------------------
// Koa (2/3)
// ---------------------------------------------------------------------------

interface KoaContextLike {
	req?: IncomingMessage;
}

/**
 * Koa (2/3) middleware that reports errors thrown downstream and rethrows
 * them, so Koa's own error handling (and `app.on("error")`) is unchanged.
 * Mount it first:
 *
 *   app.use(autterKoa());
 */
export function autterKoa(options: AutterErrorHandlerOptions = {}) {
	return async function autterKoaMiddleware(
		ctx: KoaContextLike,
		next: () => Promise<unknown>,
	): Promise<void> {
		try {
			await next();
		} catch (error) {
			recordBoundaryError(error, ctx?.req, options.capture);
			throw error;
		}
	};
}
