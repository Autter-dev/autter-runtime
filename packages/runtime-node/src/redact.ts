import type { Attributes } from "@opentelemetry/api";

/**
 * Server-side secret/PII redaction. Applied to everything the Node SDK
 * exports: custom attributes, exception messages and stack traces, span
 * status messages, span/event attributes set by instrumentations (HTTP URLs
 * with query strings, third-party instrumentations), and structured logs.
 *
 * Two mechanisms:
 * - KEY patterns: an attribute whose NAME looks sensitive (password, token,
 *   cookie, authorization, api_key, session, ssn, …) is masked wholesale,
 *   at any nesting depth.
 * - VALUE patterns: secrets embedded inside any string (JWTs, bearer/basic
 *   credentials, Cookie/Authorization header text, `scheme://user:pass@`
 *   connection strings, vendor API keys, PEM private keys, `password=` /
 *   `?token=` assignments, emails, Luhn-valid card numbers) are replaced in
 *   place so the rest of the string — the useful part of an error message
 *   or stack frame — survives.
 *
 * The same pattern set is mirrored (and kept in parity by the shared
 * test-vectors/redaction.json) in @autter/runtime-browser, the ingester, and
 * adapters/python/redact.py.
 */

type AttrValue =
	| string
	| number
	| boolean
	| Array<string | number | boolean>
	| object;

export interface RedactOptions {
	/**
	 * Extra patterns matched against lower-cased attribute KEYS; a match
	 * masks the whole value. Strings become case-insensitive substring
	 * patterns. Extends the built-in list.
	 */
	additionalKeyPatterns?: (RegExp | string)[];
	/**
	 * Extra patterns scrubbed inside string VALUES — attribute values,
	 * exception messages, stack traces, span status messages, URLs, log
	 * lines. Strings are compiled as case-insensitive regex sources. Every
	 * pattern is applied globally. Extends the built-in list.
	 */
	additionalValuePatterns?: (RegExp | string)[];
	/** Replacement token. Default "[redacted]". */
	mask?: string;
	/**
	 * Scrub email-shaped substrings from ALL string values, not just
	 * sensitive keys. Default true.
	 */
	scrubEmailValues?: boolean;
	/**
	 * Scrub Luhn-valid payment card numbers from all string values.
	 * Default true.
	 */
	scrubCardNumbers?: boolean;
}

// Tested against the lower-cased KEY. Deliberately anchored where a loose
// substring would over-redact ("card" must not eat "discard",
// "author" must not eat "author_id", "session_id" is an attribution id).
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
	/e-?mail/,
	/pass(word|wd|phrase)|^pass$|(^|[._-])pwd$/,
	/token/,
	/secret/,
	/credential/,
	/(api|access|secret|private|consumer|client|signing|encryption)-?[_.]?key/,
	/authori[sz]ation|^auth(-|_|$)|bearer/,
	/cookie/,
	/(^|[._-])session$|^(j|php)?sess(ion)?id$|^sid$|connect\.sid/,
	/phone|msisdn/,
	/(^|[^a-z])ssn($|[^a-z])|social[-_ ]?security/,
	/cvv|cvc|card([-_. ]?(number|num|no))?$/,
	/credit[-_.]?card/,
	/connection[-_.]?string|(^|[._-])dsn$/,
	/recovery[-_.]?code|\botp\b|magic[-_.]?link/,
];

// ---------------------------------------------------------------------------
// VALUE patterns — scrubbed INSIDE strings. Order matters: whole-token
// shapes first, then header/assignment context, then URLs, cards, emails.
// Every pattern is idempotent on its own mask ("[redacted]" never matches).
// ---------------------------------------------------------------------------

const PRIVATE_KEY_BLOCK_RE =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** Vendor credentials recognisable by prefix alone. */
const PREFIXED_SECRET_RE =
	/\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}|npm_[A-Za-z0-9]{36}|autter_(?:rt|pat)_[A-Za-z0-9_-]{10,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
/** `Bearer <token>` and `Basic <base64>` (the latter must look encoded, so
 * the phrase "basic authentication" survives). */
const AUTH_SCHEME_RE =
	/\b(?:bearer\s+[A-Za-z0-9._~+/=-]{10,}|basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2})/gi;
