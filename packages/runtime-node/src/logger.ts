import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
	trace,
	type Attributes,
	type Link,
	type SpanContext,
} from "@opentelemetry/api";
import {
	addAiUsage,
	appendInlineLog,
	boundContext,
	createCarrier,
	createInlineLogState,
	createRuntimeEvent,
	errorAttributes,
	formatTraceparent,
	maxLevel,
	mergeContext,
	parseCarrier,
	parseTraceparent,
	toSpanAttributes,
	userContext,
	LEVEL_SEVERITY,
	type AiRollup,
	type AiUsageInput,
	type InlineLogState,
	type RuntimeCarrier,
	type RuntimeEvent,
	type RuntimeLogContext,
	type RuntimeLogLevel,
	type RuntimeOperationKind,
	type RuntimeOutcome,
} from "@autter/runtime-core";
import { redactAttributes } from "./redact.js";
import {
	consoleSink,
	fileSink,
	otlpSink,
	sinkStats,
	type CapturedException,
	type FileSinkOptions,
	type RuntimeSink,
} from "./sinks.js";

export type {
	RuntimeLogContext,
	RuntimeLogContextValue,
	RuntimeLogLevel,
	RuntimeOutcome,
	RuntimeOperationKind,
	RuntimeCarrier,
} from "@autter/runtime-core";

/** Mutable view of a record handed to enrichers before redaction/bounding. */
export interface RuntimeEnrichEvent {
	level: RuntimeLogLevel;
	message: string;
	attributes: Record<string, unknown>;
}
export interface RuntimeEnrichContext {
	/** The inbound request of a request summary (Node IncomingMessage or fetch Request). */
	req?: unknown;
	/** The response object, when the framework exposes one. */
	res?: unknown;
	operation: { id: string; name: string; kind: RuntimeOperationKind };
}
/** Adds attributes to operation/request summaries. Must be cheap; errors are ignored. */
export type RuntimeEnricher = (
	event: RuntimeEnrichEvent,
	context: RuntimeEnrichContext,
) => void;

export interface RuntimeLoggingOptions {
	/** Print records to the console (default sinks only). Default true. */
	console?: boolean;
	/** Drop plain log records below this level. Summaries are always kept. */
	minLevel?: RuntimeLogLevel;
	/**
	 * Fold debug/info messages logged inside an operation into its summary
	 * (`autter.operation.logs`, max 50) instead of emitting separate records;
	 * warn/error are folded AND emitted. Default true.
	 */
	inline?: boolean;
	/** Run on every operation/request summary before redaction. */
	enrich?: RuntimeEnricher[];
	/**
	 * Replace the default sinks (`[otlpSink(), consoleSink()]`, plus
	 * `fileSink()` when NODE_ENV=development).
	 */
	sinks?: RuntimeSink[];
	/**
	 * Local NDJSON files (`.autter/runtime/YYYY-MM-DD.jsonl`). Default: on only
	 * when NODE_ENV === "development". Ignored when `sinks` is set.
	 */
	file?: boolean | FileSinkOptions;
	/**
	 * EXPERIMENTAL zero-code request summaries for plain `node:http` servers
	 * via the HTTP instrumentation hook (initAutterServer only). Uses
	 * AsyncLocalStorage.enterWith, which can leak context across keep-alive /
	 * pipelined requests on one socket — prefer `autterRequests()`. Default false.
	 */
	requests?: boolean;
}

export interface RuntimeOperation {
	readonly id: string;
	setContext(attributes: RuntimeLogContext): void;
	outcome(status: RuntimeOutcome, message?: string): void;
	step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}

export interface RuntimeOperationOptions {
	/** Carrier from `runtimeContext.carrier()` (object or JSON string): links parent op, request id and trace. */
	from?: RuntimeCarrier | string | null;
	/** Receives the log flush promise once the operation completes (serverless `waitUntil`). */
	waitUntil?: (promise: Promise<unknown>) => void;
}

