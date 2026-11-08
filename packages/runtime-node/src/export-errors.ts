import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { sharedSlot } from "./shared.js";

/**
 * Export and flush failures never reach the host app (the SDK must never
 * crash it). A wrong ingest key makes every export answer 401; before, the
 * rejection of `forceFlush()` (an array of OTLPExporterErrors) escaped from
 * `emitLlmSelftestTrace()`, `shutdown()` and `flushRuntimeLogs()`, and an
 * Express 4 route awaiting one of them left it unhandled, which exits Node.
 *
 * Every failure is instead
 *   - printed with `console.warn`, at most once a minute per kind of failure,
 *     with what to fix ("check your ingest key"),
 *   - passed to the `onExportError` option of initAutterServer /
 *     initAutterLogging (every failure, not rate limited),
 *   - returned in the result of the flush that hit it (`{ ok, errors }`).
 *
 * Exporters are wrapped (`GuardedSpanExporter`, `GuardedMetricExporter`) so a
 * failed batch is reported where it happens, including the periodic exports
 * nobody awaits, and an exporter that throws still answers through its result
 * callback. Flush paths (`settleFlush`) catch what OTel rejects with and
 * resolve.
 */

export type AutterExportErrorKind =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "payload_too_large"
	| "rate_limited"
	| "server_error"
	| "client_error"
	| "unreachable"
	| "timeout"
	| "not_initialized"
	| "other";

export type AutterExportSignal = "traces" | "metrics" | "logs" | "telemetry";

export type AutterExportOperation = "export" | "flush" | "shutdown" | "selftest" | "init";

/** One telemetry export or flush that failed. */
export interface AutterExportError {
	/** What failed, e.g. "unauthorized" for a 401 (a wrong or unknown ingest key). */
	kind: AutterExportErrorKind;
	/** The HTTP status the ingester answered with, when it answered. */
	status?: number;
	/** Which pipe: traces, metrics, logs, or "telemetry" when a flush can't tell. */
	signal: AutterExportSignal;
	/** A batch export (periodic or forced), a flush, shutdown, the LLM self-test, or init. */
	operation: AutterExportOperation;
	/** What happened and what to do about it (the text of the console warning). */
	message: string;
	/**
	 * The original error (an OTLPExporterError, a network error, …).
	 * Not enumerable, so `res.json(result)` and JSON.stringify never meet a
	 * circular or bulky error object.
	 */
	readonly error: unknown;
}

/** Result of a flush: never rejected, `ok: false` with the failures instead. */
export interface AutterFlushResult {
	ok: boolean;
	errors: AutterExportError[];
}

export type AutterExportErrorHandler = (error: AutterExportError) => void;

interface Reported {
	seq: number;
	report: AutterExportError;
}

/** Shared by every copy of the package in the process (see shared.ts). */
interface ExportErrorSlot {
	/** `onExportError` of the running initAutterServer / initAutterLogging. */
	handler: AutterExportErrorHandler | null;
	/** Ingester base URL, for the messages. */
	endpoint: string;
	/** Error objects already reported, so a rejection carrying one is not reported twice. */
	reported: WeakSet<object>;
	/** Last warning time per kind of failure (rate limit). */
	lastWarnAt: Map<string, number>;
	/** Failures left out by the rate limit since the last warning, per kind. */
	suppressed: Map<string, number>;
	/** Increments per report; flushes compare it to find their own failures. */
	seq: number;
	/** The latest reports (bounded). */
	recent: Reported[];
}

const E = sharedSlot<ExportErrorSlot>("exportErrors", () => ({
	handler: null,
	endpoint: "",
	reported: new WeakSet<object>(),
	lastWarnAt: new Map<string, number>(),
	suppressed: new Map<string, number>(),
	seq: 0,
	recent: [],
}));

const WARN_INTERVAL_MS = 60_000;
const RECENT_LIMIT = 50;

/** @internal Set by initAutterServer / initAutterLogging. */
export function configureExportErrors(options: {
	endpoint: string;
	onExportError?: AutterExportErrorHandler | undefined;
}): void {
	E.endpoint = options.endpoint;
	E.handler = typeof options.onExportError === "function" ? options.onExportError : null;
	E.lastWarnAt.clear();
	E.suppressed.clear();
}

