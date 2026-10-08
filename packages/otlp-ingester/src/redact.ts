/**
 * Server-side secret/PII scrubbing — the ingester's second line of defence.
 *
 * The SDKs scrub before anything leaves the customer's process, but the
 * ingester also accepts older SDK versions and arbitrary third-party OTLP
 * senders (any OTel SDK in any language) that scrub nothing. Everything this
 * module touches is written to ClickHouse and forwarded to the sink webhook,
 * which is where error context is later read for LLM-generated fixes — so
 * scrubbing here, before storage, covers every downstream consumer.
 *
 * Same patterns as redactText() in @autter/runtime-node; parity is enforced
 * by the shared test-vectors/redaction.json.
 */

import type { RuntimeOccurrenceInput } from "./types.js";

const MASK = "[redacted]";

const PRIVATE_KEY_BLOCK_RE =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const PREFIXED_SECRET_RE =
	/\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}|npm_[A-Za-z0-9]{36}|autter_(?:rt|pat)_[A-Za-z0-9_-]{10,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g;
// Lookbehind, not \b: a \b start at every "eyJ" after a "-" made this
// quadratic ("eyJ-" x 16k took 3.4 s per string).
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const AUTH_SCHEME_RE =
	/\b(?:bearer\s+[A-Za-z0-9._~+/=-]{10,}|basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2})/gi;
const HEADER_VALUE_RE =
	/((?:^|[^\w-])(?:proxy-)?(?:authorization|(?:set-)?cookie)["']?\s*[:=]\s*["']?)[^"'\r\n]+/gim;
const SECRET_ASSIGNMENT_RE =
	/(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|signature|session[_-]?id|sessionid|ssn)(["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'&,;)}\]\[<>]+)/gi;
const URL_CREDENTIALS_RE =
	/\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/:@"'<>]*:[^\s/"'<>]*|[^\s/:@"'<>]{16,})@/gi;
const CARD_RE =
	/\b(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))(?:[ -]?\d){9,15}\b/g;
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi;

/** Keys whose values are masked wholesale (tested case-insensitively). */
export const SENSITIVE_KEY_RE =
	/password|passwd|passphrase|(^|[._-])pwd$|secret|token|credential|authori[sz]ation|^auth(-|_|$)|bearer|cookie|e-?mail|phone|(^|[^a-z])ssn($|[^a-z])|cvv|card[._-]?number|connection[._-]?string|(^|[._-])dsn$|(api|access|private|client|signing|encryption)[._-]?key|apikey|(^|[._-])session$|^(j|php)?sess(ion)?id$|^sid$|connect\.sid|request[._-]?body|response[._-]?body|headers|url[._-]?query/i;

let extraValuePatterns: RegExp[] = [];
let extraKeyPatterns: RegExp[] = [];

/**
 * Deployment-specific patterns on top of the built-ins (env
 * AUTTER_REDACT_VALUE_PATTERNS / AUTTER_REDACT_KEY_PATTERNS, JSON arrays of
 * regex sources). Server-side scrubbing has no off switch: it is the
 * backstop for senders that don't scrub.
 */
export function configureRedaction(options: {
	redactValuePatterns?: string[];
	redactKeyPatterns?: string[];
}): void {
	extraValuePatterns = (options.redactValuePatterns ?? []).map(
		(source) => new RegExp(source, "gi"),
	);
	extraKeyPatterns = (options.redactKeyPatterns ?? []).map(
		(source) => new RegExp(source, "i"),
	);
}

export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_RE.test(key) || extraKeyPatterns.some((re) => re.test(key));
}

function luhnValid(candidate: string): boolean {
	const digits = candidate.replace(/\D/g, "");
	if (digits.length < 13 || digits.length > 19) return false;
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = digits.charCodeAt(digits.length - 1 - i) - 48;
		if (i % 2 === 1) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return sum % 10 === 0;
}

/** Scrub secrets/PII embedded in one string; the rest of it survives. */
/** Longest string scanned (same cap as the Node SDK). Callers that store
 * less cut first; anything longer is truncated rather than stored unscanned. */
const MAX_SCRUB_CHARS = 64 * 1024;

export function scrubText(value: string): string {
	if (typeof value !== "string" || value === "") return value;
	let out = (value.length > MAX_SCRUB_CHARS ? value.slice(0, MAX_SCRUB_CHARS) : value)
		.replace(PRIVATE_KEY_BLOCK_RE, MASK)
		.replace(PREFIXED_SECRET_RE, MASK)
		.replace(JWT_RE, MASK)
		.replace(AUTH_SCHEME_RE, MASK)
		.replace(HEADER_VALUE_RE, (_m, head: string) => head + MASK)
		.replace(SECRET_ASSIGNMENT_RE, (_m, key: string, sep: string, val: string) =>
			key + sep + (val[0] === '"' || val[0] === "'" ? val[0] + MASK + val[0] : MASK),
		)
		.replace(URL_CREDENTIALS_RE, (_m, scheme: string) => `${scheme}${MASK}@`)
		.replace(CARD_RE, (m) => (luhnValid(m) ? MASK : m))
		.replace(EMAIL_RE, MASK);
	for (const re of extraValuePatterns) {
		re.lastIndex = 0;
		out = out.replace(re, MASK);
	}
	return out;
}

/** Nullable convenience for optional columns. */
export function scrubOptional(value: string | null): string | null {
	return value === null ? null : scrubText(value);
}

/** Scrub the free-text fields of an occurrence (message, stack, route,
 * error type). Returns a copy. */
export function scrubOccurrence(
	occurrence: RuntimeOccurrenceInput,
): RuntimeOccurrenceInput {
	return {
		...occurrence,
		errorType: scrubText(occurrence.errorType),
		message: scrubText(occurrence.message),
		stack: scrubOptional(occurrence.stack),
		route: scrubOptional(occurrence.route),
	};
}
