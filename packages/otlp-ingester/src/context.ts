import { isSensitiveKey, scrubText } from "./redact.js";

/** Bounded, defensive privacy boundary for custom telemetry from any OTLP SDK. */
export function sanitizeRuntimeContext(
	input: unknown,
): Record<string, unknown> {
	let budget = 512;
	const seen = new WeakSet<object>();
	// Shared secret/PII patterns (redact.ts), then drop URL query strings
	// and fragments outright — whitelist-style privacy for free text.
	const scrub = (value: string) =>
		scrubText(value).replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1");
	const visit = (value: unknown, key: string, depth: number): unknown => {
		if (--budget < 0 || depth > 6) return "[truncated]";
		if (/__proto__|constructor|prototype/i.test(key)) return undefined;
		const usage =
			/(?:^|\.)(?:input|output|total|prompt|completion)_?tokens$/i.test(key) &&
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
			return scrub(text.slice(0, limit + 512)).slice(0, limit);
		}
		if (typeof value === "number")
			return Number.isFinite(value) ? value : undefined;
		if (typeof value === "boolean" || value === null) return value;
		if (!value || typeof value !== "object") return undefined;
		if (seen.has(value)) return "[circular]";
		seen.add(value);
		if (Array.isArray(value))
			return value.slice(0, 64).map((v) => visit(v, key, depth + 1));
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value).slice(0, 128)) {
			const safe = visit(v, k, depth + 1);
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
		if (!v || depth > 6) return undefined;
		if (v.stringValue !== undefined) return v.stringValue;
		if (v.intValue !== undefined) return Number(v.intValue);
		if (v.doubleValue !== undefined) return v.doubleValue;
		if (v.boolValue !== undefined) return v.boolValue;
		if (v.arrayValue)
			return (v.arrayValue.values ?? [])
				.slice(0, 64)
				.map((value) => decode(value, depth + 1));
		if (v.kvlistValue)
			return Object.fromEntries(
				(v.kvlistValue.values ?? [])
					.slice(0, 128)
					.filter(
						(a) =>
							a.key && !/^(?:__proto__|constructor|prototype)$/.test(a.key),
					)
					.map((a) => [a.key!, decode(a.value, depth + 1)]),
			);
		return undefined;
	};
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
					(a) => a.key && !/^(?:__proto__|constructor|prototype)$/.test(a.key),
				)
				.map((a) => [a.key!, decode(a.value)]),
		),
	);
}