/** `Authorization: …`, `Cookie: …`, `Set-Cookie: …` (raw header text, JSON,
 * util.inspect): the whole value goes, since cookies and auth schemes
 * contain spaces and semicolons. */
const HEADER_VALUE_RE =
	/((?:^|[^\w-])(?:proxy-)?(?:authorization|(?:set-)?cookie)["']?\s*[:=]\s*["']?)[^"'\r\n]+/gim;
/** `password=…`, `"token":"…"`, `?api_key=…&` — a secret-named key followed
 * by `=` or `:`. Value ends at a delimiter so the surrounding query string
 * or JSON stays readable. */
const SECRET_ASSIGNMENT_RE =
	/(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|signature|session[_-]?id|sessionid|ssn)(["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'&,;)}\]\[<>]+)/gi;
/** `scheme://user:pass@host` (user may be empty, pass may contain `@`) and
 * long token-as-username URLs (`https://<token>@host`). Host is kept. */
const URL_CREDENTIALS_RE =
	/\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/:@"'<>]*:[^\s/"'<>]*|[^\s/:@"'<>]{16,})@/gi;
const CARD_RE =
	/\b(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))(?:[ -]?\d){9,15}\b/g;
const EMAIL_VALUE_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi;

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

interface CompiledRedactor {
	keyPatterns: RegExp[];
	extraValuePatterns: RegExp[];
	mask: string;
	scrubEmailValues: boolean;
	scrubCardNumbers: boolean;
}

