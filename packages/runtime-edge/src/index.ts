/**
 * @autter/runtime-edge — Autter Runtime for fetch-only runtimes: Cloudflare
 * Workers, Vercel Edge (and Next.js `middleware.ts` via
 * `@autter/runtime-next/edge`), Deno and Bun. Zero dependencies, no
 * AsyncLocalStorage: the request context is passed to your handler as `rt`.
 *
 *   export default withAutter(
 *     (env) => ({ apiKey: env.AUTTER_RUNTIME_KEY, service: "edge-api" }),
 *     async (request, env, ctx, rt) => {
 *       rt.set({ tenant: env.TENANT });
 *       if (!ok) throw billingErrors.declined();
 *       return new Response("ok");
 *     },
 *   );
 *
 * Each request emits one `kind: "request"` summary (always kept) plus
 * warn/error records and captured exceptions, exported as OTLP/HTTP JSON to
 * `${endpoint}/v1/logs` with a SERVER key. Delivery runs through
 * `ctx.waitUntil` so it never delays the response. Exceptions are error
 * records with `autter.capture.mode = "log"`, which the ingester (1.5.0+)
 * promotes to occurrences.
 */
import {
	BurstLimiter,
	DEFAULT_REQUEST_ID_HEADER,
	appendInlineLog,
	caughtErrorAttributes,
	degradedAttributes,
	formatLogArguments,
	handledErrorKind,
	loggedErrorSources,
	boundContext,
	buildOtlpLogsRequest,
	compileIgnore,
	createErrorFilter,
	createInlineLogState,
	createRuntimeEvent,
	isSummary,
	errorAttributes,
	isError,
	fingerprintEventAttributes,
	makeRedactor,
	maxLevel,
	mergeContext,
	normalizeRoutePath,
	requestOutcome,
	resolveRequestId,
	responseStatusOf,
	splitFingerprint,
	stackAttributesLast,
	toClientError,
	toOtlpLogRecord,
	userContext,
	type CaptureLoggedErrorsOption,
	type IgnoreErrorPattern,
	type LoggedErrorSource,
	type OtlpLogRecord,
	type RedactOptions,
	type RuntimeLogContext,
	type RuntimeLogLevel,
	type RuntimeOutcome,
} from "@autter/runtime-core";

export {
	CODE_PATTERN,
	RuntimeError,
	defineRuntimeErrors,
	isRuntimeErrorLike,
	toClientError,
	type RuntimeErrorDefinition,
	type RuntimeErrorExtras,
	type RuntimeErrorOptions,
	type RuntimeErrorLike,
	type RuntimeErrorFactory,
	type RuntimeErrorCatalog,
	type ClientErrorBody,
	type CaptureLoggedErrorsOption,
	type LoggedErrorSource,
	type RedactOptions,
	type RuntimeLogContext,
	type RuntimeLogContextValue,
	type RuntimeLogLevel,
	type RuntimeOutcome,
} from "@autter/runtime-core";