/** @internal */
export interface OperationState {
	id: string;
	name: string;
	kind: RuntimeOperationKind;
	parentId?: string;
	requestId?: string;
	parentTraceId?: string;
	attributes: RuntimeLogContext;
	startedAt: number;
	outcome: RuntimeOutcome;
	explicitOutcome?: boolean;
	message?: string;
	reportingStack?: string;
	sealed?: boolean;
	steps: Array<{ name: string; status: string; durationMs: number }>;
	inline: InlineLogState;
	ai?: AiRollup;
	error?: unknown;
	errorThrown?: boolean;
	req?: unknown;
	res?: unknown;
}

/** @internal */
export interface LoggerConfig {
	endpoint: string;
	apiKey: string;
	service: string;
	environment: string;
	release?: string;
	options?: RuntimeLoggingOptions;
	redact(attributes: Attributes): Attributes;
	/** Wrap an operation in a span; absent in logger-only mode. */
	run?<T>(
		name: string,
		fn: () => Promise<T>,
		attributes: Attributes,
		links?: Link[],
	): Promise<T>;
	reportOutcome(name: string, message: string, attributes: Attributes): void;
	/** Logger-only mode: record an exception thrown out of an operation. */
	captureThrown?(error: unknown): void;
}

/** @internal */
export const local = new AsyncLocalStorage<OperationState>();
let config: LoggerConfig | null = null;
let sinks: RuntimeSink[] = [];
const extraSinks = new Set<RuntimeSink>();
let fallbackConsole: RuntimeSink | null = null;

function redact(attributes: Attributes): Attributes {
	return config?.redact(attributes) ?? redactAttributes(attributes);
}
const safe = (attributes: RuntimeLogContext = {}) =>
	boundContext(attributes, redact);
const merge = (current: RuntimeLogContext, next?: RuntimeLogContext) =>
	mergeContext(current, next, redact);

function activeSinks(): RuntimeSink[] {
	if (config) return extraSinks.size ? [...sinks, ...extraSinks] : sinks;
	if (extraSinks.size) return [...extraSinks];
	fallbackConsole ??= consoleSink();
	return [fallbackConsole];
}

function defaultSinks(next: LoggerConfig): RuntimeSink[] {
	const options = next.options ?? {};
	if (options.sinks) return [...options.sinks];
	const file =
		options.file === undefined
			? process.env.NODE_ENV === "development"
			: options.file !== false;
	return [
		...(next.apiKey ? [otlpSink()] : []),
		...(options.console !== false ? [consoleSink()] : []),
		...(file
			? [fileSink(typeof options.file === "object" ? options.file : {})]
			: []),
	];
}

/** @internal The innermost live (unsealed) operation, if any. */
export function currentOperation(): OperationState | undefined {
	const state = local.getStore();
	return state && !state.sealed ? state : undefined;
}

function operationAttributes(state?: OperationState): RuntimeLogContext {
	return state
		? {
				"autter.operation.id": state.id,
				"autter.operation.name": state.name,
				...(state.parentId
					? { "autter.operation.parent_id": state.parentId }
					: {}),
				...(state.requestId ? { "autter.request.id": state.requestId } : {}),
				...(state.parentTraceId
					? { "autter.parent_trace_id": state.parentTraceId }
					: {}),
				...state.attributes,
			}
		: {};
}
/** @internal */
export function traceAttributes(state: OperationState): Attributes {
	return toSpanAttributes(operationAttributes(state));
}

interface EmitOptions {
	/** Emit for this operation instead of the ALS one. */
	state?: OperationState | null;
	/** Trace context to stamp (summaries finished outside their context). */
	span?: SpanContext;
}

