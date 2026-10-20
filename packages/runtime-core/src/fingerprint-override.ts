/**
 * Fingerprint override (`captureException(err, { fingerprint })`): errors
 * that carry the same values group into one issue, whatever their message
 * or stack. The ingester (≥1.6.0) hashes the values into the `manual-v1`
 * fingerprint, which wins over every automatic scheme; older ingesters
 * ignore the attribute.
 *
 * On the wire it is the exception event attribute `autter.fingerprint`
 * (span event, or log attribute in log-capture mode): always a JSON array
 * of strings, so a single value that happens to look like JSON is never
 * read as a list.
 */

export const FINGERPRINT_ATTRIBUTE = "autter.fingerprint";
/** At most this many values; later ones are dropped. */
export const FINGERPRINT_MAX_VALUES = 10;
/** Each value is cut to this many characters (after scrubbing). */
export const FINGERPRINT_MAX_LENGTH = 200;

export type FingerprintInput = string | readonly string[];

/**
 * The override values: strings only, empty ones dropped, at most 10, each
 * scrubbed and then cut to 200 characters. Undefined when nothing is left.
 */
export function fingerprintValues(
	value: unknown,
	scrub: (text: string) => string = (text) => text,
): string[] | undefined {
	const list = Array.isArray(value) ? value : [value];
	const values = list
		.filter((item): item is string => typeof item === "string" && item !== "")
		.slice(0, FINGERPRINT_MAX_VALUES)
		// Cut with slack, scrub, then cut: a secret straddling the limit is
		// masked whole instead of half-exported.
		.map((item) => scrub(item.slice(0, FINGERPRINT_MAX_LENGTH + 512)).slice(0, FINGERPRINT_MAX_LENGTH))
		.filter((item) => item !== "");
	return values.length > 0 ? values : undefined;
}

/** `{ "autter.fingerprint": "[…]" }` for an exception event, or `{}` when there is no override. */
export function fingerprintEventAttributes(
	value: unknown,
	scrub?: (text: string) => string,
): { [FINGERPRINT_ATTRIBUTE]?: string } {
	const values = fingerprintValues(value, scrub);
	return values ? { [FINGERPRINT_ATTRIBUTE]: JSON.stringify(values) } : {};
}

/**
 * Take `fingerprint` out of a capture's attributes. It decides grouping and
 * is never a span or log attribute of its own; everything else is returned
 * untouched.
 */
export function splitFingerprint<T extends object>(
	attributes: T | null | undefined,
): { attributes: T | undefined; fingerprint: unknown } {
	if (!attributes || typeof attributes !== "object" || !("fingerprint" in attributes)) {
		return { attributes: attributes ?? undefined, fingerprint: undefined };
	}
	const { fingerprint, ...rest } = attributes as Record<string, unknown>;
	return { attributes: rest as T, fingerprint };
}
