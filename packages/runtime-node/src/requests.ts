import type { IncomingMessage, ServerResponse } from "node:http";
import { AsyncResource } from "node:async_hooks";
import { context, trace, type SpanContext } from "@opentelemetry/api";
import {
	DEFAULT_REQUEST_ID_HEADER,
	RuntimeError,
	compileIgnore,
	errorCodeOf,
	normalizeRoutePath,
	requestOutcome,
	resolveRequestId,
	responseStatusOf,
	toClientError,
} from "@autter/runtime-core";
import {
	createRequestState,
	emitSummary,
	flushRuntimeLogs,
	local,
	noteOperationError,
	reportExplicitFailure,
	type OperationState,
} from "./logger.js";

/**
 * Request wide events: one `kind: "request"` summary per HTTP request with
 * method, route template, status, outcome, duration, the request id, the
 * context set via `runtimeContext.set()` from anywhere in the request, inline
 * messages and child operations (linked by parent id). Always kept — there
 * is no sampler; use `ignore` for health checks and metrics endpoints.
 */

const REQUEST_STATE = Symbol.for("autter.runtime.request");
const BOUND = Symbol.for("autter.runtime.bound");
const CAPTURED = new WeakSet<object>();

type ExceptionCapturer = (error: unknown) => void;
let capturer: ExceptionCapturer = () => {};
/** @internal server.ts registers the module-level captureException here. */
export function setRequestExceptionCapturer(fn: ExceptionCapturer): void {
	capturer = fn;
}
/** @internal Remember errors already captured so boundaries don't double-report. */
export function markCaptured(error: unknown): void {
	if (error && typeof error === "object") CAPTURED.add(error);
}

export interface AutterRequestsOptions {
	/** Path globs never summarised: `*` = one segment, `**` = any depth. */
	ignore?: string[];
	/** Request id header to honour and echo. Default "x-request-id". */
	requestIdHeader?: string;
	/** Honour an inbound request id that matches `^[\w.-]{8,128}$`. Default true. */
	trustRequestId?: boolean;
}

export interface AutterErrorResponseOptions {
	/**
	 * Report the error as an exception. Default: errors with status ≥ 500,
	 * RuntimeErrors and any error with a valid code (expected ones included —
	 * they are recorded but never open incidents).
	 */
	capture?: boolean | ((error: unknown) => boolean);
	/** Header the request id is read from when no request summary is active. */
	requestIdHeader?: string;
}

export interface RuntimeRequestOptions {
	/** Summary name suffix (default: the route). Name = `METHOD name`. */
	name?: string;
	/** Route template for `http.route` (default: pathname with ids → `:id`). */
	route?: string;
	requestIdHeader?: string;
	trustRequestId?: boolean;
	ignore?: string[];
	/** Receives the log flush promise after the response (serverless `waitUntil`). */
	waitUntil?: (promise: Promise<unknown>) => void;
}

/** Express (4/5) assigns routing state onto the core request object; a
 * matched handler leaves the route template on `req.route.path` and the
 * mount prefix on `req.baseUrl`. */
interface ExpressRequestProps {
	baseUrl?: unknown;
	route?: { path?: unknown };
}

/**
 * Route template of a finished Express request ("/api/users/:id"), or null
 * when no route matched (404s, static files) or the server isn't Express.
 * Only meaningful at response end — Express fills `req.route` during routing.
 */
export function expressRouteOf(req: unknown): string | null {
	const props = req as ExpressRequestProps | null | undefined;
	const path = props?.route?.path;
	if (typeof path !== "string" || path === "") return null;
	const base = typeof props?.baseUrl === "string" ? props.baseUrl : "";
	const route = base + path;
	return route.startsWith("/") ? route : null;
}

function defaultShouldCapture(error: unknown): boolean {
	return (
		error instanceof RuntimeError ||
		errorCodeOf(error) !== undefined ||
		responseStatusOf(error) >= 500
	);
}

