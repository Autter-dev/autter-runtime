import { isSensitiveKey, scrubText } from "./redact.js";

/**
 * Breadcrumbs — the steps before an error (sink contract §1).
 *
 * Browser events carry them as `breadcrumbs` (runtime-browser's opt-in
 * `/breadcrumbs` module); server SDKs put a JSON string of the same array on
 * the exception span event as `autter.breadcrumbs`. Either way they are
 * untrusted client input, so this is a whitelist gate: unknown fields are
 * dropped, every string is scrubbed, and the list is bounded before it is
 * stored (under `autter.breadcrumbs` in the occurrence's attributes JSON)
 * and forwarded to the sink.
 */

export type BreadcrumbType = "console" | "request" | "navigation" | "click" | "log" | "custom";
export type BreadcrumbLevel = "debug" | "info" | "warning" | "error";

export interface Breadcrumb {
	type: BreadcrumbType;
	/** ISO timestamp. */
	at: string;
	level?: BreadcrumbLevel;
	/** ≤ 500 chars, scrubbed. */
	message: string;
	/** ≤ 10 keys of primitives; strings ≤ 200 chars, scrubbed. */
	data?: Record<string, string | number | boolean | null>;
}

/** Span event / log attribute carrying a JSON string of `Breadcrumb[]`. */
export const BREADCRUMBS_ATTRIBUTE = "autter.breadcrumbs";
/** Key under which an occurrence's breadcrumbs are stored in its attributes JSON. */
export const BREADCRUMBS_STORAGE_KEY = "autter.breadcrumbs";

export const MAX_BREADCRUMBS = 30;
const MAX_MESSAGE = 500;
const MAX_DATA_KEYS = 10;
const MAX_DATA_STRING = 200;
/** Stored JSON per occurrence; the oldest breadcrumbs go first. */
const MAX_TOTAL_CHARS = 16 * 1024;
/** Raw JSON accepted from a span attribute before parsing. */
const MAX_RAW_CHARS = 256 * 1024;
/** Entries examined from the end of an oversized list. */
const MAX_SCANNED = 200;

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
	critical: "error",
};
const UNSAFE_KEY = /^(?:__proto__|constructor|prototype)$/;

/** Drop query strings and fragments from http(s) URLs (procedural: linear). */
function stripUrlQueries(value: string): string {
	return value.replace(/https?:\/\/[^\s]*/gi, (url) => {
		const rest = url.slice(url.indexOf("://") + 3);
		const cut = rest.search(/[?#]/);
		return cut <= 0 ? url : url.slice(0, url.length - rest.length + cut);
	});
}

function cleanText(value: string, max: number): string {
	// Cut before scrubbing (bounded work), with slack so a secret straddling
	// the cut is masked whole.
	return stripUrlQueries(scrubText(value.slice(0, max + 512))).slice(0, max);
}

function cleanData(raw: unknown): Breadcrumb["data"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, string | number | boolean | null> = {};
	let count = 0;
	for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
		if (count >= MAX_DATA_KEYS) break;
		const key = rawKey.slice(0, 100);
		if (!key || UNSAFE_KEY.test(key)) continue;
		if (isSensitiveKey(key)) {
			out[key] = "[redacted]";
		} else if (typeof value === "string") {
			const text = /(?:url|path|route|target)$/i.test(key) ? value.split(/[?#]/)[0]! : value;
			out[key] = cleanText(text, MAX_DATA_STRING);
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) continue;
			out[key] = value;
		} else if (typeof value === "boolean" || value === null) {
			out[key] = value;
		} else {
			continue;
		}
		count++;
	}
	return count > 0 ? out : undefined;
}

function cleanBreadcrumb(raw: unknown): Breadcrumb | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const input = raw as Record<string, unknown>;
	const at =
		typeof input.at === "string" || typeof input.at === "number" ? new Date(input.at) : null;
	if (!at || Number.isNaN(at.getTime())) return null;
	const message =
		typeof input.message === "string"
			? input.message
			: typeof input.message === "number" || typeof input.message === "boolean"
				? String(input.message)
				: "";
	const type = typeof input.type === "string" && TYPES.has(input.type) ? input.type : "custom";
	const level = typeof input.level === "string" ? LEVELS[input.level.toLowerCase()] : undefined;
	const data = cleanData(input.data);
	if (!message && !data) return null;
	return {
		type: type as BreadcrumbType,
		at: at.toISOString(),
		...(level ? { level } : {}),
		message: cleanText(message, MAX_MESSAGE),
		...(data ? { data } : {}),
	};
}

/**
 * Validate, bound and scrub breadcrumbs from any sender: an array, or a JSON
 * string of one (the span attribute). Keeps the newest 30 valid entries,
 * oldest first, within 16 KB of JSON; malformed entries are dropped one by
 * one. Undefined when nothing valid remains.
 */
export function parseBreadcrumbs(raw: unknown): Breadcrumb[] | undefined {
	let list = raw;
	if (typeof list === "string") {
		if (list.length > MAX_RAW_CHARS) return undefined;
		try {
			list = JSON.parse(list);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(list) || list.length === 0) return undefined;
	const out: Breadcrumb[] = [];
	let chars = 2;
	const first = Math.max(0, list.length - MAX_SCANNED);
	for (let i = list.length - 1; i >= first && out.length < MAX_BREADCRUMBS; i--) {
		const crumb = cleanBreadcrumb(list[i]);
		if (!crumb) continue;
		const size = JSON.stringify(crumb).length + 1;
		if (chars + size > MAX_TOTAL_CHARS) break;
		chars += size;
		out.push(crumb);
	}
	return out.length > 0 ? out.reverse() : undefined;
}

/** `{ breadcrumbs }` for an occurrence, or `{}` — spread into the input. */
export function breadcrumbsField(...candidates: unknown[]): { breadcrumbs?: Breadcrumb[] } {
	for (const candidate of candidates) {
		if (candidate === undefined || candidate === null) continue;
		const breadcrumbs = parseBreadcrumbs(candidate);
		if (breadcrumbs) return { breadcrumbs };
	}
	return {};
}

/** Attributes JSON to store: the occurrence's attributes plus its breadcrumbs. */
export function attributesWithBreadcrumbs(
	attributes: Record<string, unknown> | null,
	breadcrumbs: Breadcrumb[] | undefined,
): Record<string, unknown> {
	return breadcrumbs?.length
		? { ...(attributes ?? {}), [BREADCRUMBS_STORAGE_KEY]: breadcrumbs }
		: (attributes ?? {});
}
