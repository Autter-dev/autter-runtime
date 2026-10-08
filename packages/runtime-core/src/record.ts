import {
	LEVEL_SEVERITY,
	boundContext,
	maxLevel,
	type Redactor,
	type RuntimeLogContext,
	type RuntimeLogLevel,
} from "./context.js";

/**
 * One runtime record before it is encoded for any sink: an operation or
 * request summary (`autter.event.type = "operation"`) or a plain log line.
 * `attributes` are already redacted and bounded.
 */
export interface RuntimeEvent {
	/** Epoch milliseconds. */
	time: number;
	level: RuntimeLogLevel;
	message: string;
	attributes: RuntimeLogContext;
	traceId?: string;
	spanId?: string;
}

/** One message folded into an operation summary (`autter.operation.logs`). */
export interface InlineLog {
	/** Milliseconds since the operation started. */
	t: number;
	level: RuntimeLogLevel;
	message: string;
	attrs?: RuntimeLogContext;
}

/** `autter.operation.ai` — LLM usage accumulated by one operation. */
export interface AiRollup {
	calls: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cost_usd: number;
	models: string[];
}

export interface AiUsageInput {
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	costUsd?: number;
}

export const INLINE_LOG_LIMIT = 50;
const INLINE_MESSAGE_MAX = 300;
const INLINE_CHARACTER_BUDGET = 6000;
const AI_MODEL_LIMIT = 10;

/** Mutable inline-log state carried by an operation. */
export interface InlineLogState {
	startedAt: number;
	logs: InlineLog[];
	logsTruncated: boolean;
	logCharacters: number;
	level: RuntimeLogLevel;
}

export function createInlineLogState(startedAt: number): InlineLogState {
	return {
		startedAt,
		logs: [],
		logsTruncated: false,
		logCharacters: 0,
		level: "info",
	};
}

/**
 * Fold a message into an operation's timeline: max 50 entries, 300-char
 * messages, small redacted attribute trees, ~6 KB in total. Overflow sets
 * `logsTruncated`; the operation level is raised either way.
 */
export function appendInlineLog(
	state: InlineLogState,
	level: RuntimeLogLevel,
	message: string,
	attrs: RuntimeLogContext | undefined,
	redact?: Redactor,
	now = Date.now(),
): void {
	state.level = maxLevel(state.level, level);
	if (state.logs.length >= INLINE_LOG_LIMIT) {
		state.logsTruncated = true;
		return;
	}
	const text = String(boundContext({ message }, redact).message ?? "").slice(
		0,
		INLINE_MESSAGE_MAX,
	);
	let small: RuntimeLogContext | undefined;
	if (attrs && Object.keys(attrs).length) {
		small = boundContext(attrs, redact);
		const encoded = JSON.stringify(small);
		if (encoded.length > 1000) small = { "autter.context.truncated": true };
	}
	const size = text.length + (small ? JSON.stringify(small).length : 0);
	if (state.logCharacters + size > INLINE_CHARACTER_BUDGET) {
		state.logsTruncated = true;
		return;
	}
	state.logCharacters += size;
	state.logs.push({
		t: Math.max(0, now - state.startedAt),
		level,
		message: text,
		...(small ? { attrs: small } : {}),
	});
}

/** Add one LLM call to a rollup (creating it on first use). */
export function addAiUsage(
	rollup: AiRollup | undefined,
	usage: AiUsageInput,
): AiRollup {
	const next = rollup ?? {
		calls: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cost_usd: 0,
		models: [],
	};
	const count = (value: number | undefined) =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? Math.round(value)
			: 0;
	next.calls += 1;
	next.input_tokens += count(usage.inputTokens);
	next.output_tokens += count(usage.outputTokens);
	next.cache_read_tokens += count(usage.cacheReadTokens);
	if (
		typeof usage.costUsd === "number" &&
		Number.isFinite(usage.costUsd) &&
		usage.costUsd > 0
	)
		next.cost_usd = Math.round((next.cost_usd + usage.costUsd) * 1e8) / 1e8;
	if (
		usage.model &&
		!next.models.includes(usage.model) &&
		next.models.length < AI_MODEL_LIMIT
	)
		next.models.push(String(usage.model).slice(0, 100));
	return next;
}

const TRACE_ID = /^[a-f0-9]{32}$/;
const SPAN_ID = /^[a-f0-9]{16}$/;

/** Assemble a RuntimeEvent; invalid or all-zero trace ids are omitted. */
export function createRuntimeEvent(input: {
	level: RuntimeLogLevel;
	message: string;
	attributes: RuntimeLogContext;
	time?: number;
	traceId?: string;
	spanId?: string;
}): RuntimeEvent {
	const valid =
		input.traceId !== undefined &&
		TRACE_ID.test(input.traceId) &&
		!/^0+$/.test(input.traceId);
	return {
		time: input.time ?? Date.now(),
		level: input.level,
		message: input.message,
		attributes: input.attributes,
		...(valid
			? {
					traceId: input.traceId,
					...(input.spanId && SPAN_ID.test(input.spanId)
						? { spanId: input.spanId }
						: { spanId: input.spanId ?? "" }),
				}
			: {}),
	};
}

/** True for operation/request summaries. */
export function isSummary(event: RuntimeEvent): boolean {
	return event.attributes["autter.event.type"] === "operation";
}

/** Severity number for a level (OTLP). */
export function severityOf(level: RuntimeLogLevel): number {
	return LEVEL_SEVERITY[level];
}