export interface AutterEdgeOptions {
	/** SERVER ingest key (autter_rt_…) from a secret binding. Omit to disable export. */
	apiKey?: string;
	/** Ingester base URL. Default https://otlp.autter.dev */
	endpoint?: string;
	service: string;
	environment?: string;
	release?: string;
	/** Request id header to honour and echo. Default "x-request-id". */
	requestIdHeader?: string;
	/** Path globs never summarised (`*` = one segment, `**` = any depth). */
	ignore?: string[];
	/** Route template for `http.route` (default: pathname with ids → `:id`). */
	routeOf?: (request: Request) => string | undefined;
	/** Answer thrown errors with `toClientError` JSON instead of rethrowing. Default false. */
	errorResponse?: boolean;
	/** Drop plain records below this level (summaries always kept). */
	minLevel?: RuntimeLogLevel;
	/** Also print records as JSON lines. Default false. */
	console?: boolean;
	/** Same semantics as runtime-node. Default true. */
	redactAttributes?: boolean | RedactOptions;
	/** Max records buffered per isolate. Default 200. */
	maxQueue?: number;
	/**
	 * Share of `rt.captureException` errors reported, 0..1 (default 1).
	 * An error thrown out of the handler (and `captureEdgeException`, which
	 * reports unhandled errors) is never sampled out. Same semantics as
	 * runtime-node; not counted anywhere (use suppression rules in Autter
	 * for counted volume control).
	 */
	sampleRate?: number;
	/**
	 * Errors never reported as occurrences: strings match when the error's
	 * type or message contains them, RegExps are tested against the type,
	 * the message and `"<type>: <message>"`. The request summary still
	 * records the failed outcome.
	 */
	ignoreErrors?: IgnoreErrorPattern[];
	/**
	 * Count each request from its summary (default true). Every record of
	 * the request carries `autter.request.counted_by = "summary"`, and an
	 * ingester newer than 1.9.0 adds the summary to the service's request
	 * and failed-request counts — an edge function has no other feed (older
	 * ingesters ignore the mark). Set false when the same requests are
	 * already counted under this service name by another sender, e.g.
	 * Next.js middleware reporting as the Node server's service (`next
	 * start` measures every request it serves).
	 */
	countRequests?: boolean;
	/**
	 * Errors the app caught and logged count (RF-01): an `Error` passed to
	 * `console.error` or `rt.error` becomes an occurrence at `error`
	 * severity, marked `autter.handled` / `autter.handling: "caught"`, with
	 * the log line as context (`autter.log.source`, `autter.log.message`).
	 * Log lines without an error object are untouched; an error also passed
	 * to `rt.captureException` (or thrown out of the handler) is reported
	 * once; a burst limit per error type and throw site keeps ten at once,
	 * then one every ten seconds (the count left out is reported). It never
	 * fails the request on its own. A `console.error` belongs to the request
	 * when it is the only one in flight in the isolate; otherwise it is sent
	 * on its own. `false` turns it off; `{ console: false }` keeps `rt.error`
	 * only. Default true.
	 */
	captureLoggedErrors?: CaptureLoggedErrorsOption;
	/** @internal Override fetch (tests). */
	fetch?: typeof fetch;
}

/** The per-request handle passed to your handler. */
export interface EdgeRuntime {
	/** Merge attributes into the request summary's context. */
	set(context: RuntimeLogContext): void;
	/** Set the outcome explicitly (wins over status/error rules). */
	outcome(status: RuntimeOutcome, message?: string): void;
	/** Folded into the summary timeline. */
	info(message: string, attributes?: RuntimeLogContext): void;
	/** Folded into the summary AND emitted as its own record. */
	warn(message: string, attributes?: RuntimeLogContext): void;
	/** Logs an error (folded + emitted) and attaches its code to the summary. */
	error(error: unknown, attributes?: RuntimeLogContext): void;
	/**
	 * The app caught `error` and chose to continue on a fallback (RF-02):
	 * an occurrence at `warning` severity, marked `autter.handling =
	 * "deliberate"` with the reason, never an incident; the request ends
	 * "degraded" unless it failed or set its outcome.
	 */
	degraded(error: unknown, reason: string, attributes?: RuntimeLogContext): void;
	/** Request id (honoured `x-request-id` or a fresh UUID); echoed in the response. */
	readonly requestId: string;
	/**
	 * Report an exception (becomes an occurrence/issue). `fingerprint` (a
	 * string or up to 10 strings) groups every error that carries it into
	 * one issue (ingester 1.6.0+).
	 */
	captureException(error: unknown, attributes?: RuntimeLogContext): void;
}

export interface EdgeExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
}

export type EdgeHandler<Env, Ctx> = (
	request: Request,
	env: Env,
	ctx: Ctx,
	rt: EdgeRuntime,
) => Response | Promise<Response>;

/** Callable handler that is also a Workers/Bun-style `{ fetch }` object. */
export type AutterEdgeHandler<Env, Ctx> = ((
	request: Request,
	env?: Env,
	ctx?: Ctx,
) => Promise<Response>) & {
	fetch(request: Request, env?: Env, ctx?: Ctx): Promise<Response>;
	/** Deliver everything buffered now (normally done via waitUntil). */
	flush(): Promise<void>;
};

/** Where a record is delivered. Captured when the record is queued so a
 * later flush never sends it with another request's key or resource. */
interface Destination {
	endpoint: string;
	apiKey: string;
	service: string;
	environment: string;
	release?: string;
	fetch: typeof fetch;
}

interface QueuedRecord {
	record: OtlpLogRecord;
	bytes: number;
	destination: Destination;
	/** Request summaries are evicted last (see enqueue below). */
	summary: boolean;
}

/** warn/error records kept per request; the summary is always added. */
const MAX_RECORDS_PER_REQUEST = 50;

