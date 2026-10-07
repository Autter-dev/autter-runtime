import type { Attributes } from "./attributes.js";
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
export type RuntimeOperationKind = "request" | "operation";

/** OTLP severity numbers for the four runtime levels. */
export const LEVEL_SEVERITY: Record<RuntimeLogLevel, number> = {
	debug: 5,
	info: 9,
	warning: 13,
	error: 17,
};

/** Higher of two levels (by severity). */
export function maxLevel(
	a: RuntimeLogLevel,
	b: RuntimeLogLevel,
): RuntimeLogLevel {
	return LEVEL_SEVERITY[b] > LEVEL_SEVERITY[a] ? b : a;
}

export type Redactor = (attributes: Attributes) => Attributes;

/** Attribute families the SDK owns; user context can never set them. */
const RESERVED_KEY =
	/^autter\.(?:operation|event|request|error)\.|^autter\.(?:parent_trace_id|capture\.mode)$/;

/** Depth-0 ordering: SDK-owned keys first, exception/error next, user keys,
 * then the inline log timeline last so it can never starve user context of
 * the shared node/character budget. Stable for keys 1.4.0 already emitted. */
function priority(key: string): number {
	if (key === "autter.operation.logs") return -1;
	if (/^autter\.(?:operation|event|request)\.|^autter\.parent_trace_id$/.test(key))
		return 2;
	if (/^(?:exception|autter\.error)\./.test(key)) return 1;
	return 0;
}

/**
 * Redact, then bound a context tree: 512 nodes, depth 6, 16 KB of string
 * characters, 64 array items, 100 keys per object, 200-character keys, URL
 * query strings stripped. Sets `autter.context.truncated` when anything was
 * cut. Byte-compatible with runtime-node 1.4.0's `safe()`.
 */
export function boundContext(
	attributes: RuntimeLogContext = {},
	redact?: Redactor,
): RuntimeLogContext {
	const redacted = redact
		? redact(attributes as Attributes)
		: redactAttributes(attributes as Attributes);
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
			if (depth === 0) entries.sort(([a], [b]) => priority(b) - priority(a));
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

/** Bounded user context with SDK-owned keys removed (anti-spoofing). */
export function userContext(
	attributes: RuntimeLogContext = {},
	redact?: Redactor,
): RuntimeLogContext {
	return Object.fromEntries(
		Object.entries(boundContext(attributes, redact)).filter(
			([key]) => !RESERVED_KEY.test(key),
		),
	);
}

/** Deep-merge `next` into `current` (objects merge to depth 6, everything
 * else is replaced), then re-bound. */
export function mergeContext(
	current: RuntimeLogContext,
	next: RuntimeLogContext = {},
	redact?: Redactor,
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
	return userContext(merge(current, userContext(next, redact), 0), redact);
}

/** Flatten a context for span attributes: nested values become JSON strings,
 * null/undefined are dropped. */
export function toSpanAttributes(context: RuntimeLogContext): Attributes {
	return Object.fromEntries(
		Object.entries(context)
			.filter(([, item]) => item !== null && item !== undefined)
			.map(([key, item]) => [
				key,
				typeof item === "object" ? JSON.stringify(item) : item,
			]),
	) as Attributes;
}
