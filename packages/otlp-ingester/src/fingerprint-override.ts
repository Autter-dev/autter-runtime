import { createHash } from "node:crypto";
import { scrubText } from "./redact.js";
import type { RuntimeOccurrenceInput } from "./types.js";

/**
 * SDK fingerprint override (EI-16) → the `manual-v1` issue identity.
 *
 * Where it comes from:
 * - browser events: `fingerprint` (a string or an array of strings), from
 *   `captureException(err, { fingerprint })` or `beforeSend`;
 * - OTLP exception events (or their span) and promoted error logs:
 *   `autter.fingerprint`, a string or a JSON array of strings (the SDKs always
 *   send the JSON array, so a single value never reads as a list by accident).
 *
 * The normalisers carry it as `RuntimeOccurrenceInput.fingerprintOverride`:
 * strings only, empty values dropped, at most 10 values, each scrubbed like
 * the rest of the occurrence and then cut to 200 characters. A malformed
 * override is dropped on its own; it never rejects the signal.
 *
 * `manualFingerprint` hashes it. `manual-v1` takes precedence over every
 * other scheme (rule-v1, code-v1, frames-v3, message-v1) and is only ever
 * computed here, never on the platform:
 *
 *   sha256("manual-v1" \0 service \0 values.join("\u0001")).hex()[:32]
 */

export const MANUAL_FINGERPRINT_SCHEME = "manual-v1";
export const FINGERPRINT_ATTRIBUTE = "autter.fingerprint";
export const MAX_FINGERPRINT_VALUES = 10;
export const MAX_FINGERPRINT_VALUE_LENGTH = 200;

/** Strings only, empty dropped, first 10, each cut to 200 chars; null when none remain. */
function boundValues(list: readonly unknown[], scrub: (text: string) => string): string[] | null {
	const values = list
		.filter((value): value is string => typeof value === "string" && value !== "")
		.slice(0, MAX_FINGERPRINT_VALUES)
		// Cut with slack, scrub, then cut: a secret straddling the limit is
		// masked whole.
		.map((value) => scrub(value.slice(0, MAX_FINGERPRINT_VALUE_LENGTH + 512)).slice(0, MAX_FINGERPRINT_VALUE_LENGTH))
		.filter((value) => value !== "");
	return values.length > 0 ? values : null;
}

/**
 * The override values carried on the wire, cleaned: `value` is a string, a
 * JSON array string, or an already-decoded array. Undefined when absent or
 * unusable.
 */
export function parseFingerprintOverride(value: unknown): string[] | undefined {
	let list: unknown = value;
	if (typeof value === "string" && /^\s*\[/.test(value)) {
		try {
			list = JSON.parse(value);
		} catch {
			/* not JSON: one plain value */
		}
	}
	return boundValues(Array.isArray(list) ? list : [list], scrubText) ?? undefined;
}

/** `{ fingerprintOverride }` to spread into an occurrence, or `{}`. */
export function fingerprintOverrideOf(value: unknown): { fingerprintOverride?: string[] } {
	const values = parseFingerprintOverride(value);
	return values ? { fingerprintOverride: values } : {};
}

/**
 * The `manual-v1` fingerprint (32 lowercase hex) of an occurrence's override,
 * or null when it has none. The values are bounded again here (at most 10,
 * each ≤ 200 chars), so the hash never depends on how the input was built.
 */
export function manualFingerprint(
	input: Pick<RuntimeOccurrenceInput, "service" | "fingerprintOverride">,
): string | null {
	if (!Array.isArray(input.fingerprintOverride)) return null;
	const values = boundValues(input.fingerprintOverride, (text) => text);
	if (!values) return null;
	return createHash("sha256")
		.update(`${MANUAL_FINGERPRINT_SCHEME}\u0000${input.service}\u0000${values.join("\u0001")}`)
		.digest("hex")
		.slice(0, 32);
}