function captureAtBoundary(
	error: unknown,
	state: OperationState | undefined,
	rule: boolean | ((error: unknown) => boolean) | undefined = undefined,
): void {
	const wanted =
		typeof rule === "function"
			? rule(error)
			: rule === undefined
				? defaultShouldCapture(error)
				: rule;
	if (!wanted) return;
	if (error && typeof error === "object" && CAPTURED.has(error)) return;
	markCaptured(error);
	try {
		if (state && !state.sealed) local.run(state, () => capturer(error));
		else capturer(error);
	} catch {
		/* capture never breaks the response */
	}
}

/**
 * Re-enter the request's async context in every listener registered on
 * `emitter` from now on. Body parsers read the request stream from socket
 * callbacks, which would otherwise lose the AsyncLocalStorage store.
 */
function bindEmitter(emitter: unknown, state: OperationState): void {
	const target = emitter as Record<string | symbol, unknown> | null;
	if (!target || typeof target !== "object" || target[BOUND]) return;
	target[BOUND] = true;
	const wrappers = new WeakMap<object, (...args: unknown[]) => unknown>();
	const wrap = (listener: unknown) => {
		if (typeof listener !== "function") return listener;
		let wrapped = wrappers.get(listener);
		if (!wrapped) {
			wrapped = function (this: unknown, ...args: unknown[]) {
				return local.run(state, () =>
					(listener as (...a: unknown[]) => unknown).apply(this, args),
				);
			};
			wrappers.set(listener, wrapped);
		}
		return wrapped;
	};
	for (const method of [
		"on",
		"addListener",
		"prependListener",
		"once",
		"prependOnceListener",
	]) {
		const original = target[method];
		if (typeof original !== "function") continue;
		target[method] = function (this: unknown, event: unknown, listener: unknown) {
			return (original as (...a: unknown[]) => unknown).call(this, event, wrap(listener));
		};
	}
	for (const method of ["removeListener", "off"]) {
		const original = target[method];
		if (typeof original !== "function") continue;
		target[method] = function (this: unknown, event: unknown, listener: unknown) {
			const wrapped =
				typeof listener === "function" ? (wrappers.get(listener) ?? listener) : listener;
			return (original as (...a: unknown[]) => unknown).call(this, event, wrapped);
		};
	}
}

/** Append the request id header to Access-Control-Expose-Headers when the
 * response carries CORS headers, so cross-origin browsers can read it. */
function exposeHeaderValue(current: unknown, header: string): string | null {
	const text = Array.isArray(current) ? current.join(", ") : String(current ?? "");
	const names = text
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	if (names.includes("*") || names.includes(header)) return null;
	return names.length ? `${text}, ${header}` : header;
}

function exposeOnCors(res: ServerResponse, header: string): void {
	const original = res.writeHead;
	res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
		try {
			const inline = args
				.slice(1)
				.find(
					(arg): arg is Record<string, unknown> =>
						!!arg && typeof arg === "object" && !Array.isArray(arg),
				);
			const inlineKey = (name: string) =>
				inline ? Object.keys(inline).find((key) => key.toLowerCase() === name) : undefined;
			const cors =
				res.getHeader("access-control-allow-origin") !== undefined ||
				inlineKey("access-control-allow-origin") !== undefined;
			if (cors) {
				const key = inlineKey("access-control-expose-headers");
				const value = exposeHeaderValue(
					key && inline ? inline[key] : res.getHeader("access-control-expose-headers"),
					header,
				);
				if (value && key && inline) inline[key] = value;
				else if (value) res.setHeader("access-control-expose-headers", value);
			}
		} catch {
			/* never block the response */
		}
		return (original as (...a: unknown[]) => ServerResponse).apply(this, args);
	} as ServerResponse["writeHead"];
}

