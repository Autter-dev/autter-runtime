import { sanitizeRuntimeContext } from "./context.js";
import { validErrorCode } from "./fingerprint.js";

/**
 * Declared error metadata on the wire (span/event attributes, log
 * attributes, browser context keys):
 *
 *   autter.error.code      string matching CODE_PATTERN (≤80) — grouping key
 *   autter.error.why       declared cause   (≤1000 chars)
 *   autter.error.fix       declared remedy  (≤1000 chars)
 *   autter.error.link      docs link        (http(s) only, ≤500 chars)
 *   autter.error.expected  boolean — expected business failure
 *   autter.request.id      request id joining the error to its summary
 *
 * Every field is optional and validated independently: a bad value is
 * dropped on its own and never rejects the signal. Values are lifted onto
 * dedicated occurrence fields (and columns) instead of living only in the
 * attributes JSON, because the generic context sanitiser rewrites URLs
 * (query AND fragment stripped) — the declared link keeps its #anchor here.
 */

export const REQUEST_ID_PATTERN = /^[\w.-]{8,128}$/;

export interface DeclaredErrorFields {
	errorCode?: string;
	why?: string;
	fix?: string;
	link?: string;
	expected?: boolean;
	requestId?: string;
}

type AttributeSource =
	| Map<string, string>
	| Record<string, unknown>
	| null
	| undefined;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function lookup(sources: AttributeSource[], key: string): unknown {
	for (const source of sources) {
		if (!source) continue;
		const value =
			source instanceof Map ? source.get(key) : (source as Record<string, unknown>)[key];
		if (value !== undefined && value !== null && value !== "") return value;
	}
	return undefined;
}

/** Free text through the same scrubber as custom context, then capped. */
function declaredText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = sanitizeRuntimeContext({ text: value.trim() }).text;
	return typeof text === "string" && text ? text.slice(0, max) : undefined;
}

/**
 * http(s) only; credentials and query string removed (a docs link never
 * needs them), fragment kept. Over-long links are dropped rather than
 * truncated — a cut URL is a broken link.
 */
export function declaredLink(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	url.username = "";
	url.password = "";
	url.search = "";
	const link = url.toString().replace(EMAIL_RE, "[redacted]");
	return link.length <= 500 ? link : undefined;
}

export function validRequestId(value: unknown): string | undefined {
	return typeof value === "string" && REQUEST_ID_PATTERN.test(value)
		? value
		: undefined;
}

/**
 * Lift the declared fields from one or more attribute sources; the first
 * source carrying a key wins (e.g. exception event before its span).
 * Returns only the fields that are present and valid.
 */
export function liftErrorFields(
	...sources: AttributeSource[]
): DeclaredErrorFields {
	const out: DeclaredErrorFields = {};
	const code = validErrorCode(lookup(sources, "autter.error.code"));
	if (code) out.errorCode = code;
	const why = declaredText(lookup(sources, "autter.error.why"), 1000);
	if (why) out.why = why;
	const fix = declaredText(lookup(sources, "autter.error.fix"), 1000);
	if (fix) out.fix = fix;
	const link = declaredLink(lookup(sources, "autter.error.link"));
	if (link) out.link = link;
	const expected = lookup(sources, "autter.error.expected");
	if (expected === true || expected === "true") out.expected = true;
	const requestId = validRequestId(lookup(sources, "autter.request.id"));
	if (requestId) out.requestId = requestId;
	return out;
}
