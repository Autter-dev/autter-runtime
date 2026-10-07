import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	buildOtlpLogsRequest,
	isSummary,
	toOtlpLogRecord,
	type OtlpLogRecord,
	type RuntimeEvent,
} from "@autter/runtime-core";

/**
 * Where runtime records go. The logger pipeline is
 * `enrich → redact/bound → sinks[]`; each sink receives the same immutable
 * RuntimeEvent. Defaults: `[otlpSink(), consoleSink()]` (+ `fileSink()` when
 * NODE_ENV=development). Sinks must never throw into application code.
 */
export interface RuntimeSink {
	readonly name: string;
	/** Called when the logger is (re)configured; null before init. */
	start?(context: RuntimeSinkContext): void;
	write(event: RuntimeEvent): void;
	flush?(): Promise<void>;
	shutdown?(): Promise<void>;
	/** Records held in memory awaiting delivery. */
	buffered?(): number;
	/** @internal Receives every captureException call (testing sinks). */
	exception?(record: CapturedException): void;
}

export interface RuntimeSinkContext {
	endpoint: string;
	apiKey: string;
	service: string;
	environment: string;
	release?: string;
}

export interface CapturedException {
	time: number;
	error: unknown;
	message: string;
	type: string;
	attributes: Record<string, unknown>;
	operationId?: string;
	requestId?: string;
}

/** Cumulative drop counter shared by every sink (runtimeLogStats().dropped). */
export const sinkStats = { dropped: 0 };

// ---------------------------------------------------------------------------
// OTLP
// ---------------------------------------------------------------------------

export interface OtlpSinkOptions {
	/** Override the ingester base URL (default: the configured endpoint). */
	endpoint?: string;
	/** Override the ingest key (default: the configured apiKey). */
	apiKey?: string;
}

interface QueuedLog {
	record: OtlpLogRecord;
	bytes: number;
}

/**
 * OTLP/HTTP JSON export to `${endpoint}/v1/logs`. Bounded exactly like
 * 1.4.0: 1000 records / 4 MiB buffered, 256 KiB per record, batches of 50
 * (≤ 512 KiB), 3 attempts within a 10 s deadline, exponential back-off
 * on failure, undelivered records reported at shutdown.
 */