/** Own-property copy that never throws (Proxies, throwing getters). */
function safeAttributes(attrs: RuntimeLogContext | undefined): RuntimeLogContext {
	const out: RuntimeLogContext = {};
	if (!attrs || typeof attrs !== "object") return out;
	try {
		for (const key of Object.keys(attrs)) {
			try {
				out[key] = attrs[key] as RuntimeLogContext[string];
			} catch {
				/* skip a throwing field */
			}
		}
	} catch {
		/* unreadable object */
	}
	return out;
}

interface Exporter {
	queue: QueuedRecord[];
	bytes: number;
	dropped: number;
	flushing: Promise<void> | null;
}

function destinationOf(opts: AutterEdgeOptions & { apiKey: string }): Destination {
	return {
		endpoint: (opts.endpoint ?? "https://otlp.autter.dev").replace(/\/$/, ""),
		apiKey: opts.apiKey,
		service: opts.service,
		environment: opts.environment ?? "production",
		...(opts.release ? { release: opts.release } : {}),
		fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
	};
}

function sameDestination(a: Destination, b: Destination): boolean {
	return (
		a.endpoint === b.endpoint &&
		a.apiKey === b.apiKey &&
		a.service === b.service &&
		a.environment === b.environment &&
		a.release === b.release
	);
}

const encoder = new TextEncoder();

