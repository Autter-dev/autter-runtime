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
	DEFAULT_REQUEST_ID_HEADER,
	appendInlineLog,
	boundContext,
	buildOtlpLogsRequest,
	compileIgnore,
	createInlineLogState,
	createRuntimeEvent,
	errorAttributes,
	makeRedactor,
	maxLevel,
	mergeContext,
	normalizeRoutePath,
	requestOutcome,
	resolveRequestId,
	responseStatusOf,
	toClientError,
	toOtlpLogRecord,
	userContext,
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
	/** Request id (honoured `x-request-id` or a fresh UUID); echoed in the response. */
	readonly requestId: string;
	/** Report an exception (becomes an occurrence/issue). */
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
				const { endpoint, apiKey, fetch: doFetch } = destination;
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
				let ok = false;
				for (let attempt = 0; attempt < 2 && !ok; attempt++) {
					try {
						const response = await doFetch(`${endpoint}/v1/logs`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${apiKey}`,
							},
							body,
						});
						ok = response.ok;
						// 4xx (bad key, payload rejected) will not improve on retry.
						if (!ok && response.status < 500) break;
					} catch {
						/* retry once */
					}
				}
				if (!ok) {
					exporter.dropped += batch.length;
					console.warn(
						`[autter-runtime-edge] ${batch.length} record(s) could not be delivered to ${endpoint}/v1/logs`,
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
			runtime.rt.captureException(error);
			if (opts.errorResponse) {
				status = responseStatusOf(error);
				response = new Response(JSON.stringify(toClientError(error, runtime.rt.requestId)), {
					status,
					headers: { "content-type": "application/json; charset=utf-8" },
				});
			}
		}
		const records = runtime.finish(status, request.signal?.aborted === true);
		// Without a key nothing is queued: a later request with a key must not
		// send these records under its own key, service or environment.
		const destination = opts.apiKey ? destinationOf({ ...opts, apiKey: opts.apiKey }) : null;
		for (const record of records) {
			if (opts.console)
				console.log(JSON.stringify({ ...record.attributes, level: record.level, message: record.message }));
			if (!destination) continue;
			const encoded = toOtlpLogRecord(record);
			const bytes = encoder.encode(JSON.stringify(encoded)).length;
			if (
				exporter.queue.length >= (opts.maxQueue ?? 200) ||
				exporter.bytes + bytes > 1024 * 1024 ||
				bytes > 256 * 1024
			) {
				exporter.dropped++;
				continue;
			}
			exporter.queue.push({ record: encoded, bytes, destination });
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
	let sealed = false;
	const emitted: ReturnType<typeof createRuntimeEvent>[] = [];
	const base = () => ({
		"autter.operation.id": operationId,
		"autter.operation.name": `${method} ${route}`,
		"autter.request.id": requestId,
		"http.request.method": method,
		"http.route": route,
	});
	const record = (
		level: RuntimeLogLevel,
		message: string,
		attrs: RuntimeLogContext,
		extra: Record<string, unknown> = {},
	) => {
		const user = mergeContext(attributes, attrs, redact);
		const exceptions = Object.fromEntries(
			Object.entries(user).filter(([key]) => key.startsWith("exception.")),
		);
		emitted.push(
			createRuntimeEvent({
				level,
				message: String(boundContext({ message }, redact).message ?? "").slice(0, 4000),
				attributes: boundContext(
					{
						"autter.event.id": randomId(),
						...extra,
						...exceptions,
						...base(),
						...user,
					} as RuntimeLogContext,
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
				err instanceof Error ? err.message : String(err),
				{
					...attrs,
					...(err instanceof Error
						? { "exception.type": err.name, "exception.stacktrace": err.stack ?? "" }
						: {}),
				},
				errorAttributes(err),
			);
		},
		requestId,
		captureException(err, attrs) {
			if (sealed) return;
			if (err && typeof err === "object") {
				if (captured.has(err)) return;
				captured.add(err);
			}
			noteError(err);
			const isError = err instanceof Error;
			const message = isError ? err.message : String(err);
			appendInlineLog(inline, "error", message, undefined, redact);
			record(
				"error",
				message,
				{
					...attrs,
					"exception.type": isError ? err.name : "Error",
					"exception.message": message,
					"exception.stacktrace": (isError && err.stack) || new Error(message).stack || "",
				},
				{ "autter.capture.mode": "log", ...errorAttributes(err) },
			);
		},
	};
	const finish = (status: number, aborted: boolean) => {
		if (sealed) return emitted;
		const outcome = requestOutcome({
			...(explicit ? { explicit } : {}),
			...(error !== undefined ? { error } : {}),
			...(errorThrown ? { thrown: true } : {}),
			status,
			aborted,
		});
		const level: RuntimeLogLevel = outcome === "failed" ? "error" : "info";
		record(
			level,
			outcomeMessage ?? `${method} ${route}: ${outcome}`,
			error instanceof Error
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
				...(error !== undefined ? errorAttributes(error) : {}),
				...(inline.logsTruncated ? { "autter.operation.logs_truncated": true } : {}),
				...(inline.logs.length ? { "autter.operation.logs": inline.logs } : {}),
			},
		);
		sealed = true;
		return emitted;
	};
	return { rt, finish, noteError };
}
