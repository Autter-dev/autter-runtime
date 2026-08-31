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