function emit(
	level: RuntimeLogLevel,
	message: string,
	attributes: RuntimeLogContext,
	extra: Record<string, unknown> = {},
	options: EmitOptions = {},
): void {
	const state =
		options.state !== undefined ? (options.state ?? undefined) : local.getStore();
	if (state?.sealed) return; // work continuing after completion cannot mutate the emitted operation
	const summary = extra["autter.event.type"] === "operation";
	if (
		!summary &&
		LEVEL_SEVERITY[level] < LEVEL_SEVERITY[config?.options?.minLevel ?? "debug"]
	)
		return;
	if (!summary && state && config?.options?.inline !== false) {
		const { "exception.stacktrace": _stack, ...inlineAttrs } = userContext(
			attributes,
			redact,
		);
		appendInlineLog(state.inline, level, message, inlineAttrs, redact);
		if (level === "debug" || level === "info") return;
	}
	const span = options.span ?? trace.getActiveSpan()?.spanContext();
	const user = merge(state?.attributes ?? {}, attributes);
	const exceptions = Object.fromEntries(
		Object.entries(user).filter(([key]) => key.startsWith("exception.")),
	);
	const raw: Record<string, unknown> = {
		"autter.event.id": randomUUID(),
		...extra,
		...exceptions,
		...operationAttributes(state),
		...user,
	};
	const enrichers = config?.options?.enrich;
	if (summary && state && enrichers?.length) {
		const event: RuntimeEnrichEvent = { level, message, attributes: raw };
		for (const enrich of enrichers) {
			try {
				enrich(event, {
					req: state.req,
					res: state.res,
					operation: { id: state.id, name: state.name, kind: state.kind },
				});
			} catch {
				/* enrichers never break logging */
			}
		}
	}
	const event = createRuntimeEvent({
		level,
		message: String(safe({ message }).message ?? "").slice(0, 4000),
		attributes: safe(raw as RuntimeLogContext),
		...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
	});
	for (const sink of activeSinks()) {
		try {
			sink.write(event);
		} catch {
			/* a broken sink never breaks the application */
		}
	}
}

/** @internal */
export function configureRuntimeLogger(next: LoggerConfig): void {
	config = next;
	sinks = defaultSinks(next);
	for (const sink of sinks) {
		try {
			sink.start?.({
				endpoint: next.endpoint,
				apiKey: next.apiKey,
				service: next.service,
				environment: next.environment,
				...(next.release ? { release: next.release } : {}),
			});
		} catch {
			/* ignore */
		}
	}
}
/** @internal */
export function loggerConfigured(): LoggerConfig | null {
	return config;
}
/** @internal Register a sink for every record regardless of configuration (testing). */
export function addRuntimeSink(sink: RuntimeSink): () => void {
	extraSinks.add(sink);
	return () => extraSinks.delete(sink);
}
/** @internal Forward a captured exception to sinks that observe them. */
export function notifyException(error: unknown, attributes: Record<string, unknown> = {}): void {
	if (!extraSinks.size && !sinks.some((sink) => sink.exception)) return;
	const state = local.getStore();
	const record: CapturedException = {
		time: Date.now(),
		error,
		message: error instanceof Error ? error.message : String(error),
		type: error instanceof Error ? error.name : "Error",
		attributes: { ...attributes, ...errorAttributes(error) },
		...(state ? { operationId: state.id } : {}),
		...(state?.requestId ? { requestId: state.requestId } : {}),
	};
	for (const sink of [...sinks, ...extraSinks]) {
		try {
			sink.exception?.(record);
		} catch {
			/* ignore */
		}
	}
}

export function runtimeLogStats(): { buffered: number; dropped: number } {
	return {
		buffered: sinks.reduce((sum, sink) => sum + (sink.buffered?.() ?? 0), 0),
		dropped: sinkStats.dropped,
	};
}
export async function flushRuntimeLogs(): Promise<void> {
	if (!config) return;
	const results = await Promise.allSettled(
		sinks.map((sink) => Promise.resolve().then(() => sink.flush?.())),
	);
	const failed = results.find((result) => result.status === "rejected");
	if (failed) throw (failed as PromiseRejectedResult).reason;
}
/** @internal */
export async function shutdownRuntimeLogger(): Promise<void> {
	const active = sinks;
	const results = await Promise.allSettled(
		active.map((sink) => Promise.resolve().then(() => sink.shutdown?.())),
	);
	config = null;
	sinks = [];
	const failed = results.find((result) => result.status === "rejected");
	if (failed) throw (failed as PromiseRejectedResult).reason;
}

/** @internal Note an error on the current operation (summary gets autter.error.*). */
export function noteOperationError(
	error: unknown,
	thrown = false,
	state: OperationState | undefined = currentOperation(),
): void {
	if (!state || state.sealed) return;
	state.error = error;
	if (thrown) state.errorThrown = true;
}

