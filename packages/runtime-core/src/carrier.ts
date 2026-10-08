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