/** @internal Cleared on shutdown, after the shutdown's own failures were reported. */
export function resetExportErrors(): void {
	E.handler = null;
}

/** Arrays (BasicTracerProvider.forceFlush), AggregateErrors and `errors` lists, flattened. */
function flatten(error: unknown, out: unknown[] = [], depth = 0): unknown[] {
	if (depth > 4) {
		out.push(error);
		return out;
	}
	if (Array.isArray(error)) {
		for (const item of error) flatten(item, out, depth + 1);
		return out;
	}
	if (
		error &&
		typeof error === "object" &&
		Array.isArray((error as { errors?: unknown }).errors) &&
		(error as { errors: unknown[] }).errors.length
	) {
		for (const item of (error as { errors: unknown[] }).errors) flatten(item, out, depth + 1);
		return out;
	}
	out.push(error);
	return out;
}

const NETWORK_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"ECONNABORTED",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
]);

function field(value: unknown, key: string): unknown {
	return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	const message = field(error, "message");
	if (typeof message === "string") return message;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

/** HTTP status: OTLPExporterError.code, `status` on the log sink's error, or "(401)" in a message. */
function statusOf(error: unknown): number | undefined {
	for (const key of ["code", "status", "statusCode"]) {
		const value = field(error, key);
		if (typeof value === "number" && value >= 100 && value < 600) return value;
	}
	const match = /\((\d{3})\)|\bstatus(?: code)? (\d{3})\b/i.exec(messageOf(error));
	const status = Number(match?.[1] ?? match?.[2]);
	return status >= 100 && status < 600 ? status : undefined;
}

/** A network error code on the error or its cause chain (fetch wraps it in `cause`). */
function networkCodeOf(error: unknown): string | undefined {
	let current: unknown = error;
	for (let i = 0; i < 4 && current; i++) {
		const code = field(current, "code");
		if (typeof code === "string" && (NETWORK_CODES.has(code) || /^E[A-Z]+$/.test(code))) return code;
		current = field(current, "cause");
	}
	return undefined;
}

const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	408: "Request Timeout",
	413: "Payload Too Large",
	415: "Unsupported Media Type",
	429: "Too Many Requests",
	500: "Internal Server Error",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
};

function at(): string {
	return E.endpoint ? ` at ${E.endpoint}` : "";
}

function classify(error: unknown): { kind: AutterExportErrorKind; status?: number; detail: string } {
	const status = statusOf(error);
	if (status !== undefined) {
		const text = STATUS_TEXT[status];
		const label = `${status}${text ? ` ${text}` : ""}`;
		if (status === 401)
			return {
				kind: "unauthorized",
				status,
				detail: `${label}) — check your ingest key: the ingester${at()} does not accept it. Pass a server key (autter_rt_…) as apiKey / AUTTER_RUNTIME_KEY; a local docker compose ingester accepts only the keys in its AUTTER_INGEST_KEYS (see docs/GETTING-STARTED.md)`,
			};
		if (status === 403)
			return {
				kind: "forbidden",
				status,
				detail: `${label}) — the ingester${at()} refused this key for this route: server telemetry needs a server key (autter_rt_…), not a client (autter_rtc_…) or upload key`,
			};
		if (status === 404)
			return {
				kind: "not_found",
				status,
				detail: `${label}) — check the endpoint: it must be the ingester's base URL (e.g. https://otlp.autter.dev), without /v1/…`,
			};
		if (status === 413)
			return { kind: "payload_too_large", status, detail: `${label}) — the ingester${at()} refused a batch as too large; it was dropped` };
		if (status === 429)
			return { kind: "rate_limited", status, detail: `${label}) — the ingester${at()} is rate limiting this key; telemetry is retried, then dropped` };
		if (status >= 500)
			return {
				kind: "server_error",
				status,
				detail: `${label}) — the ingester${at()} could not store telemetry; it is retried. If this persists, check the ingester's /healthz`,
			};
		return { kind: "client_error", status, detail: `${label}) — the ingester${at()} refused the request: ${messageOf(error)}` };
	}
	const network = networkCodeOf(error);
	if (network)
		return {
			kind: "unreachable",
			detail: `${network}) — could not reach the ingester${at()}. Is it running, and is the endpoint right?`,
		};
	const message = messageOf(error);
	if (field(error, "name") === "TimeoutError" || /time(?:d)?\s?out/i.test(message))
		return {
			kind: "timeout",
			detail: `timeout) — the ingester${at()} did not answer in time: ${message}`,
		};
	return { kind: "other", detail: `${message})` };
}