/** POST one batch to `/v1/logs`: at most two attempts, no retry on 4xx. */
async function postLogs(destination: Destination, batch: OtlpLogRecord[]): Promise<boolean> {
	const body = JSON.stringify(
		buildOtlpLogsRequest(
			{
				service: destination.service,
				environment: destination.environment,
				...(destination.release ? { release: destination.release } : {}),
			},
			batch,
		),
	);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const response = await destination.fetch(`${destination.endpoint}/v1/logs`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${destination.apiKey}`,
				},
				body,
			});
			if (response.ok) return true;
			// 4xx (bad key, payload rejected) will not improve on retry.
			if (response.status < 500) return false;
		} catch {
			/* retry once */
		}
	}
	return false;
}

function randomId(): string {
	return globalThis.crypto.randomUUID();
}

function resolveOptions<Env>(
	options: AutterEdgeOptions | ((env: Env) => AutterEdgeOptions),
	env: Env,
): AutterEdgeOptions {
	return typeof options === "function" ? options(env) : options;
}

function exposeValue(current: string | null, header: string): string | null {
	const names = (current ?? "")
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
	if (names.includes("*") || names.includes(header)) return null;
	return names.length ? `${current}, ${header}` : header;
}

function withRequestId(response: Response, header: string, requestId: string): Response {
	const apply = (target: Response) => {
		target.headers.set(header, requestId);
		if (target.headers.get("access-control-allow-origin") !== null) {
			const value = exposeValue(target.headers.get("access-control-expose-headers"), header);
			if (value) target.headers.set("access-control-expose-headers", value);
		}
		return target;
	};
	try {
		return apply(response);
	} catch {
		try {
			return apply(new Response(response.body, response));
		} catch {
			return response;
		}
	}
}

/**
 * Wrap an edge fetch handler. `options` may be a function of `env` (Workers
 * bindings are only available per request).
 */
export function withAutter<Env = unknown, Ctx = EdgeExecutionContext>(
	options: AutterEdgeOptions | ((env: Env) => AutterEdgeOptions),
	handler: EdgeHandler<Env, Ctx>,
): AutterEdgeHandler<Env, Ctx> {
	// Per isolate: buffered records survive between requests until flushed.
	const exporter: Exporter = { queue: [], bytes: 0, dropped: 0, flushing: null };
	let warnedNoKey = false;

	// Sends every queued record to the destination captured when it was
	// queued, in batches of up to 50 records that share one destination.
	const deliver = async (): Promise<void> => {
		if (exporter.flushing) await exporter.flushing.catch(() => {});
		if (!exporter.queue.length) return;
		exporter.flushing = (async () => {
			while (exporter.queue.length) {
				const destination = exporter.queue[0]!.destination;
				let take = 0;
				while (
					take < exporter.queue.length &&
					take < 50 &&
					sameDestination(exporter.queue[take]!.destination, destination)
				)
					take++;
				const entries = exporter.queue.splice(0, take);
				for (const entry of entries) exporter.bytes -= entry.bytes;
				const batch = entries.map((entry) => entry.record);
				if (!(await postLogs(destination, batch))) {
					exporter.dropped += batch.length;
					console.warn(
						`[autter-runtime-edge] ${batch.length} record(s) could not be delivered to ${destination.endpoint}/v1/logs`,
					);
				}
			}
		})().finally(() => {
			exporter.flushing = null;
		});
		return exporter.flushing;
	};

	const wrapped = async (request: Request, env?: Env, ctx?: Ctx): Promise<Response> => {
		const opts = resolveOptions(options, env as Env);
		const header = (opts.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER).toLowerCase();
		const redact = makeRedactor(opts.redactAttributes ?? true);
		let pathname = "/";
		try {
			pathname = new URL(request.url).pathname;
		} catch {
			/* keep "/" */
		}
		const runtime = buildRuntime(request, pathname, opts, header, redact);
		if (compileIgnore(opts.ignore)(pathname))
			return handler(request, env as Env, ctx as Ctx, runtime.rt);
		const state = isolate();
		if (opts.apiKey) state.last = opts;
		if (loggedErrorSources(opts.captureLoggedErrors).console) patchConsole();
		state.inFlight.add(runtime.handle);
		if (!opts.apiKey && !warnedNoKey) {
			warnedNoKey = true;
			console.warn("[autter-runtime-edge] no apiKey: records are not exported");
		}
		let status = 500;
		let thrown: unknown;
		let response: Response | undefined;
		try {
			response = await handler(request, env as Env, ctx as Ctx, runtime.rt);
			status = response.status;
		} catch (error) {
			thrown = error;
			runtime.noteError(error, true);
			runtime.captureThrown(error);
			if (opts.errorResponse) {
				status = responseStatusOf(error);
				response = new Response(JSON.stringify(toClientError(error, runtime.rt.requestId)), {
					status,
					headers: { "content-type": "application/json; charset=utf-8" },
				});
			}
		}
		const records = runtime.finish(status, request.signal?.aborted === true);
		state.inFlight.delete(runtime.handle);
		// Without a key nothing is queued: a later request with a key must not
		// send these records under its own key, service or environment.
		const destination = opts.apiKey ? destinationOf({ ...opts, apiKey: opts.apiKey }) : null;
		for (const record of records) {
			if (opts.console)
				console.log(JSON.stringify({ ...record.attributes, level: record.level, message: record.message }));
			if (!destination) continue;
			const encoded = toOtlpLogRecord(record);
			const bytes = encoder.encode(JSON.stringify(encoded)).length;
			const summary = isSummary(record);
			const full = () =>
				exporter.queue.length >= (opts.maxQueue ?? 200) ||
				exporter.bytes + bytes > 1024 * 1024;
			// Summaries are always kept: under pressure a summary evicts the
			// oldest plain record instead of being dropped itself.
			while (summary && bytes <= 256 * 1024 && full()) {
				const victim = exporter.queue.findIndex((queued) => !queued.summary);
				if (victim < 0) break;
				exporter.bytes -= exporter.queue[victim]!.bytes;
				exporter.queue.splice(victim, 1);
				exporter.dropped++;
			}
			if (full() || bytes > 256 * 1024) {
				exporter.dropped++;
				continue;
			}
			exporter.queue.push({ record: encoded, bytes, destination, summary });
			exporter.bytes += bytes;
		}
		const flush = deliver().catch(() => {});
		const waitUntil =
			(ctx as Partial<EdgeExecutionContext> | undefined)?.waitUntil ??
			(env as Partial<EdgeExecutionContext> | undefined)?.waitUntil;
		if (typeof waitUntil === "function") {
			try {
				waitUntil.call(
					(ctx as Partial<EdgeExecutionContext> | undefined)?.waitUntil ? ctx : env,
					flush,
				);
			} catch {
				/* best effort */
			}
		}
		if (thrown !== undefined && !response) throw thrown;
		return withRequestId(response!, header, runtime.rt.requestId);
	};
	return Object.assign(wrapped, {
		fetch: wrapped,
		flush: () => deliver(),
	});
}

let warnedCaptureNoKey = false;

/** Errors already reported, shared by every copy of this module in the
 * isolate (middleware and instrumentation may be bundled separately), so an
 * error `withAutter` captured and rethrew is not reported again by
 * `captureEdgeException` (e.g. from Next.js `onRequestError`). */
function capturedErrors(): WeakSet<object> {
	const key = Symbol.for("autter.runtime.edge.captured");
	const registry = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
	let set = registry[key];
	if (!set) {
		set = new WeakSet<object>();
		registry[key] = set;
	}
	return set;
}

/** True the first time `error` is seen; objects only. */
function firstCapture(error: unknown): boolean {
	if (!error || typeof error !== "object") return true;
	const set = capturedErrors();
	if (set.has(error)) return false;
	set.add(error);
	return true;
}

function safeString(value: unknown): string {
	try {
		return String(value);
	} catch {
		return "Error";
	}
}

/**
 * Report one exception outside `withAutter`: Next.js `onRequestError` on the
 * edge runtime, a scheduled or queue handler. Sends a single error record
 * (`autter.capture.mode = "log"`, which the ingester 1.5.0+ promotes to an
 * occurrence, stack included) to `${endpoint}/v1/logs` straight away, and
 * resolves once it was delivered or dropped. An error already reported (by
 * this function or by `withAutter`) is skipped. Never rejects; hand the
 * promise to `waitUntil` where the runtime has one.
 *
 *   ctx.waitUntil(captureEdgeException({ apiKey, service: "edge-api" }, error, { "job.name": "sync" }));
 */
export async function captureEdgeException(
	options: AutterEdgeOptions,
	error: unknown,
	attributes?: RuntimeLogContext,
): Promise<void> {
	try {
		if (!firstCapture(error)) return;
		const redact = makeRedactor(options.redactAttributes ?? true);
		const isErr = isError(error);
		const message = isErr ? error.message : safeString(error);
		// Unhandled errors: ignoreErrors applies, sampleRate never does.
		const reportable = createErrorFilter({ ignoreErrors: options.ignoreErrors });
		if (!reportable({ type: isErr ? String(error.name ?? "") : "Error", message, crash: true })) return;
		const user = userContext(
			{
				...safeAttributes(attributes),
				"exception.type": isErr ? error.name : "Error",
				"exception.message": message,
				"exception.stacktrace": (isErr && error.stack) || new Error(message).stack || "",
			},
			redact,
		);
		const event = createRuntimeEvent({
			level: "error",
			message: String(boundContext({ message }, redact).message ?? "").slice(0, 4000),
			attributes: boundContext(
				// Cause stacks and debug ids last: the bound keeps the main stack first.
				stackAttributesLast({
					"autter.event.id": randomId(),
					"autter.capture.mode": "log",
					...errorAttributes(error),
					...user,
				}) as RuntimeLogContext,
				redact,
			),
		});
		if (options.console)
			console.log(JSON.stringify({ ...event.attributes, level: event.level, message: event.message }));
		if (!options.apiKey) {
			if (!warnedCaptureNoKey) {
				warnedCaptureNoKey = true;
				console.warn("[autter-runtime-edge] no apiKey: captured exceptions are not exported");
			}
			return;
		}
		const destination = destinationOf({ ...options, apiKey: options.apiKey });
		if (!(await postLogs(destination, [toOtlpLogRecord(event)])))
			console.warn(
				`[autter-runtime-edge] 1 record(s) could not be delivered to ${destination.endpoint}/v1/logs`,
			);
	} catch {
		/* reporting never throws into the caller */
	}
}

/** One request in flight, as the isolate-wide hooks see it. */
interface InFlight {
	sources: Record<LoggedErrorSource, boolean>;
	logged(error: unknown, source: LoggedErrorSource, message?: string, attributes?: RuntimeLogContext): void;
	degraded(error: unknown, reason: string, attributes?: RuntimeLogContext): void;
}

/** Isolate-wide handled-error state, shared by every copy of this module. */
interface IsolateState {
	limiter: BurstLimiter;
	inFlight: Set<InFlight>;
	/** Options of the latest request: where records outside a request go. */
	last: AutterEdgeOptions | null;
	consolePatched: boolean;
}
function isolate(): IsolateState {
	const key = Symbol.for("autter.runtime.edge.handled");
	const registry = globalThis as unknown as Record<symbol, IsolateState | undefined>;
	return (registry[key] ??= { limiter: new BurstLimiter(), inFlight: new Set(), last: null, consolePatched: false });
}

/** The burst limit (ten at once, then one every ten seconds per kind):
 * -1 when left out, else the count to report with this record. */
function limitHandled(prefix: string, error: unknown): number {
	const kind = handledErrorKind(error);
	return isolate().limiter.take(`${prefix}\n${kind.key}`, kind.type);
}

/** A handled error outside any request (or with several in flight): one
 * record sent straight away to the latest request's destination. */
async function sendHandled(
	error: unknown,
	level: "error" | "warning",
	handled: Record<string, string | number | boolean>,
	attributes?: RuntimeLogContext,
): Promise<void> {
	try {
		const options = isolate().last;
		if (!options?.apiKey) return;
		const redact = makeRedactor(options.redactAttributes ?? true);
		const isErr = isError(error);
		const message = isErr ? error.message : safeString(error);
		const reportable = createErrorFilter({ ignoreErrors: options.ignoreErrors, sampleRate: options.sampleRate });
		if (!reportable({ type: isErr ? String(error.name ?? "") : "Error", message, severity: level })) return;
		const event = createRuntimeEvent({
			level,
			message: String(boundContext({ message }, redact).message ?? "").slice(0, 4000),
			attributes: boundContext(
				// Cause stacks and debug ids last: the bound keeps the main stack first.
				stackAttributesLast({
					"autter.event.id": randomId(),
					"autter.capture.mode": "log",
					...errorAttributes(error),
					...handled,
					...userContext(
						{
							...safeAttributes(attributes),
							"exception.type": isErr ? error.name : "Error",
							"exception.message": message,
							"exception.stacktrace": (isErr && error.stack) || new Error(message).stack || "",
						},
						redact,
					),
				}) as RuntimeLogContext,
				redact,
			),
		});
		await postLogs(destinationOf({ ...options, apiKey: options.apiKey }), [toOtlpLogRecord(event)]);
	} catch {
		/* reporting never throws into the caller */
	}
}

/** `console.error(…, err, …)`: the request's when it is the only one in
 * flight, else sent on its own after the tick (unless captured meanwhile). */
function patchConsole(): void {
	const state = isolate();
	if (state.consolePatched || typeof console === "undefined") return;
	state.consolePatched = true;
	try {
		const original = console.error;
		if (typeof original !== "function") return;
		console.error = function (this: unknown, ...args: unknown[]) {
			try {
				// The SDK's own diagnostics.
				if (!(typeof args[0] === "string" && args[0].startsWith("[autter"))) {
					const only = state.inFlight.size === 1 ? [...state.inFlight][0]! : null;
					for (const arg of args) {
						if (!isError(arg)) continue;
						const message = formatLogArguments(args, arg);
						if (only) {
							if (only.sources.console) only.logged(arg, "console", message);
						} else if (state.last && loggedErrorSources(state.last.captureLoggedErrors).console) {
							setTimeout(() => {
								if (!firstCapture(arg)) return;
								const dropped = limitHandled("caught", arg);
								if (dropped >= 0) void sendHandled(arg, "error", caughtErrorAttributes("console", message, dropped));
							}, 0);
						}
					}
				}
			} catch {
				/* reporting never breaks logging */
			}
			return original.apply(this, args);
		};
	} catch {
		/* a frozen console stays as it is */
	}
}

/**
 * The current request's context where the edge has no AsyncLocalStorage:
 * `runtimeContext.degraded` belongs to the request when it is the only one
 * in flight in the isolate, else it is sent on its own. Inside a handler,
 * `rt.degraded` is exact.
 */
export const runtimeContext = {
	/** See `EdgeRuntime.degraded`. */
	degraded(error: unknown, reason: string, attributes?: RuntimeLogContext): void {
		try {
			const state = isolate();
			if (state.inFlight.size === 1) {
				[...state.inFlight][0]!.degraded(error, reason, attributes);
				return;
			}
			firstCapture(error);
			const dropped = limitHandled("deliberate", error);
			if (dropped >= 0) void sendHandled(error, "warning", degradedAttributes(reason, dropped), attributes);
		} catch {
			/* reporting never breaks the fallback */
		}
	},
};

/** Explicit per-request state (no AsyncLocalStorage on the edge). */
function buildRuntime(
	request: Request,
	pathname: string,
	opts: AutterEdgeOptions,
	header: string,
	redact: ReturnType<typeof makeRedactor>,
) {
	const startedAt = Date.now();
	const requestId = resolveRequestId(request.headers.get(header));
	const method = String(request.method || "GET").toUpperCase();
	const route = (opts.routeOf?.(request) ?? normalizeRoutePath(pathname)).slice(0, 200);
	const operationId = randomId();
	const inline = createInlineLogState(startedAt);
	const minLevel = opts.minLevel ?? "debug";
	const severity = { debug: 5, info: 9, warning: 13, error: 17 } as const;
	let attributes: RuntimeLogContext = {};
	let explicit: RuntimeOutcome | undefined;
	let outcomeMessage: string | undefined;
	let error: unknown;
	let errorThrown = false;
	let errorReported = false;
	let degraded = false;
	let sealed = false;
	const sources = loggedErrorSources(opts.captureLoggedErrors);
	const countRequest = opts.countRequests !== false;
	const emitted: ReturnType<typeof createRuntimeEvent>[] = [];
	const base = () => ({
		"autter.operation.id": operationId,
		"autter.operation.name": `${method} ${route}`,
		"autter.request.id": requestId,
		"http.request.method": method,
		"http.route": route,
		...(countRequest ? { "autter.request.counted_by": "summary" } : {}),
	});
	const record = (
		level: RuntimeLogLevel,
		message: string,
		attrs: RuntimeLogContext,
		extra: Record<string, unknown> = {},
	) => {
		// The summary (operation event) is always recorded; plain warn/error
		// records are capped so one noisy request can't fill the queue.
		if (extra["autter.event.type"] !== "operation" && emitted.length >= MAX_RECORDS_PER_REQUEST) return;
		const user = mergeContext(attributes, attrs, redact);
		const exceptions = Object.fromEntries(
			Object.entries(user).filter(([key]) => key.startsWith("exception.")),
		);
		emitted.push(
			createRuntimeEvent({
				level,
				message: String(boundContext({ message }, redact).message ?? "").slice(0, 4000),
				attributes: boundContext(
					// Cause stacks and debug ids last: the bound keeps the main
					// stack and the caller's context whole first.
					stackAttributesLast({
						"autter.event.id": randomId(),
						...extra,
						...exceptions,
						...base(),
						...user,
					}) as RuntimeLogContext,
					redact,
				),
			}),
		);
	};
	const log = (level: RuntimeLogLevel, message: string, attrs: RuntimeLogContext = {}, extra = {}) => {
		if (sealed || severity[level] < severity[minLevel]) return;
		const { "exception.stacktrace": _stack, ...small } = userContext(attrs, redact);
		appendInlineLog(inline, level, message, small, redact);
		if (level === "warning" || level === "error") record(level, message, attrs, extra);
	};
	const noteError = (err: unknown, thrownOut = false) => {
		if (sealed) return;
		error = err;
		if (thrownOut) errorThrown = true;
	};
	const captured = new WeakSet<object>();
	const reportable = createErrorFilter({ ignoreErrors: opts.ignoreErrors, sampleRate: opts.sampleRate });
	const capture = (err: unknown, attrs: RuntimeLogContext | undefined, crash: boolean) => {
		if (sealed) return;
		if (err && typeof err === "object") {
			if (captured.has(err)) return;
			captured.add(err);
			capturedErrors().add(err);
		}
		noteError(err);
		const isErr = isError(err);
		const message = isErr ? err.message : String(err);
		// Decided once per value (it is marked captured either way above).
		if (!reportable({ type: isErr ? String(err.name ?? "") : "Error", message, crash })) return;
		errorReported = true;
		appendInlineLog(inline, "error", message, undefined, redact);
		const split = splitFingerprint(safeAttributes(attrs));
		record(
			"error",
			message,
			{
				...split.attributes,
				"exception.type": isErr ? err.name : "Error",
				"exception.message": message,
				"exception.stacktrace": (isErr && err.stack) || new Error(message).stack || "",
			},
			{ "autter.capture.mode": "log", ...errorAttributes(err), ...fingerprintEventAttributes(split.fingerprint) },
		);
	};
	/** A handled error: an occurrence record that never fails the request. */
	const recordHandled = (
		err: unknown,
		level: "error" | "warning",
		handled: Record<string, string | number | boolean>,
		attrs?: RuntimeLogContext,
	) => {
		if (sealed) return;
		if (err && typeof err === "object") {
			captured.add(err);
			capturedErrors().add(err);
		}
		const isErr = isError(err);
		const message = isErr ? err.message : String(err);
		if (!reportable({ type: isErr ? String(err.name ?? "") : "Error", message, severity: level })) return;
		const split = splitFingerprint(safeAttributes(attrs));
		record(
			level,
			message,
			{
				...split.attributes,
				"exception.type": isErr ? err.name : "Error",
				"exception.message": message,
				"exception.stacktrace": (isErr && err.stack) || new Error(message).stack || "",
			},
			{ "autter.capture.mode": "log", ...errorAttributes(err), ...fingerprintEventAttributes(split.fingerprint), ...handled },
		);
	};
	// Logged errors wait for the tick (or the response) to end, so one also
	// captured or thrown out of the handler meanwhile is reported once.
	const pending: Array<{ error: unknown; source: LoggedErrorSource; message?: string; attrs?: RuntimeLogContext }> = [];
	const drainLogged = () => {
		for (const entry of pending.splice(0)) {
			if (sealed || (entry.error && typeof entry.error === "object" && (captured.has(entry.error) || capturedErrors().has(entry.error))))
				continue;
			const dropped = limitHandled("caught", entry.error);
			if (dropped >= 0)
				recordHandled(entry.error, "error", caughtErrorAttributes(entry.source, entry.message, dropped), entry.attrs);
		}
	};
	const logged = (err: unknown, source: LoggedErrorSource, message?: string, attrs?: RuntimeLogContext) => {
		if (sealed || !sources[source] || !isError(err) || pending.some((entry) => entry.error === err)) return;
		pending.push({ error: err, source, ...(message ? { message } : {}), ...(attrs ? { attrs } : {}) });
		if (pending.length === 1) setTimeout(drainLogged, 0);
	};
	const markDegraded = (err: unknown, reason: string, attrs?: RuntimeLogContext) => {
		if (sealed) return;
		degraded = true;
		noteError(err);
		appendInlineLog(inline, "warning", `degraded: ${String(reason)}`, undefined, redact);
		const dropped = limitHandled("deliberate", err);
		if (dropped >= 0) recordHandled(err, "warning", degradedAttributes(reason, dropped), attrs);
	};
	const rt: EdgeRuntime = {
		set(context) {
			if (!sealed) attributes = mergeContext(attributes, context, redact);
		},
		outcome(status, message) {
			if (sealed) return;
			explicit = status;
			outcomeMessage = message;
		},
		info: (message, attrs) => log("info", message, attrs),
		warn: (message, attrs) => log("warning", message, attrs),
		error(err, attrs) {
			noteError(err);
			log(
				"error",
				isError(err) ? err.message : String(err),
				{
					...safeAttributes(attrs),
					...(isError(err)
						? { "exception.type": err.name, "exception.stacktrace": err.stack ?? "" }
						: {}),
				},
				errorAttributes(err),
			);
			logged(err, "runtimeLogger", undefined, safeAttributes(attrs));
		},
		degraded(err, reason, attrs) {
			try {
				markDegraded(err, reason, attrs);
			} catch {
				/* reporting never breaks the fallback */
			}
		},
		requestId,
		captureException(err, attrs) {
			capture(err, attrs, false);
		},
	};
	const finish = (status: number, aborted: boolean) => {
		if (sealed) return emitted;
		drainLogged();
		// Counts the burst limit left out that no sent record carried.
		for (const tail of isolate().limiter.drain())
			record(
				"warning",
				`${tail.dropped} caught ${tail.type} error(s) left out by the burst limit`,
				{ "autter.caught.dropped": tail.dropped, "autter.caught.type": tail.type },
			);
		const outcome = requestOutcome({
			...(explicit ? { explicit } : {}),
			...(error !== undefined ? { error } : {}),
			...(errorThrown ? { thrown: true } : {}),
			...(degraded ? { degraded: true } : {}),
			status,
			aborted,
		});
		const level: RuntimeLogLevel = outcome === "failed" ? "error" : "info";
		record(
			level,
			outcomeMessage ?? `${method} ${route}: ${outcome}`,
			isError(error)
				? { "exception.type": error.name, "exception.stacktrace": error.stack ?? "" }
				: {},
			{
				"autter.event.type": "operation",
				"autter.operation.outcome": outcome,
				"autter.operation.duration_ms": Date.now() - startedAt,
				"autter.operation.steps": [],
				"autter.operation.kind": "request",
				"autter.operation.level": maxLevel(inline.level, level),
				"http.response.status_code": status,
				"autter.request.aborted": aborted,
				// The reported error makes it a failed request in the counts,
				// which then don't count the error record again.
				...(countRequest && errorReported ? { "autter.request.error_reported": true } : {}),
				// A summary is no occurrence: no cause stacks or debug ids.
				...(error !== undefined ? errorAttributes(error, { stacks: false }) : {}),
				...(inline.logsTruncated ? { "autter.operation.logs_truncated": true } : {}),
				...(inline.logs.length ? { "autter.operation.logs": inline.logs } : {}),
			},
		);
		sealed = true;
		return emitted;
	};
	/** An error thrown out of the handler: never sampled out. */
	const captureThrown = (err: unknown) => capture(err, undefined, true);
	const handle: InFlight = { sources, logged, degraded: markDegraded };
	return { rt, finish, noteError, captureThrown, handle };
}
