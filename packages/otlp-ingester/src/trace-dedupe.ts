import { sanitizeRuntimeContext } from "./context.js";
import { normalizeMessage, normalizeStackFrames } from "./fingerprint.js";
import { scrubText } from "./redact.js";
import { parseStackFrames } from "./stack-frames.js";
import type { RuntimeOccurrenceInput, StackFrame } from "./types.js";

/**
 * One error can be recorded on several spans of a trace. In a Next.js app a
 * route handler's error is recorded by @autter/runtime-node on the request's
 * HTTP server span AND by Next's own "executing api route" / render span
 * (OpenTelemetry `recordException`); Express, Fastify, NestJS and gRPC
 * instrumentations do the same, and errored ancestor spans with no event
 * would add a stackless `HttpServerError` / `SpanError` on top. Each of
 * those used to become its own occurrence, so one thrown error was counted
 * two or three times. This pass, run on one export batch, keeps one
 * occurrence per thrown error.
 *
 * Rule 1, duplicate recordings. Two exception occurrences are recordings of
 * the same thrown error when ALL of these hold:
 *   - same trace, service, environment and release (a thrown error lives in
 *     one process);
 *   - on DIFFERENT spans, one an ancestor of the other through parent links
 *     present in the batch (an error propagating outward through nested
 *     spans). Two events on one span are two recordings made on purpose (a
 *     retry loop capturing each attempt on the request span) and are never
 *     merged; nor are errors on sibling spans (one span per attempt);
 *   - the same error type, or the OpenTelemetry JS `recordException`
 *     convention: a third-party recording (no `autter.*` on its event) of an
 *     error with a `code` reports the code as `exception.type` ("P2002",
 *     "ECONNREFUSED"), so its type may instead equal the other's declared
 *     `autter.error.code`, or its stack header may name the other's type;
 *   - the same message after scrubbing and `normalizeMessage`;
 *   - the same stack: the parsed in-app frames (function, file, line) are
 *     equal or one list is a prefix (truncated) or suffix (captured at record
 *     time, higher up) of the other. A side without a stack is no evidence
 *     against; without in-app frames all frames are compared;
 *   - recorded within DUPLICATE_WINDOW_MS of the group's latest recording.
 * Recordings are grouped greedily in time order: each joins the eligible
 * group (no member on its span, every member on its ancestor/descendant
 * chain and matching it) whose latest recording is the most recent, so when
 * every attempt of a retry loop is recorded on a child span and again on the
 * parent, each attempt pairs with its own parent recording.
 *
 * The group keeps the occurrence with the most information: the one the
 * Autter SDK recorded (`autter.*` on the event, or `autter.severity` on the
 * span), then the one carrying runtime-next's `onRequestError` context, then
 * the one on the span closest to the root. It keeps that occurrence's type,
 * message, severity, time and batch position (so its deterministic id), and
 * takes from the others what it lacks: attributes (its own win), stack,
 * route, method, status, request id, declared error fields, fingerprint
 * override and breadcrumbs. `autter.merged_recordings` counts the merged
 * recordings.
 *
 * Rule 2, redundant status-only occurrences. A status-only `HttpServerError`
 * / `SpanError` (an errored span without exception or failed-outcome events)
 * is dropped when the same trace and service in this batch has an exception
 * or failed outcome of severity error or fatal, not `autter.handled`, on an
 * ancestor or descendant of its span: the span failed because of that
 * error. It is kept when it is the trace's only signal, when the only
 * errors are warnings or handled ones, or when no ancestor/descendant link
 * is visible in the batch (sibling branches, a parent exported elsewhere).
 *
 * Scope: one export batch. A request's spans normally end, and are
 * exported, together; when the exporter's timer splits them across batches,
 * the recordings in different batches are still counted separately.
 */

/** Two recordings of one thrown error happen as it propagates outward:
 * milliseconds apart, seconds at most for an error handler that awaits. */
export const DUPLICATE_WINDOW_MS = 5_000;

export interface TraceSignal {
	occurrence: RuntimeOccurrenceInput;
	traceId: string;
	spanId: string;
	/** What produced it: an `exception` event, a failed `autter.outcome`
	 * event, or the span's error status alone. */
	signal: "exception" | "outcome" | "status";
	/** The Autter SDK recorded it: `autter.*` on the event, or
	 * `autter.severity` (captureException's marker) on the span. */
	autterCapture: boolean;
	/** `autter.*` attributes on the event itself. */
	eventAutter: boolean;
	/** runtime-next's `onRequestError` context on the span or event. */
	nextContext: boolean;
	/** `autter.handled` on the event: handled on purpose, not why a span failed. */
	handled: boolean;
}

