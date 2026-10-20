import type { Attributes } from "./attributes.js";
import { stripUrlQueries } from "./context.js";

/**
 * Breadcrumbs — the steps before an error (sink contract §1), shared by the
 * Node SDK (request-scoped trail, `autter.breadcrumbs` span attribute) and
 * the browser relay (re-validating what browsers send). Dependency-free.
 */

export type BreadcrumbType = "console" | "request" | "navigation" | "click" | "log" | "custom";
export type BreadcrumbLevel = "debug" | "info" | "warning" | "error";

export interface Breadcrumb {
	type: BreadcrumbType;
	/** ISO timestamp. */
	at: string;
	level?: BreadcrumbLevel;
	/** At most 500 characters, scrubbed. */
	message: string;
	/** At most 10 keys; strings at most 200 characters, scrubbed. */
	data?: Record<string, string | number | boolean | null>;
}

export interface BreadcrumbInput {
	/** Default "custom". */
	type?: BreadcrumbType;
	message: string;
	level?: BreadcrumbLevel;
	/** Primitive values only; at most 10 keys are kept. */
	data?: Record<string, unknown>;
	/** Default now. */
	at?: string | number | Date;
}

/** Attribute (span event / log record) carrying a JSON string of `Breadcrumb[]`. */
export const BREADCRUMBS_ATTRIBUTE = "autter.breadcrumbs";
export const MAX_BREADCRUMBS = 30;
const MAX_MESSAGE = 500;
const MAX_DATA_KEYS = 10;
const MAX_DATA_STRING = 200;
/** Default JSON budget of one `autter.breadcrumbs` value. */
export const BREADCRUMBS_ATTRIBUTE_MAX_CHARS = 16 * 1024;
const MASK = "[redacted]";

const TYPES = new Set<string>(["console", "request", "navigation", "click", "log", "custom"]);
const LEVELS: Record<string, BreadcrumbLevel> = {
	debug: "debug",
	trace: "debug",
	info: "info",
	log: "info",
	warning: "warning",
	warn: "warning",
	error: "error",
	fatal: "error",
};
const UNSAFE_KEY = /^(?:__proto__|constructor|prototype)$/;

/** An attribute-bag redactor: masks sensitive keys, scrubs string values. */
export type BreadcrumbRedactor = (attributes: Attributes) => Attributes;

function scrubber(redact: BreadcrumbRedactor): (value: string, max: number) => string {
	return (value, max) => {
		// Cut before scrubbing (bounded work) with slack, so a secret
		// straddling the cut is masked whole.
		const scrubbed = redact({ message: value.slice(0, max + 512) }).message;
		return stripUrlQueries(typeof scrubbed === "string" ? scrubbed : "").slice(0, max);
	};
}

