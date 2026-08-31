import type { Attributes } from "@opentelemetry/api";

/**
 * Server-side attribute redaction. The browser relay whitelist-sanitises
 * everything a client posts (see relay.ts) — but custom attributes handed to
 * `captureException` / `captureMessage` left the process verbatim. This module
 * closes that gap: emails, tokens, API keys, and credentials embedded in
 * string values are masked, and attributes whose NAME looks sensitive are
 * masked wholesale, before anything is exported.
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
	 * Extra patterns scrubbed inside string VALUES (same semantics as the
	 * built-in email/token patterns). Extends the built-in list.
	 */
	additionalValuePatterns?: (RegExp | string)[];
	/** Replacement token. Default "[redacted]". */
	mask?: string;
	/**
	 * Scrub email-shaped substrings from ALL string values, not just
	 * sensitive keys. Default true.
	 */
	scrubEmailValues?: boolean;
}

// Tested against the lower-cased KEY. Deliberately anchored where a loose
// substring would over-redact ("card" must not eat "discard",
// "author" must not eat "author_id").
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
	/e-?mail/,
	/pass(word|wd|phrase)|^pass$/,
	/token/,
	/secret/,
	/credential/,
	/(api|access|secret|private|consumer|client|signing|encryption)-?[_.]?key/,
	/^-?x?-?authorization$|^auth(-|_|$)|bearer/,
	/cookie/,
	/phone|msisdn/,
	/\bssn\b|social[-_ ]?security/,
	/cvv|cvc|card([-_. ]?(number|num|no))?$/,
	/credit[-_.]?card/,
	/connection[-_.]?string/,
	/recovery[-_.]?code|\botp\b|magic[-_.]?link/,
];

// Scrubbed INSIDE string values (matched substrings are replaced, the rest
// of the value survives — useful context like a stack frame stays readable).
const PRIVATE_KEY_BLOCK_RE =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const EMAIL_VALUE_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{20,}\b/g;
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/gi;
// postgres://user:password@host — credentials gone, host kept.
const URL_CREDENTIALS_RE =
	/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

interface CompiledRedactor {
	keyPatterns: RegExp[];
	valuePatterns: RegExp[];
	urlCredentials: RegExp;
	privateKeyBlock: RegExp;
	mask: string;
	scrubEmailValues: boolean;
}

function toCaseInsensitive(pattern: RegExp | string): RegExp {
	return typeof pattern === "string"
		? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
		: new RegExp(pattern.source, pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`);
}

function compile(options?: RedactOptions): CompiledRedactor {
	const keyPatterns = [...SENSITIVE_KEY_PATTERNS];
	const valuePatterns: RegExp[] = [
		JWT_RE,
		OPENAI_KEY_RE,
		GITHUB_TOKEN_RE,
		AWS_KEY_RE,
		SLACK_TOKEN_RE,
		BEARER_RE,
	];
	if (options?.additionalKeyPatterns) {
		for (const p of options.additionalKeyPatterns) {
			keyPatterns.push(toCaseInsensitive(p));
		}
	}
	if (options?.additionalValuePatterns) {
		for (const p of options.additionalValuePatterns) {
			if (!valuePatterns.some((existing) => existing.source === (typeof p === "string" ? p : p.source))) {
				valuePatterns.push(typeof p === "string" ? new RegExp(p, "gi") : p);
			}
		}
	}
	return {
		keyPatterns,
		valuePatterns,
		urlCredentials: URL_CREDENTIALS_RE,
		privateKeyBlock: PRIVATE_KEY_BLOCK_RE,
		mask: options?.mask ?? "[redacted]",
		scrubEmailValues: options?.scrubEmailValues !== false,
	};
}

function redactString(value: string, r: CompiledRedactor): string {
	let out = value.replace(r.privateKeyBlock, r.mask);
	for (const re of r.valuePatterns) {
		out = out.replace(re, r.mask);
	}
	out = out.replace(r.urlCredentials, "$1" + r.mask + "@");
	if (r.scrubEmailValues) {
		out = out.replace(EMAIL_VALUE_RE, r.mask);
	}
	return out;
}

function redactValue(
	value: unknown,
	r: CompiledRedactor,
	ancestors: WeakMap<object, object>,
): unknown {
	if (typeof value === "string") return redactString(value, r);

	if (Array.isArray(value)) {
		const existing = ancestors.get(value);
		if (existing) return existing;

		const out: unknown[] = [];
		ancestors.set(value, out);

		for (const item of value) {
			out.push(redactValue(item, r, ancestors));
		}

		ancestors.delete(value);
		return out;
	}

	if (typeof value === "object" && value !== null) {
		const existing = ancestors.get(value);
		if (existing) return existing;

		const out: Record<string, unknown> = {};
		ancestors.set(value, out);

		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = isSensitiveKey(k, v, r)
				? r.mask
				: redactValue(v, r, ancestors);
		}

		ancestors.delete(value);
		return out;
	}

	return value;
}

const USAGE_TOKEN_KEYS = new Set([
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
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		out[key] = isSensitiveKey(key, value, r)
			? r.mask
			: (redactValue(value, r, new WeakMap<object, object>()) as Attributes[string]);
	}
	return out;
}

/**
 * Compile a redactor once for a hot path — initAutterServer builds one from
 * its options and reuses it for every capture instead of recompiling.
 */
export function makeRedactor(
	options?: boolean | RedactOptions,
): (attributes?: Attributes | null) => Attributes {
	if (options === false) {
		return (attributes) => ({ ...(attributes ?? {}) });
	}
	const r = compile(options === true ? undefined : options);
	return (attributes) => redactWith(attributes, r);
}