export interface SpanLink {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
}

export interface DedupedSignals {
	/** The surviving occurrences, in batch order (merged where rule 1 applied). */
	occurrences: RuntimeOccurrenceInput[];
	/** Input index of each survivor: its position in the batch, which its
	 * deterministic occurrence id is derived from. */
	sourceIndexes: number[];
	/** Input indexes each survivor stands for (itself first). */
	members: number[][];
}

/** Keys runtime-next's `onRequestError` puts on the request span. Next's own
 * spans carry other `next.*` keys (`next.span_name`, `next.route`, …). */
const NEXT_CONTEXT_KEYS = [
	"next.route_path",
	"next.router_kind",
	"next.route_type",
	"next.render_source",
	"next.render_type",
	"next.revalidate_reason",
	"next.digest",
];

export function hasNextContext(...sources: Array<Map<string, string>>): boolean {
	return sources.some((attrs) => NEXT_CONTEXT_KEYS.some((key) => attrs.has(key)));
}

export function hasAutterKey(attrs: Map<string, string>): boolean {
	for (const key of attrs.keys()) if (key.startsWith("autter.")) return true;
	return false;
}

function spanKey(traceId: string, spanId: string): string {
	return `${traceId}\u0000${spanId}`;
}

function resourceKey(o: RuntimeOccurrenceInput): string {
	return [o.service, o.environment, o.release ?? ""].join("\u0000");
}

/** Ancestors of each span (nearest first) through the batch's parent links. */
class SpanTree {
	private readonly parents = new Map<string, string>();
	private readonly cache = new Map<string, string[]>();
	private readonly sets = new Map<string, Set<string>>();

	constructor(spans: SpanLink[]) {
		for (const span of spans) {
			if (!span.traceId || !span.spanId || !span.parentSpanId) continue;
			this.parents.set(spanKey(span.traceId, span.spanId), spanKey(span.traceId, span.parentSpanId));
		}
	}

	ancestors(key: string): string[] {
		const cached = this.cache.get(key);
		if (cached) return cached;
		const out: string[] = [];
		const seen = new Set<string>([key]);
		let parent = this.parents.get(key);
		while (parent && !seen.has(parent)) {
			seen.add(parent);
			out.push(parent);
			parent = this.parents.get(parent);
		}
		this.cache.set(key, out);
		return out;
	}

	ancestorSet(key: string): Set<string> {
		let set = this.sets.get(key);
		if (!set) {
			set = new Set(this.ancestors(key));
			this.sets.set(key, set);
		}
		return set;
	}

	depth(key: string): number {
		return this.ancestors(key).length;
	}

	/** One of the two spans is an ancestor of the other (not the same span). */
	related(a: string, b: string): boolean {
		return a !== b && (this.ancestorSet(a).has(b) || this.ancestorSet(b).has(a));
	}
}

interface Signature {
	message: string;
	/** Stack header name ("TypeError" in "TypeError: boom"), V8-style stacks. */
	header: string | null;
	/** null: no stack at all, which is no evidence against a match. */
	frames: { inApp: string[]; all: string[] } | null;
	/** Text-normalised frames, for stacks the parsers do not understand. */
	legacy: string[];
}

