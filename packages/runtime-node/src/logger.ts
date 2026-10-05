import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { trace, type Attributes } from "@opentelemetry/api";
import { redactAttributes } from "./redact.js";

export type RuntimeLogContextValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| RuntimeLogContextValue[]
	| { [key: string]: RuntimeLogContextValue };
export type RuntimeLogContext = Record<string, RuntimeLogContextValue>;
export type RuntimeLogLevel = "debug" | "info" | "warning" | "error";
export type RuntimeOutcome =
	| "succeeded"
	| "failed"
	| "degraded"
	| "cancelled"
	| "pending";
export interface RuntimeLoggingOptions {
	console?: boolean;
	minLevel?: RuntimeLogLevel;
}
export interface RuntimeOperation {
	readonly id: string;
	setContext(attributes: RuntimeLogContext): void;
	outcome(status: RuntimeOutcome, message?: string): void;
	step<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}
interface OperationState {
	id: string;
	name: string;
	parentId?: string;
	attributes: RuntimeLogContext;
	startedAt: number;
	outcome: RuntimeOutcome;
	message?: string;
	reportingStack?: string;
	sealed?: boolean;
	steps: Array<{ name: string; status: string; durationMs: number }>;
}
interface LoggerConfig {
	endpoint: string;
	apiKey: string;
	service: string;
	environment: string;
	release?: string;
	options?: RuntimeLoggingOptions;
	redact(attributes: Attributes): Attributes;
	run<T>(
		name: string,
		fn: () => Promise<T>,
		attributes: Attributes,
	): Promise<T>;
	reportOutcome(name: string, message: string, attributes: Attributes): void;
}
const local = new AsyncLocalStorage<OperationState>();
let config: LoggerConfig | null = null;
interface QueuedLog {
	record: Record<string, unknown>;
	bytes: number;
}
let queue: QueuedLog[] = [];
let queueBytes = 0;
let inFlightBytes = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;
let dropped = 0;
let inFlight = 0;
let stopping = false;
let failureStreak = 0;
const severity = { debug: 5, info: 9, warning: 13, error: 17 };

