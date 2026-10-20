// stub — EI-16 replaces this file
import type { RuntimeOccurrenceInput } from "./types.js";

/**
 * The SDK fingerprint override (`autter.fingerprint` / browser
 * `fingerprint`) as a `manual-v1` fingerprint, or null when the event
 * carries none. EI-16 implements it:
 * `sha256("manual-v1\0" + service + "\0" + values.join("\u0001")).slice(0, 32)`.
 * fingerprint.ts puts a non-null result first in the candidate list.
 */
export function manualFingerprint(_input: RuntimeOccurrenceInput): string | null {
	return null;
}
