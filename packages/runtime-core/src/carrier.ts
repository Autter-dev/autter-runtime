import { REQUEST_ID_PATTERN } from "./request.js";

/**
 * Serialisable link from a producer operation to work it hands off (a queue
 * job, another process): `{ v: 1, op, req?, traceparent? }`. Put it in the
 * job payload; the consumer passes it as `withRuntimeOperation(..., { from })`.
 */
export interface RuntimeCarrier {
	v: 1;
	/** Producer operation id (becomes the consumer's `autter.operation.parent_id`). */
	op: string;
	/** Request id the work belongs to. */
	req?: string;
	/** W3C traceparent of the producer span (consumer links to it). */
	traceparent?: string;
}

const OPERATION_ID = /^[\w.-]{1,128}$/;
const TRACEPARENT = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;

export function formatTraceparent(
	traceId: string,
	spanId: string,
	sampled: boolean,
): string | undefined {
	const value = `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
	return TRACEPARENT.test(value) && !/^0+$/.test(traceId) && !/^0+$/.test(spanId)
		? value
		: undefined;
}

export function parseTraceparent(
	value: unknown,
): { traceId: string; spanId: string; sampled: boolean } | null {
	if (typeof value !== "string") return null;
	const match = TRACEPARENT.exec(value.trim());
	if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
	return {
		traceId: match[1]!,
		spanId: match[2]!,
		sampled: (Number.parseInt(match[3]!, 16) & 1) === 1,
	};
}

export function createCarrier(input: {
	op: string;
	req?: string;
	traceparent?: string;
}): RuntimeCarrier {
	return {
		v: 1,
		op: input.op,
		...(input.req ? { req: input.req } : {}),
		...(input.traceparent ? { traceparent: input.traceparent } : {}),
	};
}

/**
 * Validate a carrier from an untrusted payload (object or JSON string).
 * Returns null for anything malformed; invalid optional fields are dropped.
 */
export function parseCarrier(input: unknown): RuntimeCarrier | null {
	let value = input;
	if (typeof value === "string") {
		if (value.length > 1024) return null;
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (raw.v !== 1 || typeof raw.op !== "string" || !OPERATION_ID.test(raw.op))
		return null;
	return createCarrier({
		op: raw.op,
		...(typeof raw.req === "string" && REQUEST_ID_PATTERN.test(raw.req)
			? { req: raw.req }
			: {}),
		...(parseTraceparent(raw.traceparent)
			? { traceparent: String(raw.traceparent).trim() }
			: {}),
	});
}

/** Key (and header / SQS message attribute name) a carrier travels under. */
export const CARRIER_KEY = "autter";

/**
 * Where `injectCarrier` puts the carrier:
 * - `"payload"` (default): a plain job payload object, as `{ ...payload, autter: carrier }`;
 * - `"headers"`: an HTTP header map, as the header `autter: <carrier JSON>`
 *   (a `Headers` instance is always treated as headers);
 * - `"sqs"`: AWS SQS `MessageAttributes`, as
 *   `{ autter: { DataType: "String", StringValue: <carrier JSON> } }`.
 */
export type CarrierFormat = "payload" | "headers" | "sqs";

// Case-insensitive lookups read at most this many keys of a source object.
const MAX_SCANNED_KEYS = 256;

const hasOwn = (value: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(value, key);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isHeaders(value: unknown): value is Headers {
	return typeof Headers !== "undefined" && value instanceof Headers;
}

/**
 * Return a copy of `target` that carries `carrier` (see `CarrierFormat`).
 * Never mutates `target`: plain objects come back as shallow copies and a
 * `Headers` instance as a new `Headers`. Only the carrier's own fields are
 * written (`{ v: 1, op, req?, traceparent? }`), never attributes or user
 * context. When there is nothing to inject (no valid carrier) or the target
 * cannot hold it (not a plain object or `Headers`), `target` is returned
 * unchanged. Never throws.
 */
export function injectCarrier<T>(
	target: T,
	carrier: RuntimeCarrier | null | undefined,
	format: CarrierFormat = "payload",
): T {
	try {
		const valid = carrier ? parseCarrier(carrier) : null;
		if (!valid) return target;
		const json = JSON.stringify(valid);
		if (isHeaders(target)) {
			const copy = new Headers(target);
			copy.set(CARRIER_KEY, json);
			return copy as T;
		}
		if (!isPlainObject(target)) return target;
		if (format === "headers") {
			const copy: Record<string, unknown> = {};
			for (const key of Object.keys(target))
				if (key.toLowerCase() !== CARRIER_KEY) copy[key] = target[key];
			copy[CARRIER_KEY] = json;
			return copy as T;
		}
		if (format === "sqs")
			return {
				...target,
				[CARRIER_KEY]: { DataType: "String", StringValue: json },
			} as T;
		return { ...target, [CARRIER_KEY]: valid } as T;
	} catch {
		return target;
	}
}

/** A carrier value found under the key: JSON string, header list, SQS attribute or object. */
function carrierFromValue(value: unknown): RuntimeCarrier | null {
	if (typeof value === "string") return parseCarrier(value);
	if (Array.isArray(value))
		return value.length === 1 && typeof value[0] === "string"
			? parseCarrier(value[0])
			: null;
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	// SQS MessageAttributes (SDK: StringValue/DataType; Lambda events: stringValue/dataType).
	const stringValue = raw.StringValue ?? raw.stringValue;
	if (stringValue !== undefined) {
		const dataType = raw.DataType ?? raw.dataType;
		return typeof stringValue === "string" &&
			(dataType === undefined || (typeof dataType === "string" && dataType.startsWith("String")))
			? parseCarrier(stringValue)
			: null;
	}
	return parseCarrier(raw);
}

function valueUnderKey(source: Record<string, unknown>): unknown {
	if (hasOwn(source, CARRIER_KEY)) return source[CARRIER_KEY];
	// Header maps: names are case-insensitive.
	let scanned = 0;
	for (const key in source) {
		if (++scanned > MAX_SCANNED_KEYS) break;
		if (hasOwn(source, key) && key.toLowerCase() === CARRIER_KEY) return source[key];
	}
	return undefined;
}

function extractFrom(source: unknown, depth: number): RuntimeCarrier | null {
	if (typeof source === "string") return parseCarrier(source);
	if (isHeaders(source)) return carrierFromValue(source.get(CARRIER_KEY));
	if (!source || typeof source !== "object" || Array.isArray(source)) return null;
	const raw = source as Record<string, unknown>;
	const value = valueUnderKey(raw);
	if (value !== undefined) return carrierFromValue(value);
	// The carrier itself.
	if (hasOwn(raw, "v") && hasOwn(raw, "op")) return parseCarrier(raw);
	// A whole SQS message (SDK `MessageAttributes`, Lambda `messageAttributes`).
	if (depth === 0) {
		const attributes = raw.MessageAttributes ?? raw.messageAttributes;
		if (attributes && typeof attributes === "object") return extractFrom(attributes, 1);
	}
	return null;
}

/**
 * Read a carrier from what a consumer received: the carrier itself (object
 * or JSON string), a job payload with an `autter` key, HTTP headers (a
 * `Headers` instance or a header map; the name is case-insensitive), SQS
 * `MessageAttributes`, or a whole SQS message. Validated like `parseCarrier`
 * (same size and format limits; invalid optional fields are dropped).
 * Returns undefined for anything missing, malformed or oversized. Never throws.
 */
export function extractCarrier(source: unknown): RuntimeCarrier | undefined {
	try {
		return extractFrom(source, 0) ?? undefined;
	} catch {
		return undefined;
	}
}