/** @internal Add one LLM call to the current operation's AI rollup. */
export function recordOperationAiUsage(usage: AiUsageInput): void {
	const state = currentOperation();
	if (state) state.ai = addAiUsage(state.ai, usage);
}

export function createRuntimeLogger(attributes: RuntimeLogContext = {}) {
	const attrs = userContext(attributes, redact);
	return {
		debug: (message: string, extra?: RuntimeLogContext) =>
			emit("debug", message, merge(attrs, extra)),
		info: (message: string, extra?: RuntimeLogContext) =>
			emit("info", message, merge(attrs, extra)),
		warn: (message: string, extra?: RuntimeLogContext) =>
			emit("warning", message, merge(attrs, extra)),
		error: (error: unknown, extra?: RuntimeLogContext) =>
			emit(
				"error",
				error instanceof Error ? error.message : String(error),
				{
					...attrs,
					...extra,
					...(error instanceof Error
						? {
								"exception.type": error.name,
								"exception.stacktrace": error.stack ?? "",
							}
						: {}),
				},
				errorAttributes(error),
			),
	};
}
export const runtimeLogger = createRuntimeLogger();

/**
 * @internal Logger-only/edge-style exception capture: one error record with
 * `exception.*`, `autter.error.*` and `autter.capture.mode = "log"`, which
 * the ingester promotes to an occurrence.
 */
export function captureExceptionAsLog(
	error: unknown,
	attributes: Record<string, unknown> = {},
): void {
	const isError = error instanceof Error;
	const message = isError ? error.message : String(error);
	const stack = isError && error.stack
		? error.stack
		: (new Error().stack
				?.split("\n")
				.filter((line, i) => i === 0 || !/captureException/.test(line))
				.join("\n") ?? "");
	noteOperationError(error);
	emit(
		"error",
		message,
		{
			...(attributes as RuntimeLogContext),
			"exception.type": isError ? error.name : "Error",
			"exception.message": message,
			"exception.stacktrace": stack,
		},
		{ "autter.capture.mode": "log", ...errorAttributes(error) },
	);
}

function newState(
	name: string,
	kind: RuntimeOperationKind,
	attributes: RuntimeLogContext,
	link: {
		parentId?: string;
		requestId?: string;
		parentTraceId?: string;
		base?: RuntimeLogContext;
	},
): OperationState {
	const startedAt = Date.now();
	return {
		id: randomUUID(),
		name: String(safe({ name }).name).slice(0, 200),
		kind,
		...(link.parentId ? { parentId: link.parentId } : {}),
		...(link.requestId ? { requestId: link.requestId } : {}),
		...(link.parentTraceId ? { parentTraceId: link.parentTraceId } : {}),
		attributes: merge(link.base ?? {}, attributes),
		startedAt,
		outcome: "succeeded",
		steps: [],
		inline: createInlineLogState(startedAt),
	};
}

/** @internal Create the state for a request summary (middleware/wrappers). */
export function createRequestState(input: {
	name: string;
	requestId: string;
	req?: unknown;
	res?: unknown;
}): OperationState {
	const parent = currentOperation();
	const state = newState(input.name, "request", {}, {
		requestId: input.requestId,
		...(parent ? { parentId: parent.id } : {}),
	});
	state.req = input.req;
	state.res = input.res;
	return state;
}

function setOutcome(
	state: OperationState,
	status: RuntimeOutcome,
	message?: string,
): void {
	if (state.sealed) return;
	state.outcome = status;
	state.explicitOutcome = true;
	state.message = message;
	if (status === "failed")
		state.reportingStack =
			new Error("Operation outcome reported here").stack ?? "";
}

function operationHandle(state: OperationState): RuntimeOperation {
	return {
		id: state.id,
		setContext: (attrs) => {
			if (!state.sealed) {
				state.attributes = merge(state.attributes, attrs);
				trace.getActiveSpan()?.setAttributes(traceAttributes(state));
			}
		},
		outcome: (status, message) => setOutcome(state, status, message),
		step: async (stepName, stepFn) => {
			const started = Date.now();
			let status = "succeeded";
			try {
				return await stepFn();
			} catch (error) {
				status = "failed";
				throw error;
			} finally {
				if (!state.sealed && state.steps.length < 64)
					state.steps.push({
						name: String(safe({ name: stepName }).name).slice(0, 200),
						status,
						durationMs: Date.now() - started,
					});
			}
		},
	};
}

