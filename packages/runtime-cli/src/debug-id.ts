import { createHash } from "node:crypto";

/** 8-4-4-4-12 hex: the debug id shape shared with Rollup, Turbopack, esbuild
 * and Sentry tooling, and what the ingester accepts. */
export const DEBUG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lowercased debug id, or null when the value isn't one. */
export function normalizeDebugId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const id = value.trim().toLowerCase();
	return DEBUG_ID_RE.test(id) ? id : null;
}

/**
 * The content-addressed debug id of a bundle: the first 16 bytes of
 * sha256(bytes), shaped as a version-4 UUID. The same bytes always get the
 * same id, so rebuilding identical output never produces a new one.
 */
export function debugIdFor(bytes: Uint8Array | string): string {
	const hash = createHash("sha256").update(bytes).digest();
	hash[6] = (hash[6]! & 0x0f) | 0x40;
	hash[8] = (hash[8]! & 0x3f) | 0x80;
	const hex = hash.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const DEBUG_ID_COMMENT_RE = /^\/\/# debugId=([0-9a-fA-F-]{36})[ \t]*\r?$/gm;

/** The id in the bundle's last `//# debugId=` comment, if any (ours, or one
 * a bundler wrote natively). */
export function readDebugIdComment(code: string): string | null {
	let found: string | null = null;
	for (const match of code.matchAll(DEBUG_ID_COMMENT_RE)) found = normalizeDebugId(match[1]) ?? found;
	return found;
}

/** Property the SDKs read: `globalThis._autterDebugIds[stack] = id` (the
 * browser SDK, and the Node and edge SDKs' `autter.debug_ids`, RF-05). */
export const DEBUG_ID_REGISTRY = "_autterDebugIds";

/**
 * One line of ES5 that records this bundle's id under the stack of an Error
 * created inside it — the stack's first frame names the script URL the
 * browser loaded, or the file Node or an edge runtime ran, which the SDK
 * maps back to the id. `g.Error` keeps working when the bundle shadows
 * `Error` at top level. Never throws. The same snippet goes into browser
 * and server bundles.
 */
export function debugIdSnippet(id: string): string {
	return (
		';!function(){try{var g="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof window?window:' +
		'"undefined"!=typeof self?self:{},s=(new g.Error).stack;' +
		`s&&((g.${DEBUG_ID_REGISTRY}=g.${DEBUG_ID_REGISTRY}||{})[s]="${id}")}catch(e){}}();`
	);
}

const SNIPPET_RE = /\(g\._autterDebugIds=g\._autterDebugIds\|\|\{\}\)\[s\]="[0-9a-f]{8}-/;

/** Whether the bundle already carries our registration snippet. (The
 * registry name alone is not enough: a bundle that includes the browser SDK
 * contains it too.) */
export function hasDebugIdSnippet(code: string): boolean {
	return SNIPPET_RE.test(code);
}