function toCaseInsensitive(pattern: RegExp | string): RegExp {
	return typeof pattern === "string"
		? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
		: new RegExp(pattern.source, pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`);
}

/** Value patterns must be global, or String#replace masks only the first hit. */
function toGlobal(pattern: RegExp | string): RegExp {
	if (typeof pattern === "string") return new RegExp(pattern, "gi");
	return pattern.global
		? pattern
		: new RegExp(pattern.source, `${pattern.flags}g`);
}

function compile(options?: RedactOptions): CompiledRedactor {
	const keyPatterns = [...SENSITIVE_KEY_PATTERNS];
	const extraValuePatterns: RegExp[] = [];
	for (const p of options?.additionalKeyPatterns ?? []) {
		keyPatterns.push(toCaseInsensitive(p));
	}
	for (const p of options?.additionalValuePatterns ?? []) {
		const re = toGlobal(p);
		if (!extraValuePatterns.some((existing) => existing.source === re.source)) {
			extraValuePatterns.push(re);
		}
	}
	return {
		keyPatterns,
		extraValuePatterns,
		mask: options?.mask ?? "[redacted]",
		scrubEmailValues: options?.scrubEmailValues !== false,
		scrubCardNumbers: options?.scrubCardNumbers !== false,
	};
}

/** Hard cap on how much of one string is scanned: stacks are capped well
 * below this upstream; anything longer is truncated rather than exported
 * unscanned. */
const MAX_SCRUB_CHARS = 64 * 1024;

function redactString(value: string, r: CompiledRedactor): string {
	const mask = r.mask;
	let out = value.length > MAX_SCRUB_CHARS ? value.slice(0, MAX_SCRUB_CHARS) : value;
	out = out
		.replace(PRIVATE_KEY_BLOCK_RE, mask)
		.replace(PREFIXED_SECRET_RE, mask)
		.replace(JWT_RE, mask)
		.replace(AUTH_SCHEME_RE, mask)
		.replace(HEADER_VALUE_RE, (_m, head: string) => head + mask)
		.replace(SECRET_ASSIGNMENT_RE, (_m, key: string, sep: string, val: string) =>
			key + sep + (val[0] === '"' || val[0] === "'" ? val[0] + mask + val[0] : mask),
		)
		.replace(URL_CREDENTIALS_RE, (_m, scheme: string) => `${scheme}${mask}@`);
	if (r.scrubCardNumbers) {
		out = out.replace(CARD_RE, (m) => (luhnValid(m) ? mask : m));
	}
	if (r.scrubEmailValues) {
		out = out.replace(EMAIL_VALUE_RE, mask);
	}
	for (const re of r.extraValuePatterns) {
		re.lastIndex = 0;
		out = out.replace(re, mask);
	}
	return out;
}

const MAX_REDACTION_DEPTH = 64;
const MAX_REDACTION_WORK = 10_000;
const MAX_COLLECTION_ENTRIES = 1_000;

interface RedactionState {
        ancestors: WeakMap<object, object>;
        remainingWork: number;
}

function canTraverse(depth: number, state: RedactionState): boolean {
        if (depth > MAX_REDACTION_DEPTH || state.remainingWork <= 0) return false;
        state.remainingWork -= 1;
        return true;
}

function redactValue(
        value: unknown,
        r: CompiledRedactor,
        state: RedactionState,
        depth: number,
): unknown {
        if (typeof value === "string") return redactString(value, r);

        let isArray = false;
        try {
                isArray = Array.isArray(value);
        } catch {
                return r.mask;
        }

        if (isArray) {
                return redactArray(value as unknown[], r, state, depth);
        }

        if (typeof value === "object" && value !== null) {
                return redactObject(value, r, state, depth);
        }

        return value;
}

function redactArray(
        value: unknown[],
        r: CompiledRedactor,
        state: RedactionState,
        depth: number,
): unknown {
        const existing = state.ancestors.get(value);
        if (existing) return r.mask;

        if (!canTraverse(depth, state)) return r.mask;

        const out: unknown[] = [];
        state.ancestors.set(value, out);

        let length: number;
        try {
                length = value.length;
        } catch {
                state.ancestors.delete(value);
                return r.mask;
        }

        const limit = Math.min(length, MAX_COLLECTION_ENTRIES);

        for (let i = 0; i < limit; i += 1) {
                let item: unknown;

                try {
                        item = value[i];
                } catch {
                        out.push(r.mask);
                        continue;
                }

                out.push(redactValue(item, r, state, depth + 1));
        }

        if (length > limit) {
                out.push(r.mask);
        }

        state.ancestors.delete(value);
        return out;
}

function redactObject(
        value: object,
        r: CompiledRedactor,
        state: RedactionState,
        depth: number,
): unknown {
        const existing = state.ancestors.get(value);
        if (existing) return r.mask;

        if (!canTraverse(depth, state)) return r.mask;

        const out: Record<string, unknown> = {};
        state.ancestors.set(value, out);

        let count = 0;
        let truncated = false;

        try {
                for (const key in value as Record<string, unknown>) {
                        if (
                                !Object.prototype.propertyIsEnumerable.call(
                                        value,
                                        key,
                                )
                        ) {
                                continue;
                        }

                        if (count >= MAX_COLLECTION_ENTRIES) {
                                truncated = true;
                                break;
                        }

                        let nestedValue: unknown;
                        try {
                                nestedValue = (value as Record<string, unknown>)[key];
                        } catch {
                                out[key] = r.mask;
                                count += 1;
                                continue;
                        }

                        count += 1;
                        out[key] = isSensitiveKey(key, nestedValue, r)
                                ? r.mask
                                : redactValue(
                                          nestedValue,
                                          r,
                                          state,
                                          depth + 1,
                                  );
                }
        } catch {
                truncated = true;
        }

        if (truncated) {
                out.__redaction_truncated__ = r.mask;
        }

        state.ancestors.delete(value);
        return out;
}
const USAGE_TOKEN_KEYS = new Set([
        "input_tokens",
        "output_tokens",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "token_count",
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "gen_ai.usage.prompt_tokens",
        "gen_ai.usage.completion_tokens",
        "gen_ai.usage.total_tokens",
        "gen_ai.usage.token_count",
]);

function isSensitiveKey(
        key: string,
        value: unknown,
        r: CompiledRedactor,
): boolean {
        const lowered = key.toLowerCase();

        // Canonical GenAI usage attributes are safe when they contain
        // valid non-negative numeric counts.
        if (USAGE_TOKEN_KEYS.has(lowered)) {
                return !(
                        typeof value === "number" &&
                        Number.isFinite(value) &&
                        value >= 0
                );
        }

        // All other sensitive keys, including token-like keys, are redacted.
        return r.keyPatterns.some((re) => re.test(lowered));
}

/**
 * Return a copy of `attributes` with PII/secrets masked. Never mutates the
 * input; non-string primitives pass through untouched; `undefined` values
 * are dropped (OpenTelemetry rejects them).
 */
export function redactAttributes(
	attributes?: Attributes | null,
	options?: RedactOptions,
): Attributes {
	const r = compile(options);
	return redactWith(attributes, r);
}

function redactWith(
        attributes: Attributes | null | undefined,
        r: CompiledRedactor,
): Attributes {
        const out: Attributes = {};
        if (!attributes) return out;

        const state: RedactionState = {
                ancestors: new WeakMap<object, object>(),
                remainingWork: MAX_REDACTION_WORK,
        };

        let count = 0;
        let truncated = false;

        try {
                for (const key in attributes as Record<string, unknown>) {
                        if (
                                !Object.prototype.propertyIsEnumerable.call(
                                        attributes,
                                        key,
                                )
                        ) {
                                continue;
                        }

                        if (
                                count >= MAX_COLLECTION_ENTRIES ||
                                state.remainingWork <= 0
                        ) {
                                truncated = true;
                                break;
                        }

                        let value: unknown;
                        try {
                                value = (attributes as Record<string, unknown>)[key];
                        } catch {
                                out[key] = r.mask;
                                count += 1;
                                state.remainingWork -= 1;
                                continue;
                        }

                        count += 1;
                        state.remainingWork -= 1;

                        if (value === undefined) continue;

                        out[key] = isSensitiveKey(key, value, r)
                                ? r.mask
                                : (redactValue(value, r, state, 0) as Attributes[string]);
                }
        } catch {
                truncated = true;
        }

        if (truncated) {
                out.__redaction_truncated__ = r.mask;
        }

        return out;
}

/**
 * Scrub secrets/PII embedded in one string — an error message, a stack
 * trace, a URL, a log line. Same value patterns as redactAttributes().
 */
export function redactText(text: string, options?: RedactOptions): string {
	return typeof text === "string" ? redactString(text, compile(options)) : text;
}

/** A compiled redactor: callable for attribute bags, plus string and
 * export-time helpers. */
export interface Redactor {
	(attributes?: Attributes | null): Attributes;
	/** Scrub one string (messages, stacks, URLs). Identity when disabled. */
	text(value: string): string;
	/**
	 * Export-time pass over attributes already on a span (set by any
	 * instrumentation, not just Autter's capture calls). Strings are
	 * value-scrubbed, string values under sensitive KEYS are masked, and
	 * numbers/booleans pass untouched — usage counters such as
	 * `ai.usage.promptTokens` must survive for cost tracking.
	 */
	exported(attributes: Attributes): Attributes;
	readonly enabled: boolean;
}

/**
 * Compile a redactor once for a hot path — initAutterServer builds one from
 * its options and reuses it for every capture instead of recompiling.
 * `false` returns a pass-through (redaction disabled by the host).
 */
export function makeRedactor(options?: boolean | RedactOptions): Redactor {
	if (options === false) {
		const passthrough = ((attributes?: Attributes | null) => ({
			...(attributes ?? {}),
		})) as Redactor;
		passthrough.text = (value) => value;
		passthrough.exported = (attributes) => attributes;
		(passthrough as { enabled: boolean }).enabled = false;
		return passthrough;
	}
	const r = compile(options === true ? undefined : options);
	const redactor = ((attributes?: Attributes | null) =>
		redactWith(attributes, r)) as Redactor;
	redactor.text = (value) =>
		typeof value === "string" ? redactString(value, r) : value;
	redactor.exported = (attributes) => {
		const out: Attributes = {};
		for (const key of Object.keys(attributes)) {
			const value = attributes[key];
			if (typeof value === "string") {
				out[key] = r.keyPatterns.some((re) => re.test(key.toLowerCase()))
					? r.mask
					: redactString(value, r);
			} else if (Array.isArray(value)) {
				const sensitive = r.keyPatterns.some((re) => re.test(key.toLowerCase()));
				out[key] = (value as unknown[]).map((item) =>
					typeof item === "string"
						? sensitive
							? r.mask
							: redactString(item, r)
						: item,
				) as typeof value;
			} else {
				out[key] = value;
			}
		}
		return out;
	};
	(redactor as { enabled: boolean }).enabled = true;
	return redactor;
}
