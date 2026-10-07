import { isValidErrorCode } from "./errors.js";

/** Fingerprint scheme for coded errors (see fixtures/code-fingerprints.json). */
export const CODE_FINGERPRINT_SCHEME = "code-v1";

/**
 * `sha256("code-v1" \0 service \0 code).hex().slice(0, 32)` — source
 * independent, so the same code from SDK traces, promoted logs and external
 * providers lands in one issue. Mirrored by the ingester and the backend.
 * Returns null for an invalid code.
 */
export async function codeFingerprint(
	service: string,
	code: string,
): Promise<string | null> {
	if (!isValidErrorCode(code)) return null;
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
		?.subtle;
	if (!subtle) throw new Error("codeFingerprint requires WebCrypto");
	const data = new TextEncoder().encode(
		`${CODE_FINGERPRINT_SCHEME}\u0000${service}\u0000${code}`,
	);
	const digest = new Uint8Array(await subtle.digest("SHA-256", data));
	let hex = "";
	for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
	return hex.slice(0, 32);
}