function safe(attributes: RuntimeLogContext = {}): RuntimeLogContext {
	const redacted =
		config?.redact(attributes as Attributes) ??
		redactAttributes(attributes as Attributes);
	let budget = 512;
	let characters = 16384;
	let truncated = false;
	const visit = (input: unknown, depth: number): unknown => {
		if (--budget < 0 || depth > 6) {
			truncated = true;
			return "[truncated]";
		}
		if (typeof input === "string") {
			const text = input.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1");
			const kept = text.slice(0, Math.max(0, characters));
			truncated ||= kept.length < text.length;
			characters -= kept.length;
			return kept;
		}
		if (typeof input === "number")
			return Number.isFinite(input) ? input : undefined;
		if (typeof input === "boolean" || input === null) return input;
		if (Array.isArray(input)) {
			truncated ||= input.length > 64;
			return input.slice(0, 64).map((item) => visit(item, depth + 1));
		}
		if (input && typeof input === "object") {
			const entries = Object.entries(input);
			if (depth === 0) {
				const priority = (key: string) =>
					/^autter\.(?:operation|event)\./.test(key)
						? 2
						: /^exception\./.test(key)
							? 1
							: 0;
				entries.sort(([a], [b]) => priority(b) - priority(a));
			}
			truncated ||= entries.length > 100;
			return Object.fromEntries(
				entries
					.slice(0, 100)
					.filter(([key]) => !/^(?:__proto__|constructor|prototype)$/.test(key))
					.map(([key, item]) => [key.slice(0, 200), visit(item, depth + 1)]),
			);
		}
		return undefined;
	};
	const result = visit(redacted, 0) as RuntimeLogContext;
	if (truncated) result["autter.context.truncated"] = true;
	return result;
}
function operationAttributes(state?: OperationState): RuntimeLogContext {
	return state
		? {
				"autter.operation.id": state.id,
				"autter.operation.name": state.name,
				...(state.parentId
					? { "autter.operation.parent_id": state.parentId }
					: {}),
				...state.attributes,
			}
		: {};
}
function userAttributes(attributes: RuntimeLogContext = {}): RuntimeLogContext {
	return Object.fromEntries(
		Object.entries(safe(attributes)).filter(
			([key]) => !/^autter\.(?:operation|event)\./.test(key),
		),
	);
}
function mergeContext(
	current: RuntimeLogContext,
	next: RuntimeLogContext = {},
): RuntimeLogContext {
	const merge = (
		left: RuntimeLogContext,
		right: RuntimeLogContext,
		depth: number,
	): RuntimeLogContext => {
		const result = { ...left };
		for (const [key, value] of Object.entries(right)) {
			const prior = result[key];
			result[key] =
				depth < 6 &&
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				prior &&
				typeof prior === "object" &&
				!Array.isArray(prior)
					? merge(prior, value, depth + 1)
					: value;
		}
		return result;
	};
	return userAttributes(merge(current, userAttributes(next), 0));
}
function traceAttributes(state: OperationState): Attributes {
	return Object.fromEntries(
		Object.entries(operationAttributes(state))
			.filter(([, item]) => item !== null && item !== undefined)
			.map(([key, item]) => [
				key,
				typeof item === "object" ? JSON.stringify(item) : item,
			]),
	);
}
function scheduleFlush(): void {
	if (!timer && config && !stopping && queue.length) {
		timer = setTimeout(
			() => {
				timer = undefined;
				void flushRuntimeLogs().catch(() => {});
			},
			Math.min(30000, 2000 * 2 ** Math.min(failureStreak, 4)),
		);
		timer.unref();
	}
}
function value(input: unknown): Record<string, unknown> {
	if (typeof input === "number") return { doubleValue: input };
	if (typeof input === "boolean") return { boolValue: input };
	if (Array.isArray(input))
		return { arrayValue: { values: input.slice(0, 64).map(value) } };
	if (input && typeof input === "object")
		return {
			kvlistValue: {
				values: Object.entries(input)
					.slice(0, 128)
					.map(([key, item]) => ({ key, value: value(item) })),
			},
		};
	return { stringValue: String(input ?? "").slice(0, 32000) };
}
function emit(
	level: RuntimeLogLevel,
	message: string,
	attributes: RuntimeLogContext,
	extra: Record<string, unknown> = {},
): void {
	const state = local.getStore();
	if (state?.sealed) return; // work continuing after completion cannot mutate the emitted operation
	if (
		extra["autter.event.type"] !== "operation" &&
		severity[level] < severity[config?.options?.minLevel ?? "debug"]
	)
		return;
	const span = trace.getActiveSpan()?.spanContext();
	const user = mergeContext(state?.attributes ?? {}, attributes);
	const exceptions = Object.fromEntries(
		Object.entries(user).filter(([key]) => key.startsWith("exception.")),
	);
	const attrs = safe({
		"autter.event.id": randomUUID(),
		...extra,
		...exceptions,
		...operationAttributes(state),
		...user,
	} as RuntimeLogContext);
	const record = {
		timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
		severityNumber: severity[level],
		severityText: level.toUpperCase(),
		body: value(String(safe({ message }).message ?? "").slice(0, 4000)),
		attributes: Object.entries(attrs).map(([key, item]) => ({
			key,
			value: value(item),
		})),
		...(span &&
		/^[a-f0-9]{32}$/.test(span.traceId) &&
		!/^0+$/.test(span.traceId)
			? { traceId: span.traceId, spanId: span.spanId }
			: {}),
	};
	if (config?.options?.console !== false)
		console.log(
			JSON.stringify({ ...attrs, level, message: record.body.stringValue }),
		);
	if (!config) return;
	if (stopping) {
		dropped++;
		return;
	}
	const bytes = Buffer.byteLength(JSON.stringify(record));
	if (
		bytes > 256 * 1024 ||
		queue.length + inFlight >= 1000 ||
		queueBytes + inFlightBytes + bytes > 4 * 1024 * 1024
	) {
		dropped++;
		console.warn(
			"[autter-runtime] log buffer or record limit reached; record dropped",
		);
		return;
	}
	queue.push({ record, bytes });
	queueBytes += bytes;
	scheduleFlush();
}