function warn(report: AutterExportError): void {
	const key = `${report.kind}:${report.status ?? ""}`;
	const now = Date.now();
	const last = E.lastWarnAt.get(key);
	if (last !== undefined && now - last < WARN_INTERVAL_MS) {
		E.suppressed.set(key, (E.suppressed.get(key) ?? 0) + 1);
		return;
	}
	const skipped = E.suppressed.get(key) ?? 0;
	E.suppressed.delete(key);
	E.lastWarnAt.set(key, now);
	try {
		console.warn(
			`[autter-runtime] ${report.message}${skipped ? ` (${skipped} more like this in the last minute)` : ""}`,
		);
	} catch {
		/* a broken console never breaks the app */
	}
}

function makeReport(fields: Omit<AutterExportError, "error">, error: unknown): AutterExportError {
	const report = { ...fields } as AutterExportError;
	Object.defineProperty(report, "error", { value: error, enumerable: false });
	return report;
}

function deliver(report: AutterExportError): void {
	E.recent.push({ seq: ++E.seq, report });
	if (E.recent.length > RECENT_LIMIT) E.recent.splice(0, E.recent.length - RECENT_LIMIT);
	warn(report);
	const handler = E.handler;
	if (handler) {
		try {
			const result = handler(report) as unknown;
			// An async handler that rejects is not an unhandled rejection either.
			if (result && typeof (result as Promise<unknown>).catch === "function")
				(result as Promise<unknown>).catch(() => {});
		} catch {
			/* the app's handler never breaks export */
		}
	}
}

function verb(operation: AutterExportOperation, signal: AutterExportSignal): string {
	const what = signal === "telemetry" ? "telemetry" : signal;
	switch (operation) {
		case "export":
			return `${what} export failed`;
		case "flush":
			return `${what} flush failed`;
		case "shutdown":
			return `${what} flush at shutdown failed`;
		case "selftest":
			return "LLM self-test export failed";
		case "init":
			return "initialisation failed";
	}
}

/**
 * @internal Report a failure (an error, or an array / AggregateError of
 * them). Errors already reported are skipped. Never throws.
 */
export function reportExportError(
	error: unknown,
	signal: AutterExportSignal,
	operation: AutterExportOperation,
): AutterExportError[] {
	const out: AutterExportError[] = [];
	try {
		for (const item of flatten(error)) {
			if (item && typeof item === "object") {
				if (E.reported.has(item)) continue;
				E.reported.add(item);
			}
			const { kind, status, detail } = classify(item);
			const report = makeReport(
				{
					kind,
					...(status !== undefined ? { status } : {}),
					signal,
					operation,
					message: `${verb(operation, signal)} (${detail}`,
				},
				item,
			);
			deliver(report);
			out.push(report);
		}
	} catch {
		/* reporting never throws */
	}
	return out;
}

/** @internal Report an SDK usage problem (e.g. the self-test before init). */
export function reportSdkProblem(
	kind: AutterExportErrorKind,
	operation: AutterExportOperation,
	message: string,
): AutterExportError {
	const report = makeReport({ kind, signal: "telemetry", operation, message }, new Error(message));
	try {
		deliver(report);
	} catch {
		/* never throws */
	}
	return report;
}

function errorsSince(seq: number): AutterExportError[] {
	return E.recent.filter((entry) => entry.seq > seq).map((entry) => entry.report);
}

/**
 * @internal Run a flush (or shutdown) and never reject: failures are
 * reported and returned. Export failures the guarded exporters already
 * reported during this flush are returned as they are, and errors OTel
 * derives from them (an array of the same errors, the metric reader's
 * re-wrapped message) are not reported a second time.
 */