/** @internal Extra summary fields shared by operations and requests. */
function summaryExtra(
	state: OperationState,
	level: RuntimeLogLevel,
	http: Record<string, unknown> = {},
): Record<string, unknown> {
	const err = state.error;
	return {
		"autter.event.type": "operation",
		"autter.operation.outcome": state.outcome,
		"autter.operation.duration_ms": Date.now() - state.startedAt,
		"autter.operation.steps": state.steps,
		"autter.operation.kind": state.kind,
		"autter.operation.level": maxLevel(state.inline.level, level),
		...(state.ai ? { "autter.operation.ai": state.ai } : {}),
		...http,
		...(err !== undefined ? errorAttributes(err) : {}),
		...(state.inline.logsTruncated
			? { "autter.operation.logs_truncated": true }
			: {}),
		...(state.inline.logs.length
			? { "autter.operation.logs": state.inline.logs }
			: {}),
	};
}

/** @internal Emit the summary of an operation or request and seal it. */
export function emitSummary(
	state: OperationState,
	options: { http?: Record<string, unknown>; span?: SpanContext } = {},
): void {
	if (state.sealed) return;
	const err = state.error;
	const level: RuntimeLogLevel = state.outcome === "failed" ? "error" : "info";
	emit(
		level,
		state.message ?? `${state.name}: ${state.outcome}`,
		{
			...operationAttributes(state),
			...(err instanceof Error
				? {
						"exception.type": err.name,
						"exception.stacktrace": err.stack ?? "",
					}
				: {}),
		},
		summaryExtra(state, level, options.http),
		{ state, ...(options.span ? { span: options.span } : {}) },
	);
	state.sealed = true;
}

/** @internal Outcome reported via `outcome("failed")` without an exception. */
export function reportExplicitFailure(state: OperationState): void {
	if (state.outcome === "failed" && state.explicitOutcome && !state.errorThrown)
		config?.reportOutcome(state.name, state.message ?? "Operation failed", {
			...traceAttributes(state),
			"autter.outcome.stack": state.reportingStack ?? "",
		});
}

interface StartInternal {
	/** fork(): link to this operation even when it has already sealed. */
	forkParent?: OperationState;
}

function startOperation<T>(
	name: string,
	fn: (operation: RuntimeOperation) => T | Promise<T>,
	attributes: RuntimeLogContext,
	options: RuntimeOperationOptions,
	internal: StartInternal = {},
): Promise<T> {
	const parent = internal.forkParent ?? local.getStore();
	const carrier = options.from ? parseCarrier(options.from) : null;
	const traceparent = carrier?.traceparent
		? parseTraceparent(carrier.traceparent)
		: null;
	const linked = internal.forkParent !== undefined || (parent && !parent.sealed);
	const state = newState(
		name,
		"operation",
		attributes,
		carrier
			? {
					parentId: carrier.op,
					...(carrier.req ? { requestId: carrier.req } : {}),
					...(traceparent ? { parentTraceId: traceparent.traceId } : {}),
				}
			: {
					...(linked && parent ? { parentId: parent.id, base: parent.attributes } : {}),
					...(parent?.requestId ? { requestId: parent.requestId } : {}),
				},
	);
	const operation = operationHandle(state);
	const run = () =>
		local.run(state, async () => {
			let thrown: unknown;
			try {
				return await fn(operation);
			} catch (error) {
				state.outcome = "failed";
				thrown = error;
				noteOperationError(error, true, state);
				config?.captureThrown?.(error);
				throw error;
			} finally {
				trace.getActiveSpan()?.setAttributes({
					...traceAttributes(state),
					"autter.operation.outcome": state.outcome,
					"autter.operation.kind": state.kind,
				});
				if (state.outcome === "failed" && !thrown)
					config?.reportOutcome(
						state.name,
						state.message ?? "Operation failed",
						{
							...traceAttributes(state),
							"autter.outcome.stack": state.reportingStack ?? "",
						},
					);
				emitSummary(state);
			}
		});
	const links: Link[] = traceparent
		? [
				{
					context: {
						traceId: traceparent.traceId,
						spanId: traceparent.spanId,
						traceFlags: traceparent.sampled ? 1 : 0,
						isRemote: true,
					},
				},
			]
		: [];
	const promise = config?.run
		? config.run(state.name, run, traceAttributes(state), links)
		: run();
	if (!options.waitUntil) return promise;
	const waitUntil = options.waitUntil;
	return promise.finally(() => {
		try {
			waitUntil(flushRuntimeLogs().catch(() => {}));
		} catch {
			/* ignore */
		}
	});
}

