import { isSensitiveKey, scrubText } from "./redact.js";
import { BREADCRUMBS_ATTRIBUTE } from "./breadcrumbs.js";

/**
 * Attribute values the bounds below cut or left out (a string past its
 * length cap, list items past 64, map keys past 128, nesting past 6, the
 * 512-value budget), counted since the process started. The normalisers are
 * synchronous, so the difference across one call is that call's own count:
 * see `countTruncations`. Privacy rewrites (redaction, query stripping) are
 * not truncation and are not counted.
 */
let truncatedValues = 0;

/** Run a synchronous normaliser and return what it cut along with its result. */
export function countTruncations<T>(normalise: () => T): { result: T; truncated: number } {
	const before = truncatedValues;
	const result = normalise();
	return { result, truncated: truncatedValues - before };
}

/** Bounded, defensive privacy boundary for custom telemetry from any OTLP SDK. */
export function sanitizeRuntimeContext(
	input: unknown,
): Record<string, unknown> {
	let budget = 512;
	const seen = new WeakSet<object>();
	// Shared secret/PII patterns (redact.ts), then drop URL query strings
	// and fragments outright — whitelist-style privacy for free text.
	const scrub = (value: string) =>
		scrubText(value)
			// Query strings: procedural (a `[^\s?#]+[?#]` regex is quadratic on
			// long runs of URLs without a query).
			.replace(/https?:\/\/[^\s]*/gi, (url) => {
				const rest = url.slice(url.indexOf("://") + 3);
				const cut = rest.search(/[?#]/);
				return cut <= 0 ? url : url.slice(0, url.length - rest.length + cut);
			});
	const visit = (value: unknown, key: string, depth: number): unknown => {
		if (--budget < 0 || depth > 6) {
			truncatedValues += 1;
			return "[truncated]";
		}
		if (/__proto__|constructor|prototype/i.test(key)) return undefined;
		const usage =
			// Numeric token COUNTS (incl. the AI rollup's cache_read_tokens) are
			// usage, not secrets.
			/(?:^|\.)(?:input|output|total|prompt|completion|cache_read|cache_creation)_?tokens$/i.test(key) &&
			typeof value === "number" &&
			Number.isFinite(value) &&
			value >= 0;
		if (!usage && key && isSensitiveKey(key)) return "[redacted]";
		if (typeof value === "string") {
			// Serialized custom context crosses the same privacy boundary as nested values.
			if (/^\s*[\[{]/.test(value)) {
				try {
					return visit(JSON.parse(value), key, depth + 1);
				} catch {
					/* plain text */
				}
			}
			const text = /(?:url|path|route|target)$/i.test(key)
				? value.split(/[?#]/)[0]!
				: value;
			// Cut before scrubbing so scrub work is bounded by the stored size;
			// the slack keeps a secret straddling the cut whole for the scrubber.
			const limit = /stack/i.test(key) ? 32000 : 2048;
			if (text.length > limit) truncatedValues += 1;
			return scrub(text.slice(0, limit + 512)).slice(0, limit);
		}
		if (typeof value === "number")
			return Number.isFinite(value) ? value : undefined;
		if (typeof value === "boolean" || value === null) return value;
		if (!value || typeof value !== "object") return undefined;
		if (seen.has(value)) return "[circular]";
		seen.add(value);
		if (Array.isArray(value)) {
			if (value.length > 64) truncatedValues += value.length - 64;
			return value.slice(0, 64).map((v) => visit(v, key, depth + 1));
		}
		const result: Record<string, unknown> = {};
		const entries = Object.entries(value);
		if (entries.length > 128) truncatedValues += entries.length - 128;
		for (const [k, v] of entries.slice(0, 128)) {
			const safe = visit(v, k, depth + 1);
			if (k.length > 200) truncatedValues += 1;
			if (safe !== undefined) result[k.slice(0, 200)] = safe;
		}
		return result;
	};
	const result = visit(input, "", 0);
	return result && typeof result === "object" && !Array.isArray(result)
		? (result as Record<string, unknown>)
		: {};
}

export interface OtlpValue {
	stringValue?: string;
	intValue?: string | number;
	doubleValue?: number;
	boolValue?: boolean;
	arrayValue?: { values?: OtlpValue[] };
	kvlistValue?: { values?: OtlpAttribute[] };
}
export interface OtlpAttribute {
	key?: string;
	value?: OtlpValue;
}

export function decodeOtlpAttributes(
	attributes: OtlpAttribute[] | undefined,
): Record<string, unknown> {
	const decode = (v: OtlpValue | undefined, depth = 0): unknown => {
		if (!v) return undefined;
		if (depth > 6) {
			truncatedValues += 1;
			return undefined;
		}
		if (v.stringValue !== undefined) return v.stringValue;
		if (v.intValue !== undefined) return Number(v.intValue);
		if (v.doubleValue !== undefined) return v.doubleValue;
		if (v.boolValue !== undefined) return v.boolValue;
		if (v.arrayValue) {
			const values = v.arrayValue.values ?? [];
			if (values.length > 64) truncatedValues += values.length - 64;
			return values.slice(0, 64).map((value) => decode(value, depth + 1));
		}
		if (v.kvlistValue) {
			const values = v.kvlistValue.values ?? [];
			if (values.length > 128) truncatedValues += values.length - 128;
			return Object.fromEntries(
				values
					.slice(0, 128)
					.filter(
						(a) =>
							a.key && !/^(?:__proto__|constructor|prototype)$/.test(a.key),
					)
					.map((a) => [a.key!, decode(a.value, depth + 1)]),
			);
		}
		return undefined;
	};
	if (Array.isArray(attributes) && attributes.length > 128) truncatedValues += attributes.length - 128;
	return sanitizeRuntimeContext(
		Object.fromEntries(
			(attributes ?? [])
				.slice()
				.sort(
					(a, b) =>
						Number(/^autter\.(?:operation|event)\./.test(b.key ?? "")) -
						Number(/^autter\.(?:operation|event)\./.test(a.key ?? "")),
				)
				.slice(0, 128)
				.filter(
					// Breadcrumbs are their own validated field (breadcrumbs.ts), never a plain attribute.
					(a) => a.key && a.key !== BREADCRUMBS_ATTRIBUTE && !/^(?:__proto__|constructor|prototype)$/.test(a.key),
				)
				.map((a) => [a.key!, decode(a.value)]),
		),
	);
}