export async function settleFlush(
	signal: AutterExportSignal,
	operation: AutterExportOperation,
	run: () => unknown,
): Promise<AutterFlushResult> {
	const mark = exportErrorMark();
	try {
		await run();
		return { ok: true, errors: [] };
	} catch (error) {
		reportUnexplained(error, signal, operation, mark);
		try {
			return { ok: false, errors: errorsSince(mark) };
		} catch {
			return { ok: false, errors: [] };
		}
	}
}

/** @internal Pass to reportUnexplained: failures reported after this point. */
export function exportErrorMark(): number {
	return E.seq;
}

/**
 * @internal Report what a flush rejected with, unless it is already
 * accounted for: errors already reported are skipped, and when a failure of
 * the same signal was reported since `mark` the rest is taken to be derived
 * from it (OTel re-wraps a failed export: the metric reader's "metrics export
 * failed (error …)", a provider's array of its processors' errors). What is
 * left is the only account of the failure (a timeout, a log sink error).
 */
export function reportUnexplained(
	error: unknown,
	signal: AutterExportSignal,
	operation: AutterExportOperation,
	mark: number,
): void {
	try {
		const fresh = flatten(error).filter(
			(item) => !(item && typeof item === "object" && E.reported.has(item)),
		);
		if (!fresh.length) return;
		const explained = E.recent.some(
			(entry) => entry.seq > mark && (signal === "telemetry" || entry.report.signal === signal),
		);
		if (explained) {
			// Derived errors are not reported again, nor on a later flush.
			for (const item of fresh) if (item && typeof item === "object") E.reported.add(item);
			return;
		}
		reportExportError(fresh, signal, operation);
	} catch {
		/* never throws */
	}
}

function guardedCallback(
	signal: AutterExportSignal,
	resultCallback: (result: ExportResult) => void,
): (result: ExportResult) => void {
	let done = false;
	return (result) => {
		if (done) return;
		done = true;
		if (result.code !== ExportResultCode.SUCCESS) {
			reportExportError(result.error ?? new Error(`${signal} export failed`), signal, "export");
		}
		try {
			resultCallback(result);
		} catch {
			/* the processor's callback never breaks the exporter */
		}
	};
}

/**
 * @internal Outermost wrapper of every span exporter: a failed batch is
 * reported where it happens and still answered through the result callback
 * (never thrown), so the batch processor can account for it.
 */
export class GuardedSpanExporter implements SpanExporter {
	constructor(
		private readonly inner: SpanExporter,
		private readonly signal: AutterExportSignal = "traces",
	) {}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		const done = guardedCallback(this.signal, resultCallback);
		try {
			this.inner.export(spans, done);
		} catch (error) {
			done({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(messageOf(error)) });
		}
	}

	async shutdown(): Promise<void> {
		try {
			await this.inner.shutdown();
		} catch (error) {
			reportExportError(error, this.signal, "shutdown");
		}
	}

	async forceFlush(): Promise<void> {
		try {
			await this.inner.forceFlush?.();
		} catch (error) {
			reportExportError(error, this.signal, "flush");
		}
	}
}

/** @internal The metric counterpart of GuardedSpanExporter. */
export class GuardedMetricExporter implements PushMetricExporter {
	readonly selectAggregationTemporality?: PushMetricExporter["selectAggregationTemporality"];
	readonly selectAggregation?: PushMetricExporter["selectAggregation"];

	constructor(
		private readonly inner: PushMetricExporter,
		private readonly signal: AutterExportSignal = "metrics",
	) {
		if (inner.selectAggregationTemporality)
			this.selectAggregationTemporality = inner.selectAggregationTemporality.bind(inner);
		if (inner.selectAggregation) this.selectAggregation = inner.selectAggregation.bind(inner);
	}

	export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
		const done = guardedCallback(this.signal, resultCallback);
		try {
			this.inner.export(metrics, done);
		} catch (error) {
			done({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(messageOf(error)) });
		}
	}

	async forceFlush(): Promise<void> {
		try {
			await this.inner.forceFlush();
		} catch (error) {
			reportExportError(error, this.signal, "flush");
		}
	}

	async shutdown(): Promise<void> {
		try {
			await this.inner.shutdown();
		} catch (error) {
			reportExportError(error, this.signal, "shutdown");
		}
	}
}