export function configureRuntimeLogger(next: LoggerConfig): void {
	config = next;
	stopping = false;
	failureStreak = 0;
}
export function runtimeLogStats(): { buffered: number; dropped: number } {
	return { buffered: queue.length + inFlight, dropped };
}
export async function flushRuntimeLogs(): Promise<void> {
	if (flushing) return flushing;
	if (!config || !queue.length) return;
	if (timer) {
		clearTimeout(timer);
		timer = undefined;
	}
	const activeConfig = config;
	const deadline = Date.now() + 10000;
	flushing = (async () => {
		const count = queue.length;
		for (let remaining = count; remaining > 0; ) {
			const batch: QueuedLog[] = [];
			inFlightBytes = 0;
			while (batch.length < Math.min(50, remaining) && queue.length) {
				const next = queue[0]!;
				if (batch.length && inFlightBytes + next.bytes > 512 * 1024) break;
				batch.push(queue.shift()!);
				inFlightBytes += next.bytes;
				queueBytes -= next.bytes;
			}
			remaining -= batch.length;
			inFlight = batch.length;
			const body = JSON.stringify({
				resourceLogs: [
					{
						resource: {
							attributes: Object.entries({
								"service.name": activeConfig.service,
								"deployment.environment.name": activeConfig.environment,
								...(activeConfig.release
									? { "service.version": activeConfig.release }
									: {}),
							}).map(([key, item]) => ({ key, value: value(item) })),
						},
						scopeLogs: [
							{
								scope: { name: "autter-runtime" },
								logRecords: batch.map((entry) => entry.record),
							},
						],
					},
				],
			});
			let failure: unknown;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					if (Date.now() >= deadline)
						throw new Error("Runtime log flush exceeded 10 seconds");
					const response = await fetch(`${activeConfig.endpoint}/v1/logs`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${activeConfig.apiKey}`,
						},
						body,
						signal: AbortSignal.timeout(
							Math.max(1, Math.min(3000, deadline - Date.now())),
						),
					});
					if (!response.ok)
						throw new Error(`Runtime log export failed (${response.status})`);
					failure = undefined;
					break;
				} catch (error) {
					failure = error;
				}
			}
			inFlight = 0;
			if (failure) {
				failureStreak++;
				queue = [...batch, ...queue];
				queueBytes += inFlightBytes;
				inFlightBytes = 0;
				throw failure;
			}
			inFlightBytes = 0;
			failureStreak = 0;
		}
	})().finally(() => {
		flushing = null;
		scheduleFlush();
	});
	return flushing;
}
export async function shutdownRuntimeLogger(): Promise<void> {
	stopping = true;
	try {
		await flushRuntimeLogs();
	} finally {
		if (queue.length) {
			dropped += queue.length;
			console.warn(
				`[autter-runtime] ${queue.length} log records could not be delivered before shutdown`,
			);
		}
		queue = [];
		queueBytes = 0;
		config = null;
		if (timer) clearTimeout(timer);
		timer = undefined;
	}
}

export function createRuntimeLogger(attributes: RuntimeLogContext = {}) {
	const attrs = userAttributes(attributes);
	return {
		debug: (message: string, extra?: RuntimeLogContext) =>
			emit("debug", message, mergeContext(attrs, extra)),
		info: (message: string, extra?: RuntimeLogContext) =>
			emit("info", message, mergeContext(attrs, extra)),
		warn: (message: string, extra?: RuntimeLogContext) =>
			emit("warning", message, mergeContext(attrs, extra)),
		error: (error: unknown, extra?: RuntimeLogContext) =>
			emit("error", error instanceof Error ? error.message : String(error), {
				...attrs,
				...extra,
				...(error instanceof Error
					? {
							"exception.type": error.name,
							"exception.stacktrace": error.stack ?? "",
						}
					: {}),
			}),
	};
}
export const runtimeLogger = createRuntimeLogger();

/** Context stays local to this operation; queues/processes require explicit propagation. */
export function withRuntimeOperation<T>(
	name: string,
	fn: (operation: RuntimeOperation) => T | Promise<T>,
	attributes: RuntimeLogContext = {},
): Promise<T> {
	const parent = local.getStore();
	const state: OperationState = {
		id: randomUUID(),
		name: String(safe({ name }).name).slice(0, 200),
		parentId: parent?.sealed ? undefined : parent?.id,
		attributes: mergeContext(
			parent?.sealed ? {} : (parent?.attributes ?? {}),
			attributes,
		),
		startedAt: Date.now(),
		outcome: "succeeded",
		steps: [],
	};
	const operation: RuntimeOperation = {
		id: state.id,
		setContext: (attrs) => {
			if (!state.sealed) {
				state.attributes = mergeContext(state.attributes, attrs);
				trace.getActiveSpan()?.setAttributes(traceAttributes(state));
			}
		},
		outcome: (status, message) => {
			if (state.sealed) return;
			state.outcome = status;
			state.message = message;
			if (status === "failed")
				state.reportingStack =
					new Error("Operation outcome reported here").stack ?? "";
		},
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
	const run = () =>
		local.run(state, async () => {
			let thrown: unknown;
			try {
				return await fn(operation);
			} catch (error) {
				state.outcome = "failed";
				thrown = error;
				throw error;
			} finally {
				trace.getActiveSpan()?.setAttributes({
					...traceAttributes(state),
					"autter.operation.outcome": state.outcome,
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
				emit(
					state.outcome === "failed" ? "error" : "info",
					state.message ?? `${state.name}: ${state.outcome}`,
					{
						...operationAttributes(state),
						...(thrown instanceof Error
							? {
									"exception.type": thrown.name,
									"exception.stacktrace": thrown.stack ?? "",
								}
							: {}),
					},
					{
						"autter.event.type": "operation",
						"autter.operation.outcome": state.outcome,
						"autter.operation.duration_ms": Date.now() - state.startedAt,
						"autter.operation.steps": state.steps,
					},
				);
				state.sealed = true;
			}
		});
	return config ? config.run(state.name, run, traceAttributes(state)) : run();
}