export function otlpSink(options: OtlpSinkOptions = {}): RuntimeSink {
	let context: RuntimeSinkContext | null = null;
	let queue: QueuedLog[] = [];
	let queueBytes = 0;
	let inFlightBytes = 0;
	let inFlight = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let flushing: Promise<void> | null = null;
	let stopping = false;
	let failureStreak = 0;

	const scheduleFlush = () => {
		if (!timer && context && !stopping && queue.length) {
			timer = setTimeout(
				() => {
					timer = undefined;
					void flush().catch(() => {});
				},
				Math.min(30000, 2000 * 2 ** Math.min(failureStreak, 4)),
			);
			timer.unref();
		}
	};

	const flush = async (): Promise<void> => {
		if (flushing) return flushing;
		if (!context || !queue.length) return;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		const active = context;
		const endpoint = (options.endpoint ?? active.endpoint).replace(/\/$/, "");
		const apiKey = options.apiKey ?? active.apiKey;
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
				const body = JSON.stringify(
					buildOtlpLogsRequest(
						{
							service: active.service,
							environment: active.environment,
							...(active.release ? { release: active.release } : {}),
						},
						batch.map((entry) => entry.record),
					),
				);
				let failure: unknown;
				for (let attempt = 0; attempt < 3; attempt++) {
					try {
						if (Date.now() >= deadline)
							throw new Error("Runtime log flush exceeded 10 seconds");
						const response = await fetch(`${endpoint}/v1/logs`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${apiKey}`,
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
	};

	return {
		name: "otlp",
		start(next) {
			context = next;
			stopping = false;
			failureStreak = 0;
		},
		write(event) {
			if (!context) return;
			if (stopping) {
				sinkStats.dropped++;
				return;
			}
			const record = toOtlpLogRecord(event);
			const bytes = Buffer.byteLength(JSON.stringify(record));
			if (
				bytes > 256 * 1024 ||
				queue.length + inFlight >= 1000 ||
				queueBytes + inFlightBytes + bytes > 4 * 1024 * 1024
			) {
				sinkStats.dropped++;
				console.warn(
					"[autter-runtime] log buffer or record limit reached; record dropped",
				);
				return;
			}
			queue.push({ record, bytes });
			queueBytes += bytes;
			scheduleFlush();
		},
		flush,
		async shutdown() {
			stopping = true;
			try {
				await flush();
			} finally {
				if (queue.length) {
					sinkStats.dropped += queue.length;
					console.warn(
						`[autter-runtime] ${queue.length} log records could not be delivered before shutdown`,
					);
				}
				queue = [];
				queueBytes = 0;
				context = null;
				if (timer) clearTimeout(timer);
				timer = undefined;
			}
		},
		buffered: () => queue.length + inFlight,
	};
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export interface ConsoleSinkOptions {
	/** Default: "pretty" unless NODE_ENV === "production", then "json". */
	format?: "pretty" | "json";
	/** Colourise pretty output. Default: stdout is a TTY and NO_COLOR is unset. */
	color?: boolean;
	/** Line writer. Default console.log. */
	write?: (line: string) => void;
}

const ANSI = {
	dim: "\u001b[2m",
	red: "\u001b[31m",
	yellow: "\u001b[33m",
	green: "\u001b[32m",
	cyan: "\u001b[36m",
	bold: "\u001b[1m",
	reset: "\u001b[0m",
};

function shortValue(value: unknown): string {
	if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
	if (value && typeof value === "object") {
		const text = JSON.stringify(value);
		return text.length > 120 ? `${text.slice(0, 117)}...` : text;
	}
	return String(value);
}

/** `a.b=1 c=x` for user keys of a context tree (SDK-owned keys skipped). */
function flatPairs(attributes: Record<string, unknown>): string {
	const pairs: string[] = [];
	const visit = (prefix: string, value: unknown, depth: number) => {
		if (pairs.length >= 24) return;
		if (value && typeof value === "object" && !Array.isArray(value) && depth < 3) {
			for (const [key, item] of Object.entries(value))
				visit(prefix ? `${prefix}.${key}` : key, item, depth + 1);
			return;
		}
		pairs.push(`${prefix}=${shortValue(value)}`);
	};
	for (const [key, value] of Object.entries(attributes)) {
		if (/^(?:autter\.|exception\.|http\.(?:request\.method|route|response\.status_code)$)/.test(key))
			continue;
		visit(key, value, 0);
	}
	return pairs.join(" ");
}

/** Pretty one-line-plus-tree rendering used by consoleSink in development. */
export function formatPretty(event: RuntimeEvent, color = false): string {
	const paint = (code: keyof typeof ANSI, text: string) =>
		color ? `${ANSI[code]}${text}${ANSI.reset}` : text;
	const a = event.attributes as Record<string, unknown>;
	const time = new Date(event.time).toISOString().slice(11, 23);
	const levelColor =
		event.level === "error" ? "red" : event.level === "warning" ? "yellow" : "dim";
	const level = paint(levelColor, event.level.toUpperCase().padEnd(7));
	if (!isSummary(event)) {
		const context = flatPairs(a);
		const op = typeof a["autter.operation.name"] === "string" ? paint("dim", ` [${a["autter.operation.name"]}]`) : "";
		return `${paint("dim", time)} ${level} ${event.message}${context ? ` ${paint("dim", context)}` : ""}${op}`;
	}
	const outcome = String(a["autter.operation.outcome"] ?? "");
	const outcomeColor =
		outcome === "failed" ? "red" : outcome === "succeeded" ? "green" : "yellow";
	const status = a["http.response.status_code"];
	const head = [
		paint("dim", time),
		level,
		paint("bold", String(a["autter.operation.name"] ?? event.message)),
		paint(outcomeColor, outcome),
		...(status !== undefined ? [String(status)] : []),
		`${Math.round(Number(a["autter.operation.duration_ms"] ?? 0))}ms`,
		...(a["autter.request.id"] ? [paint("dim", `req=${a["autter.request.id"]}`)] : []),
	].join(" ");
	const lines = [head];
	const row = (label: string, text: string) =>
		lines.push(`  ${paint("cyan", label.padEnd(8))} ${text}`);
	if (outcome !== "succeeded" && event.message && !event.message.endsWith(`: ${outcome}`))
		row("message", event.message);
	const context = flatPairs(a);
	if (context) row("context", context);
	const steps = a["autter.operation.steps"];
	if (Array.isArray(steps) && steps.length)
		row(
			"steps",
			steps
				.map((step) => {
					const s = step as { name?: string; status?: string; durationMs?: number };
					const mark = s.status === "failed" ? paint("red", "✗") : paint("green", "✓");
					return `${s.name} ${mark} ${s.durationMs}ms`;
				})
				.join(" · "),
		);
	const code = a["autter.error.code"];
	if (code || a["exception.type"])
		row(
			"error",
			[
				code ? paint("red", String(code)) : String(a["exception.type"]),
				a["autter.error.expected"] === true ? paint("dim", "(expected)") : "",
				a["autter.error.why"] ? `why: ${a["autter.error.why"]}` : "",
				a["autter.error.fix"] ? `fix: ${a["autter.error.fix"]}` : "",
			]
				.filter(Boolean)
				.join(" "),
		);
	const ai = a["autter.operation.ai"] as
		| { calls?: number; input_tokens?: number; output_tokens?: number; cost_usd?: number; models?: string[] }
		| undefined;
	if (ai && typeof ai === "object")
		row(
			"ai",
			`${ai.calls} call(s) · ${ai.input_tokens} in / ${ai.output_tokens} out · $${ai.cost_usd} · ${(ai.models ?? []).join(", ")}`,
		);
	const logs = a["autter.operation.logs"];
	if (Array.isArray(logs))
		for (const entry of logs) {
			const log = entry as { t?: number; level?: string; message?: string; attrs?: Record<string, unknown> };
			const extra = log.attrs ? ` ${paint("dim", flatPairs(log.attrs))}` : "";
			row("log", `+${log.t}ms ${log.level} ${log.message}${extra}`);
		}
	if (a["autter.operation.logs_truncated"] === true) row("log", paint("dim", "… more messages truncated"));
	return lines.join("\n");
}

/**
 * Console output. JSON lines (identical to 1.4.0) in production; a compact
 * human-readable tree elsewhere, coloured only on a TTY.
 */
export function consoleSink(options: ConsoleSinkOptions = {}): RuntimeSink {
	const format =
		options.format ??
		(process.env.NODE_ENV === "production" ? "json" : "pretty");
	const color =
		options.color ??
		(process.stdout?.isTTY === true && !process.env.NO_COLOR);
	const write = options.write ?? ((line: string) => console.log(line));
	return {
		name: "console",
		write(event) {
			write(
				format === "json"
					? JSON.stringify({
							...event.attributes,
							level: event.level,
							message: event.message,
						})
					: formatPretty(event, color),
			);
		},
	};
}

// ---------------------------------------------------------------------------
// Local NDJSON files
// ---------------------------------------------------------------------------

export interface FileSinkOptions {
	/** Directory for `YYYY-MM-DD.jsonl` files. Default ".autter/runtime" (cwd-relative). */
	dir?: string;
	/** Keep at most this many files (oldest deleted). Default 7. */
	maxFiles?: number;
	/** Start a new `YYYY-MM-DD.N.jsonl` file past this size. Default 10 MiB. */
	maxBytes?: number;
}

const FILE_NAME = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

/**
 * NDJSON on local disk, one record per line, for coding agents and
 * `autter logs --local`. Daily files (UTC), size rotation, bounded file
 * count. Writes are synchronous appends (dev-sized volumes). Disables itself
 * with one warning on read-only or permission-denied filesystems.
 */
export function fileSink(options: FileSinkOptions = {}): RuntimeSink {
	const dir = resolve(options.dir ?? ".autter/runtime");
	const maxFiles = Math.max(1, options.maxFiles ?? 7);
	const maxBytes = Math.max(1024, options.maxBytes ?? 10 * 1024 * 1024);
	let context: RuntimeSinkContext | null = null;
	let disabled = false;
	let day = "";
	let index = 0;
	let currentBytes = 0;

	const files = () =>
		readdirSync(dir)
			.map((name) => ({ name, match: FILE_NAME.exec(name) }))
			.filter((file) => file.match)
			.map((file) => ({
				name: file.name,
				day: file.match![1]!,
				index: Number(file.match![2] ?? 0),
			}))
			.sort((a, b) => (a.day === b.day ? a.index - b.index : a.day < b.day ? -1 : 1));
	const fileName = (d: string, i: number) => (i === 0 ? `${d}.jsonl` : `${d}.${i}.jsonl`);
	const prune = () => {
		const current = fileName(day, index);
		const existing = files().filter((file) => file.name !== current);
		// The current file counts toward the limit even before its first write.
		const excess = existing.length + 1 - maxFiles;
		for (const file of existing.slice(0, Math.max(0, excess)))
			unlinkSync(join(dir, file.name));
	};
	const open = (nextDay: string) => {
		mkdirSync(dir, { recursive: true });
		day = nextDay;
		const sameDay = files().filter((file) => file.day === day);
		index = sameDay.length ? sameDay[sameDay.length - 1]!.index : 0;
		try {
			currentBytes = statSync(join(dir, fileName(day, index))).size;
		} catch {
			currentBytes = 0;
		}
		prune();
	};
	const disable = (error: unknown) => {
		disabled = true;
		const code = (error as { code?: string })?.code ?? "error";
		console.warn(
			`[autter-runtime] local runtime files disabled (${code} writing ${dir}); set logging.file: false to silence`,
		);
	};

	return {
		name: "file",
		start(next) {
			context = next;
		},
		write(event) {
			if (disabled) return;
			try {
				const line = `${JSON.stringify({
					time: new Date(event.time).toISOString(),
					level: event.level,
					message: event.message,
					...(context
						? {
								service: context.service,
								environment: context.environment,
								...(context.release ? { release: context.release } : {}),
							}
						: {}),
					...(event.traceId ? { traceId: event.traceId, spanId: event.spanId } : {}),
					...event.attributes,
				})}\n`;
				const bytes = Buffer.byteLength(line);
				const today = new Date(event.time).toISOString().slice(0, 10);
				if (today !== day) open(today);
				if (currentBytes > 0 && currentBytes + bytes > maxBytes) {
					index++;
					currentBytes = 0;
					prune();
				}
				appendFileSync(join(dir, fileName(day, index)), line);
				currentBytes += bytes;
			} catch (error) {
				disable(error);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Memory (testing)
// ---------------------------------------------------------------------------

export interface MemorySink extends RuntimeSink {
	readonly events: RuntimeEvent[];
	readonly exceptions: CapturedException[];
	clear(): void;
}

/** Keeps every record in memory — for tests (`@autter/runtime-node/testing`). */
export function memorySink(): MemorySink {
	const events: RuntimeEvent[] = [];
	const exceptions: CapturedException[] = [];
	return {
		name: "memory",
		events,
		exceptions,
		write(event) {
			events.push(event);
		},
		exception(record) {
			exceptions.push(record);
		},
		clear() {
			events.length = 0;
			exceptions.length = 0;
		},
	};
}