/**
 * Run `fn` as a named operation: one summary record (outcome, duration,
 * steps, context, inline messages) when it ends. Nested operations link via
 * `autter.operation.parent_id`; pass `{ from: carrier }` to continue work
 * handed over through a queue or another process.
 */
export function withRuntimeOperation<T>(
	name: string,
	fn: (operation: RuntimeOperation) => T | Promise<T>,
	attributes: RuntimeLogContext = {},
	options: RuntimeOperationOptions = {},
): Promise<T> {
	return startOperation(name, fn, attributes, options);
}

/**
 * Like `runtimeContext.fork` but not awaited: errors are recorded on the
 * child operation (and its span) and never become unhandled rejections.
 */
export function runInBackground<T>(
	name: string,
	fn: (operation: RuntimeOperation) => T | Promise<T>,
): Promise<T | undefined> {
	return runtimeContext.fork(name, fn).catch(() => undefined);
}

/**
 * The current request/operation, from anywhere in its async call tree.
 * Every method is a safe no-op (or plain log) outside an operation.
 */
export const runtimeContext = {
	/** Merge attributes into the current summary's context. */
	set(attributes: RuntimeLogContext): void {
		const state = currentOperation();
		if (!state) return;
		state.attributes = merge(state.attributes, attributes);
		trace.getActiveSpan()?.setAttributes(traceAttributes(state));
	},
	/** Set the outcome explicitly (wins over status/thrown-error rules). */
	outcome(status: RuntimeOutcome, message?: string): void {
		const state = currentOperation();
		if (state) setOutcome(state, status, message);
	},
	debug(message: string, attributes?: RuntimeLogContext): void {
		runtimeLogger.debug(message, attributes);
	},
	info(message: string, attributes?: RuntimeLogContext): void {
		runtimeLogger.info(message, attributes);
	},
	warn(message: string, attributes?: RuntimeLogContext): void {
		runtimeLogger.warn(message, attributes);
	},
	/** Log an error and attach it (code/why/fix) to the current summary. */
	error(error: unknown, attributes?: RuntimeLogContext): void {
		noteOperationError(error);
		runtimeLogger.error(error, attributes);
	},
	/** Current operation id. */
	get id(): string | undefined {
		return local.getStore()?.id;
	},
	/** Current request id (inherited by child operations and forks). */
	get requestId(): string | undefined {
		return local.getStore()?.requestId;
	},
	/**
	 * Run `fn` as a child operation whose parent link is captured NOW, so it
	 * still links after the parent has finished (background work).
	 */
	fork<T>(
		name: string,
		fn: (operation: RuntimeOperation) => T | Promise<T>,
	): Promise<T> {
		const parent = local.getStore();
		return startOperation(name, fn, {}, {}, parent ? { forkParent: parent } : {});
	},
	/** Serialisable link for queue payloads: `{ v: 1, op, req?, traceparent? }`. */
	carrier(): RuntimeCarrier | undefined {
		const state = local.getStore();
		if (!state) return undefined;
		const span = trace.getActiveSpan()?.spanContext();
		const traceparent = span
			? formatTraceparent(span.traceId, span.spanId, (span.traceFlags & 1) === 1)
			: undefined;
		return createCarrier({
			op: state.id,
			...(state.requestId ? { req: state.requestId } : {}),
			...(traceparent ? { traceparent } : {}),
		});
	},
};
export type RuntimeContextHandle = typeof runtimeContext;
export type { RuntimeEvent };