function cleanData(
	raw: unknown,
	redact: BreadcrumbRedactor,
): Breadcrumb["data"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const picked: Record<string, string | number | boolean | null> = {};
	let count = 0;
	for (const key of Object.keys(raw).slice(0, 64)) {
		if (count >= MAX_DATA_KEYS) break;
		if (!key || UNSAFE_KEY.test(key)) continue;
		const value = (raw as Record<string, unknown>)[key];
		const name = key.slice(0, 100);
		if (typeof value === "string") {
			const text = /(?:url|path|route|target)$/i.test(name) ? value.split(/[?#]/)[0]! : value;
			picked[name] = text.slice(0, MAX_DATA_STRING + 512);
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) continue;
			picked[name] = value;
		} else if (typeof value === "boolean" || value === null) {
			picked[name] = value;
		} else {
			continue;
		}
		count++;
	}
	if (count === 0) return undefined;
	// Sensitive keys masked, secrets and PII in values scrubbed.
	const redacted = redact(picked as Attributes) as Record<string, unknown>;
	const out: Record<string, string | number | boolean | null> = {};
	for (const key of Object.keys(picked)) {
		const value = key in redacted ? redacted[key] : picked[key];
		out[key] =
			typeof value === "string"
				? stripUrlQueries(value).slice(0, MAX_DATA_STRING)
				: (value as number | boolean | null);
	}
	return out;
}

function timestamp(value: unknown): string | null {
	if (value === undefined) return new Date().toISOString();
	if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
	const at = new Date(value);
	return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * One breadcrumb from untrusted input: whitelisted fields, known type
 * (else "custom") and level (else none), scrubbed message (≤ 500) and data
 * (≤ 10 primitive keys, strings ≤ 200). `requireAt`: a missing timestamp
 * drops the breadcrumb instead of meaning "now". Null when unusable; never
 * throws.
 */
export function normalizeBreadcrumb(
	input: unknown,
	redact: BreadcrumbRedactor,
	options: { requireAt?: boolean } = {},
): Breadcrumb | null {
	try {
		if (!input || typeof input !== "object" || Array.isArray(input)) return null;
		const raw = input as Record<string, unknown>;
		if (options.requireAt && raw.at === undefined) return null;
		const at = timestamp(raw.at);
		if (!at) return null;
		const rawMessage = raw.message;
		const message =
			typeof rawMessage === "string"
				? rawMessage
				: typeof rawMessage === "number" || typeof rawMessage === "boolean"
					? String(rawMessage)
					: "";
		const data = cleanData(raw.data, redact);
		if (!message && !data) return null;
		const type = typeof raw.type === "string" && TYPES.has(raw.type) ? (raw.type as BreadcrumbType) : "custom";
		const level = typeof raw.level === "string" ? LEVELS[raw.level.toLowerCase()] : undefined;
		return {
			type,
			at,
			...(level ? { level } : {}),
			message: scrubber(redact)(message, MAX_MESSAGE),
			...(data ? { data } : {}),
		};
	} catch {
		// Throwing getter or revoked Proxy: drop this breadcrumb only.
		return null;
	}
}

/**
 * Untrusted breadcrumb list (the browser relay): the newest 30 valid
 * entries, oldest first, each re-validated and re-scrubbed. Undefined when
 * nothing valid remains; never throws.
 */
export function sanitizeBreadcrumbs(
	raw: unknown,
	redact: BreadcrumbRedactor,
): Breadcrumb[] | undefined {
	const out: Breadcrumb[] = [];
	try {
		if (!Array.isArray(raw)) return undefined;
		const first = Math.max(0, raw.length - 200);
		for (let i = raw.length - 1; i >= first && out.length < MAX_BREADCRUMBS; i--) {
			const crumb = normalizeBreadcrumb(raw[i], redact, { requireAt: true });
			if (crumb) out.push(crumb);
		}
	} catch {
		/* hostile array: keep what was read */
	}
	return out.length ? out.reverse() : undefined;
}

/** Ring buffer of the last `max` breadcrumbs. */
export class BreadcrumbTrail {
	private items: Breadcrumb[] = [];

	constructor(private readonly max = MAX_BREADCRUMBS) {}

	add(crumb: Breadcrumb): void {
		this.items.push(crumb);
		if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
	}

	/** Copies, oldest first. */
	list(): Breadcrumb[] {
		return this.items.map((crumb) => ({ ...crumb, ...(crumb.data ? { data: { ...crumb.data } } : {}) }));
	}

	get size(): number {
		return this.items.length;
	}

	clear(): void {
		this.items = [];
	}
}

/**
 * JSON for the `autter.breadcrumbs` attribute: the newest breadcrumbs that
 * fit `maxChars`, oldest first. Exporters scrub attribute strings again, and
 * a pattern that still matched the serialised text (say, across an escaped
 * quote) would corrupt the JSON there — so `scrub(json)` must be a fixed
 * point: a breadcrumb whose JSON is not keeps only its type, time and level.
 * Undefined when nothing fits.
 */
export function breadcrumbsAttribute(
	list: Breadcrumb[],
	scrub: (text: string) => string,
	maxChars = BREADCRUMBS_ATTRIBUTE_MAX_CHARS,
): string | undefined {
	const parts: string[] = [];
	let chars = 2;
	for (let i = list.length - 1; i >= 0 && parts.length < MAX_BREADCRUMBS; i--) {
		const crumb = list[i]!;
		let json = JSON.stringify(crumb);
		if (scrub(json) !== json) {
			json = JSON.stringify({ type: crumb.type, at: crumb.at, ...(crumb.level ? { level: crumb.level } : {}), message: MASK });
		}
		if (chars + json.length + 1 > maxChars) break;
		chars += json.length + 1;
		parts.push(json);
	}
	if (parts.length === 0) return undefined;
	const out = `[${parts.reverse().join(",")}]`;
	return scrub(out) === out ? out : undefined;
}