function pathOf(req: IncomingMessage): string {
	const raw =
		(req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? "/";
	return raw.split(/[?#]/)[0] || "/";
}

function finishRequest(
	state: OperationState,
	input: {
		method: string;
		route: string;
		name?: string;
		status: number;
		aborted: boolean;
		span?: SpanContext;
	},
): void {
	if (state.sealed) return;
	state.name = (input.name ?? `${input.method} ${input.route}`).slice(0, 200);
	state.outcome = requestOutcome({
		...(state.explicitOutcome ? { explicit: state.outcome } : {}),
		...(state.error !== undefined ? { error: state.error } : {}),
		...(state.errorThrown ? { thrown: true } : {}),
		status: input.status,
		aborted: input.aborted,
	});
	const span = trace.getActiveSpan();
	if (span?.isRecording()) span.setAttribute("autter.operation.outcome", state.outcome);
	if (input.span) {
		const remote = trace.wrapSpanContext(input.span);
		context.with(trace.setSpan(context.active(), remote), () =>
			reportExplicitFailure(state),
		);
	} else reportExplicitFailure(state);
	emitSummary(state, {
		http: {
			"http.request.method": input.method,
			"http.route": input.route,
			"http.response.status_code": input.status,
			"autter.request.aborted": input.aborted,
		},
		...(input.span ? { span: input.span } : {}),
	});
}

/** Start a request summary for a Node request/response pair. */
function beginNodeRequest(
	req: IncomingMessage,
	res: ServerResponse,
	options: AutterRequestsOptions,
	route?: () => string | null,
): OperationState {
	const header = (options.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER).toLowerCase();
	const requestId = resolveRequestId(
		options.trustRequestId === false ? undefined : req.headers[header],
	);
	const method = (req.method ?? "GET").toUpperCase();
	const path = pathOf(req);
	const state = createRequestState({
		name: `${method} ${normalizeRoutePath(path)}`,
		requestId,
		req,
		res,
	});
	(req as unknown as Record<symbol, unknown>)[REQUEST_STATE] = state;
	try {
		if (!res.headersSent) res.setHeader(header, requestId);
		exposeOnCors(res, header);
	} catch {
		/* headers already sent */
	}
	const span = trace.getActiveSpan();
	if (span?.isRecording())
		span.setAttributes({
			"autter.request.id": requestId,
			"autter.operation.kind": "request",
		});
	const spanContext = span?.spanContext();
	bindEmitter(req, state);
	bindEmitter(res, state);
	let finished = false;
	const done = () => {
		finishRequest(state, {
			method,
			route: route?.() ?? expressRouteOf(req) ?? normalizeRoutePath(path),
			status: res.statusCode,
			aborted: !finished,
			...(spanContext ? { span: spanContext } : {}),
		});
	};
	res.once("finish", () => {
		finished = true;
		done();
	});
	res.once("close", done);
	return state;
}

/**
 * Express / Connect middleware. Mount it early (before routers; after body
 * parsers is fine too):
 *
 *   app.use(autterRequests({ ignore: ["/healthz", "/metrics"] }));
 *
 * Echoes the request id in the response (`x-request-id`), stamps it on the
 * server span and every record, and emits the summary on finish/close.
 */
export function autterRequests(options: AutterRequestsOptions = {}) {
	const ignored = compileIgnore(options.ignore);
	return function autterRequestsMiddleware(
		req: IncomingMessage,
		res: ServerResponse,
		next: (error?: unknown) => void,
	): void {
		if ((req as unknown as Record<symbol, unknown>)[REQUEST_STATE] || ignored(pathOf(req))) {
			next();
			return;
		}
		const state = beginNodeRequest(req, res, options);
		local.run(state, () => next());
	};
}

/**
 * Express error middleware: records the error on the request summary,
 * reports it (see `capture`), and answers with
 * `{ error: { message, code?, why?, fix?, link?, requestId? } }` and the
 * error's status (default 500). Never includes `internal`, stacks or causes;
 * unstructured 5xx messages are replaced with a generic one.
 *
 *   app.use(autterErrorResponse());   // after your routes
 */
export function autterErrorResponse(options: AutterErrorResponseOptions = {}) {
	return function autterErrorResponseMiddleware(
		error: unknown,
		req: IncomingMessage,
		res: ServerResponse,
		next: (error?: unknown) => void,
	): void {
		const state = (req as unknown as Record<symbol, OperationState | undefined>)[REQUEST_STATE];
		if (state) noteOperationError(error, true, state);
		captureAtBoundary(error, state, options.capture);
		if (res.headersSent) {
			next(error);
			return;
		}
		const header = (options.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER).toLowerCase();
		const inbound = req.headers?.[header];
		const requestId =
			state?.requestId ?? (typeof inbound === "string" ? inbound.slice(0, 128) : undefined);
		res.statusCode = responseStatusOf(error);
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.end(JSON.stringify(toClientError(error, requestId)));
	};
}

// ---------------------------------------------------------------------------
// Fastify (no dependency — typed structurally)
// ---------------------------------------------------------------------------

interface FastifyLikeRequest {
	url: string;
	method: string;
	raw: IncomingMessage;
	headers: Record<string, string | string[] | undefined>;
	routeOptions?: { url?: string };
	routerPath?: string;
	[key: symbol]: unknown;
}
interface FastifyLikeReply {
	raw: ServerResponse;
	statusCode: number;
	header(name: string, value: string): unknown;
	getHeader(name: string): unknown;
}
type HookDone = (error?: Error) => void;
interface FastifyLikeInstance {
	addHook(name: string, hook: (...args: never[]) => unknown): unknown;
}

const RESOURCE = Symbol.for("autter.runtime.resource");

/**
 * Fastify plugin (Fastify 4/5, no dependency on fastify itself):
 *
 *   app.register(autterFastify, { ignore: ["/healthz"] });
 *
 * Skips plugin encapsulation, so its hooks cover every route.
 */
export function autterFastify(
	fastify: FastifyLikeInstance,
	options: AutterRequestsOptions | undefined,
	done: (error?: Error) => void,
): void {
	const opts = options ?? {};
	const header = (opts.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER).toLowerCase();
	const ignored = compileIgnore(opts.ignore);
	const stateOf = (request: FastifyLikeRequest) =>
		request[REQUEST_STATE] as OperationState | undefined;
	fastify.addHook("onRequest", ((request: FastifyLikeRequest, reply: FastifyLikeReply, next: HookDone) => {
		if (ignored(request.url) || request.raw[REQUEST_STATE as never]) {
			next();
			return;
		}
		const requestId = resolveRequestId(
			opts.trustRequestId === false ? undefined : request.headers[header],
		);
		const method = String(request.method ?? "GET").toUpperCase();
		const state = createRequestState({
			name: `${method} ${normalizeRoutePath(request.url)}`,
			requestId,
			req: request.raw,
			res: reply.raw,
		});
		request[REQUEST_STATE] = state;
		(request.raw as unknown as Record<symbol, unknown>)[REQUEST_STATE] = state;
		reply.header(header, requestId);
		const span = trace.getActiveSpan();
		if (span?.isRecording())
			span.setAttributes({
				"autter.request.id": requestId,
				"autter.operation.kind": "request",
			});
		const spanContext = span?.spanContext();
		bindEmitter(request.raw, state);
		bindEmitter(reply.raw, state);
		let finished = false;
		const finish = (aborted: boolean) =>
			finishRequest(state, {
				method,
				route:
					request.routeOptions?.url ??
					request.routerPath ??
					normalizeRoutePath(request.url),
				status: reply.raw.statusCode || reply.statusCode,
				aborted,
				...(spanContext ? { span: spanContext } : {}),
			});
		reply.raw.once("finish", () => {
			finished = true;
			finish(false);
		});
		reply.raw.once("close", () => finish(!finished));
		local.run(state, () => {
			request[RESOURCE] = new AsyncResource("autter-request");
			next();
		});
	}) as never);
	// Body parsing runs from socket callbacks; re-enter before the handler.
	fastify.addHook("preHandler", ((request: FastifyLikeRequest, _reply: FastifyLikeReply, next: HookDone) => {
		const resource = request[RESOURCE] as AsyncResource | undefined;
		if (resource) resource.runInAsyncScope(() => next());
		else next();
	}) as never);
	fastify.addHook("onSend", ((request: FastifyLikeRequest, reply: FastifyLikeReply, payload: unknown, next: (error: Error | null, payload?: unknown) => void) => {
		try {
			if (stateOf(request) && reply.getHeader("access-control-allow-origin") !== undefined) {
				const value = exposeHeaderValue(reply.getHeader("access-control-expose-headers"), header);
				if (value) reply.header("access-control-expose-headers", value);
			}
		} catch {
			/* ignore */
		}
		next(null, payload);
	}) as never);
	fastify.addHook("onError", ((request: FastifyLikeRequest, _reply: FastifyLikeReply, error: unknown, next: HookDone) => {
		const state = stateOf(request);
		if (state) noteOperationError(error, true, state);
		captureAtBoundary(error, state);
		next();
	}) as never);
	done();
}
(autterFastify as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(autterFastify as unknown as Record<symbol, unknown>)[Symbol.for("fastify.display-name")] =
	"autter-runtime";

// ---------------------------------------------------------------------------
// fetch-style handlers (Next.js route handlers, Hono on Node, Remix, …)
// ---------------------------------------------------------------------------

function withHeaders(response: Response, header: string, requestId: string): Response {
	const apply = (target: Response) => {
		target.headers.set(header, requestId);
		if (target.headers.get("access-control-allow-origin") !== null) {
			const value = exposeHeaderValue(
				target.headers.get("access-control-expose-headers") ?? "",
				header,
			);
			if (value) target.headers.set("access-control-expose-headers", value);
		}
		return target;
	};
	try {
		return apply(response);
	} catch {
		// Immutable headers (e.g. a proxied fetch() response): copy once.
		try {
			return apply(new Response(response.body, response));
		} catch {
			return response;
		}
	}
}

/**
 * Wrap a fetch-style handler `(request, ...rest) => Response` in a request
 * summary. Thrown errors are recorded and reported, then rethrown.
 *
 *   export const POST = withRuntimeRequest(handler, { name: "checkout" });
 */
export function withRuntimeRequest<A extends unknown[]>(
	handler: (request: Request, ...rest: A) => Response | Promise<Response>,
	options: RuntimeRequestOptions = {},
): (request: Request, ...rest: A) => Promise<Response> {
	const header = (options.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER).toLowerCase();
	const ignored = compileIgnore(options.ignore);
	return async (request: Request, ...rest: A): Promise<Response> => {
		let pathname = "/";
		try {
			pathname = new URL(request.url, "http://localhost").pathname;
		} catch {
			/* keep "/" */
		}
		if (ignored(pathname)) return handler(request, ...rest);
		const requestId = resolveRequestId(
			options.trustRequestId === false ? undefined : request.headers.get(header),
		);
		const method = String(request.method ?? "GET").toUpperCase();
		const route = options.route ?? normalizeRoutePath(pathname);
		const state = createRequestState({
			name: `${method} ${options.name ?? route}`,
			requestId,
			req: request,
		});
		const span = trace.getActiveSpan();
		if (span?.isRecording())
			span.setAttributes({
				"autter.request.id": requestId,
				"autter.operation.kind": "request",
			});
		const spanContext = span?.spanContext();
		let status = 500;
		try {
			const response = await local.run(state, async () => {
				try {
					return await handler(request, ...rest);
				} catch (error) {
					noteOperationError(error, true, state);
					captureAtBoundary(error, state, true);
					throw error;
				}
			});
			status = response.status;
			return withHeaders(response, header, requestId);
		} finally {
			const aborted = request.signal?.aborted === true;
			finishRequest(state, {
				method,
				route,
				name: `${method} ${options.name ?? route}`,
				status,
				aborted,
				...(spanContext ? { span: spanContext } : {}),
			});
			if (options.waitUntil) {
				try {
					options.waitUntil(flushRuntimeLogs().catch(() => {}));
				} catch {
					/* ignore */
				}
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Zero-code hook mode (logging.requests: true) — EXPERIMENTAL
// ---------------------------------------------------------------------------

/**
 * @internal Called from the HTTP instrumentation's response hook for every
 * incoming request when `logging.requests` is on. Enters the request store
 * with `enterWith`, which can bleed into later work on the same socket
 * (keep-alive / pipelining) — that is why the mode is off by default.
 */
export function startHookRequest(res: ServerResponse): void {
	const req = (res as ServerResponse & { req?: IncomingMessage }).req;
	if (!req || (req as unknown as Record<symbol, unknown>)[REQUEST_STATE]) return;
	const state = beginNodeRequest(req, res, {});
	local.enterWith(state);
}