function frameKey(frame: StackFrame): string {
	const fn = (frame.function ?? "").replace(/^(?:async|new)\s+/, "");
	const file = (frame.filename ?? "").replace(/\\/g, "/").replace(/^file:\/\//, "");
	return [frame.module ?? "", fn, file, frame.lineno ?? ""].join("\u0000");
}

const HEADER_RE = /^([A-Za-z_$][\w$.]*)(?::|$)/;

function signatureOf(o: RuntimeOccurrenceInput): Signature {
	const message = normalizeMessage(scrubText(o.message));
	const stack = o.stack ? scrubText(o.stack) : "";
	if (!stack.trim()) return { message, header: null, frames: null, legacy: [] };
	const firstLine = stack.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
	const header = /^at\s/.test(firstLine) ? null : (HEADER_RE.exec(firstLine)?.[1] ?? null);
	let parsed: StackFrame[] = [];
	try {
		parsed = parseStackFrames(stack);
	} catch {
		parsed = [];
	}
	return {
		message,
		header,
		frames: {
			inApp: parsed.filter((frame) => frame.inApp).map(frameKey),
			all: parsed.map(frameKey),
		},
		legacy: parsed.length === 0 ? normalizeStackFrames(stack, 50) : [],
	};
}

/** Equal, or the shorter list is the start or the end of the longer one. */
function prefixOrSuffix(a: string[], b: string[]): boolean {
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	if (short.length === 0) return true;
	const offset = long.length - short.length;
	return (
		short.every((value, i) => value === long[i]) ||
		short.every((value, i) => value === long[offset + i])
	);
}

function stacksMatch(a: Signature, b: Signature): boolean {
	if (!a.frames || !b.frames) return true;
	if (a.frames.all.length === 0 || b.frames.all.length === 0) {
		// A stack the parsers do not understand: compare the text-normalised
		// frames the legacy fingerprint uses, when both sides have them.
		if (a.frames.all.length === 0 && b.frames.all.length === 0) {
			return prefixOrSuffix(a.legacy, b.legacy);
		}
		return a.legacy.length === 0 && b.legacy.length === 0;
	}
	if (a.frames.inApp.length > 0 && b.frames.inApp.length > 0) {
		return prefixOrSuffix(a.frames.inApp, b.frames.inApp);
	}
	return prefixOrSuffix(a.frames.all, b.frames.all);
}

/** OpenTelemetry JS `recordException` reports `String(error.code)` as
 * `exception.type` when the error has a code; Autter SDKs never do. */
function typeIsCodeOf(x: TraceSignal, xs: Signature, y: TraceSignal): boolean {
	if (x.eventAutter) return false;
	const type = x.occurrence.errorType;
	if (y.occurrence.errorCode && type === y.occurrence.errorCode) return true;
	return xs.header !== null && xs.header !== type && xs.header === y.occurrence.errorType;
}

function typesMatch(a: TraceSignal, as: Signature, b: TraceSignal, bs: Signature): boolean {
	return (
		a.occurrence.errorType === b.occurrence.errorType ||
		typeIsCodeOf(a, as, b) ||
		typeIsCodeOf(b, bs, a)
	);
}

function isExplaining(signal: TraceSignal): boolean {
	if (signal.signal === "status" || signal.handled) return false;
	const severity = signal.occurrence.severity;
	return severity === "error" || severity === "fatal";
}

/** Merge `others` into `kept`: kept's identity wins, the rest fills gaps. */
function mergeInto(
	kept: RuntimeOccurrenceInput,
	others: RuntimeOccurrenceInput[],
): RuntimeOccurrenceInput {
	const merged: RuntimeOccurrenceInput = { ...kept };
	const attributes: Record<string, unknown> = { ...(kept.attributes ?? {}) };
	for (const other of others) {
		for (const [key, value] of Object.entries(other.attributes ?? {})) {
			if (!(key in attributes)) attributes[key] = value;
		}
		if (!merged.stack && other.stack) merged.stack = other.stack;
		if (!merged.route && other.route) merged.route = other.route;
		if (!merged.method && other.method) merged.method = other.method;
		if ((merged.statusCode == null || merged.statusCode === 0) && other.statusCode) {
			merged.statusCode = other.statusCode;
		}
		if (merged.errorCode === undefined && other.errorCode !== undefined) merged.errorCode = other.errorCode;
		if (merged.why === undefined && other.why !== undefined) merged.why = other.why;
		if (merged.fix === undefined && other.fix !== undefined) merged.fix = other.fix;
		if (merged.link === undefined && other.link !== undefined) merged.link = other.link;
		if (merged.expected === undefined && other.expected !== undefined) merged.expected = other.expected;
		if (merged.requestId === undefined && other.requestId !== undefined) merged.requestId = other.requestId;
		if (merged.fingerprintOverride === undefined && other.fingerprintOverride !== undefined) {
			merged.fingerprintOverride = other.fingerprintOverride;
		}
		if (!merged.breadcrumbs?.length && other.breadcrumbs?.length) merged.breadcrumbs = other.breadcrumbs;
	}
	attributes["autter.merged_recordings"] = others.length + 1;
	// Same bounds as every other occurrence (128 keys, kept's own first).
	merged.attributes = sanitizeRuntimeContext(attributes);
	return merged;
}

interface Group {
	members: number[];
	spans: Set<string>;
	lastAt: number;
}

export function dedupeTraceSignals(signals: TraceSignal[], spans: SpanLink[]): DedupedSignals {
	const tree = new SpanTree(spans);
	const keyOf = (s: TraceSignal) => spanKey(s.traceId, s.spanId);
	const timeOf = (s: TraceSignal) => s.occurrence.occurredAt.getTime();
	const signatures = new Map<number, Signature>();
	const signature = (i: number) => {
		let sig = signatures.get(i);
		if (!sig) {
			sig = signatureOf(signals[i]!.occurrence);
			signatures.set(i, sig);
		}
		return sig;
	};

	// ── Rule 1: duplicate recordings of one thrown error ──────────────────
	const groupOf = new Map<number, Group>();
	const buckets = new Map<string, number[]>();
	signals.forEach((s, i) => {
		if (s.signal !== "exception" || !s.traceId || !s.spanId) return;
		const key = `${s.traceId}\u0000${resourceKey(s.occurrence)}`;
		const bucket = buckets.get(key);
		if (bucket) bucket.push(i);
		else buckets.set(key, [i]);
	});
	for (const bucket of buckets.values()) {
		if (bucket.length < 2) continue;
		// Time order; at the same instant the inner span first (it records
		// before the error reaches the outer one).
		const ordered = bucket.slice().sort((a, b) =>
			timeOf(signals[a]!) - timeOf(signals[b]!) ||
			tree.depth(keyOf(signals[b]!)) - tree.depth(keyOf(signals[a]!)) ||
			a - b,
		);
		let open: Group[] = [];
		for (const i of ordered) {
			const s = signals[i]!;
			const key = keyOf(s);
			const at = timeOf(s);
			open = open.filter((group) => at - group.lastAt <= DUPLICATE_WINDOW_MS);
			let best: Group | null = null;
			for (const group of open) {
				if (group.spans.has(key)) continue;
				if (best && group.lastAt <= best.lastAt) continue;
				const fits = group.members.every((m) => {
					const other = signals[m]!;
					return (
						tree.related(key, keyOf(other)) &&
						signature(i).message === signature(m).message &&
						typesMatch(s, signature(i), other, signature(m)) &&
						stacksMatch(signature(i), signature(m))
					);
				});
				if (fits) best = group;
			}
			if (best) {
				best.members.push(i);
				best.spans.add(key);
				best.lastAt = Math.max(best.lastAt, at);
				groupOf.set(i, best);
			} else {
				const group: Group = { members: [i], spans: new Set([key]), lastAt: at };
				open.push(group);
				groupOf.set(i, group);
			}
		}
	}

	// ── Rule 2: status-only occurrences an error on their chain explains ──
	// `explained`: spans with an explaining error on themselves or below.
	// `explaining`: spans that carry one.
	const explained = new Set<string>();
	const explaining = new Set<string>();
	signals.forEach((s) => {
		if (!s.traceId || !s.spanId || !isExplaining(s)) return;
		const scope = resourceKey(s.occurrence);
		const key = keyOf(s);
		explaining.add(`${scope}\u0000${key}`);
		explained.add(`${scope}\u0000${key}`);
		for (const ancestor of tree.ancestors(key)) explained.add(`${scope}\u0000${ancestor}`);
	});
	const redundant = (s: TraceSignal): boolean => {
		if (s.signal !== "status" || !s.traceId || !s.spanId) return false;
		const scope = resourceKey(s.occurrence);
		const key = keyOf(s);
		if (explained.has(`${scope}\u0000${key}`)) return true;
		return tree.ancestors(key).some((ancestor) => explaining.has(`${scope}\u0000${ancestor}`));
	};

	// ── Survivors, in batch order ─────────────────────────────────────────
	const keptOf = new Map<Group, number>();
	const rank = (i: number) => {
		const s = signals[i]!;
		return (s.autterCapture ? 2 : 0) + (s.nextContext ? 1 : 0);
	};
	for (const group of new Set(groupOf.values())) {
		if (group.members.length < 2) continue;
		const best = group.members.slice().sort((a, b) =>
			rank(b) - rank(a) ||
			tree.depth(keyOf(signals[a]!)) - tree.depth(keyOf(signals[b]!)) ||
			a - b,
		)[0]!;
		keptOf.set(group, best);
	}

	const out: DedupedSignals = { occurrences: [], sourceIndexes: [], members: [] };
	signals.forEach((s, i) => {
		if (redundant(s)) return;
		const group = groupOf.get(i);
		const kept = group ? keptOf.get(group) : undefined;
		if (group && kept !== undefined) {
			if (kept !== i) return;
			const others = group.members
				.filter((m) => m !== i)
				.sort((a, b) =>
					rank(b) - rank(a) ||
					tree.depth(keyOf(signals[a]!)) - tree.depth(keyOf(signals[b]!)) ||
					a - b,
				);
			out.occurrences.push(mergeInto(s.occurrence, others.map((m) => signals[m]!.occurrence)));
			out.members.push([i, ...others]);
		} else {
			out.occurrences.push(s.occurrence);
			out.members.push([i]);
		}
		out.sourceIndexes.push(i);
	});
	return out;
}
