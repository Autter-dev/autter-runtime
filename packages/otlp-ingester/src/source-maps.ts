import { createHash } from "node:crypto";
import { scrubText } from "./redact.js";
import { isInAppPath } from "./stack-frames.js";

/**
 * Largest stored map, in characters: 32 MiB, room for vendor chunks of
 * about 20 MB of minified code. Storage is a ZSTD-compressed String column,
 * so size only costs disk; a map this big is still symbolicated, without
 * being kept in the parse cache unless SOURCE_MAP_CACHE_MB allows it
 * (symbolicate.ts). Was 5 MiB up to 1.6.0. The map without
 * `sourcesContent` must fit it; the source contents kept (RF-05) fit in
 * what is left of it, counted in UTF-8 bytes (storedSourcesContent).
 */
export const SOURCE_MAP_MAX_CHARS = 32 * 1024 * 1024;

/** `/v1/sourcemaps` body limit, counted after a gzip or deflate body is
 * inflated: the largest map plus room for the rest of the request. */
export const SOURCE_MAP_MAX_BODY_BYTES = SOURCE_MAP_MAX_CHARS + 1024 * 1024;

/** Bundles a map can be uploaded for: `.js`, `.mjs` and `.cjs` (1.6.0+). */
const BUNDLE_PATH_RE = /\.[cm]?js$/;

/** A debug id: 8-4-4-4-12 lowercase hex. Written by `autter-runtime
 * sourcemaps inject`, and by Rollup, Turbopack, esbuild and Sentry tooling. */
export const DEBUG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lowercased debug id, or null when the value isn't one. */
export function normalizeDebugId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const id = value.trim().toLowerCase();
	return DEBUG_ID_RE.test(id) ? id : null;
}

/**
 * The stored form of a bundle's filename: path only, with no origin, query
 * or hash ("https://cdn.example.com/assets/app.js?v=2" → "/assets/app.js").
 * Uploads and lookups both go through it so they always agree.
 */
export function sourceMapPath(filename: string): string | null {
	if (filename.length > 1000) return null;
	try {
		return new URL(filename, "https://autter.invalid").pathname;
	} catch {
		return null;
	}
}

/** Migration 0016 columns — shared with the baseline DDL below. */
export const SOURCE_MAP_DEBUG_COLUMNS: string[] = [
	// The bundle's debug id ('' for maps uploaded without one).
	"debug_id String DEFAULT ''",
	// sha256 of the stored map, so CI can skip maps it already uploaded.
	"content_hash String DEFAULT ''",
];
export const SOURCE_MAP_DEBUG_ID_INDEX =
	"INDEX idx_sm_debug_id debug_id TYPE bloom_filter GRANULARITY 1";

export function sourceMapTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_source_maps (
		org_id String, repository_id String, release String, filename String,
		map String CODEC(ZSTD(3)), uploaded_at DateTime64(3, 'UTC') DEFAULT now64(3),
		${SOURCE_MAP_DEBUG_COLUMNS.join(", ")},
		${SOURCE_MAP_DEBUG_ID_INDEX}
	) ENGINE = ReplacingMergeTree(uploaded_at)
	ORDER BY (org_id, repository_id, release, filename)
	TTL toDateTime(uploaded_at) + INTERVAL 30 DAY`;
}

export interface ValidSourceMap {
	release: string;
	/** sourceMapPath() of the uploaded filename. */
	filename: string;
	/** The map JSON as stored: `sourcesContent` bounded by storedSourceMapJson. */
	map: string;
	/** Lowercase debug id, or "" when the upload has none. */
	debugId: string;
	/** sha256 hex of `map`. */
	contentHash: string;
}

const RELEASE_RE = /^[a-zA-Z0-9._-]{1,200}$/;

/** The content hash of a stored map — `autter-runtime sourcemaps upload`
 * computes the same value to skip maps the ingester already has. */
export function sourceMapContentHash(map: string): string {
	return createHash("sha256").update(map).digest("hex");
}

/** UTF-8 bytes `,"sourcesContent":[` and `]` add around the entries. */
const SOURCES_CONTENT_WRAPPER_BYTES = Buffer.byteLength(',"sourcesContent":[]');
/** UTF-8 bytes of a `null` entry. */
const NULL_ENTRY_BYTES = 4;

/**
 * The `sourcesContent` a stored map keeps (RF-05), or null to leave the
 * field out. Context lines for in-app frames come from it, so only in-app
 * sources keep theirs: a source the map's `ignoreList` /
 * `x_google_ignoreList` names, or whose path the in-app rule rejects
 * (`node_modules/`, `/.pnpm/`, `/vendor/`, … — isInAppPath), gets `null`,
 * like any entry that is not a string.
 *
 * The map must stay within the stored-map limit, so contents are kept
 * whole, smallest first (ties in source order), while the whole JSON fits
 * `limit` UTF-8 bytes given the `baseBytes` of the map without the field;
 * the rest become `null`. Nothing is ever cut inside a file, so kept line
 * numbers stay right. `@autter/runtime-cli` (upload.ts storedMapJson) does
 * exactly this, so it hashes the map the ingester stores and skips it on
 * the next run.
 */
export function storedSourcesContent(
	fields: Record<string, unknown>,
	baseBytes: number,
	limit: number = SOURCE_MAP_MAX_CHARS,
): Array<string | null> | null {
	const { sources, sourcesContent } = fields;
	if (!Array.isArray(sources) || !Array.isArray(sourcesContent) || sources.length === 0) return null;
	const ignored = new Set<number>();
	for (const list of [fields.ignoreList, fields.x_google_ignoreList]) {
		if (!Array.isArray(list)) continue;
		for (const index of list) if (Number.isInteger(index)) ignored.add(index as number);
	}
	const count = sources.length;
	const candidates: Array<{ index: number; content: string; bytes: number }> = [];
	for (let index = 0; index < count; index++) {
		const source: unknown = sources[index];
		const content: unknown = sourcesContent[index];
		if (typeof source !== "string" || typeof content !== "string") continue;
		if (ignored.has(index) || !isInAppPath(source)) continue;
		candidates.push({ index, content, bytes: Buffer.byteLength(JSON.stringify(content)) });
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => a.bytes - b.bytes || a.index - b.index);
	// Every entry starts as `null`, with a comma between entries.
	let remaining = limit - baseBytes - SOURCES_CONTENT_WRAPPER_BYTES - NULL_ENTRY_BYTES * count - (count - 1);
	const kept: Array<string | null> = new Array<string | null>(count).fill(null);
	let any = false;
	for (const candidate of candidates) {
		const extra = candidate.bytes - NULL_ENTRY_BYTES;
		if (extra > remaining) break;
		remaining -= extra;
		kept[candidate.index] = candidate.content;
		any = true;
	}
	return any ? kept : null;
}

/**
 * The stored JSON of a map: every field as sent except `sourcesContent`,
 * which goes last, bounded by storedSourcesContent (left out when nothing
 * is kept, so a map without in-app contents is stored byte-for-byte as it
 * was before contents were kept).
 */
export function storedSourceMapJson(fields: Record<string, unknown>, limit: number = SOURCE_MAP_MAX_CHARS): string {
	const { sourcesContent: _content, ...rest } = fields;
	const base = JSON.stringify(rest);
	const content = storedSourcesContent(fields, Buffer.byteLength(base), limit);
	return content ? JSON.stringify({ ...rest, sourcesContent: content }) : base;
}

/**
 * Validate one `/v1/sourcemaps` upload: `{ release, filename, map, debugId? }`.
 * `map` may be an object or a JSON string. The debug id comes from the body,
 * else from the map's own `debugId` (or legacy `debug_id`); an invalid one
 * rejects the upload. Null when the upload is invalid.
 */
export function validateSourceMap(body: unknown): ValidSourceMap | null {
	if (!body || typeof body !== "object") return null;
	const input = body as Record<string, unknown>;
	if (typeof input.release !== "string" || !RELEASE_RE.test(input.release)) return null;
	if (typeof input.filename !== "string") return null;
	const filename = sourceMapPath(input.filename);
	if (!filename || !BUNDLE_PATH_RE.test(filename)) return null;
	let parsed: Record<string, unknown>;
	try { parsed = typeof input.map === "string" ? JSON.parse(input.map) : input.map as Record<string, unknown>; }
	catch { return null; }
	if (!parsed || parsed.version !== 3 || typeof parsed.mappings !== "string" || !Array.isArray(parsed.sources)) return null;
	const rawDebugId = input.debugId ?? parsed.debugId ?? parsed.debug_id;
	const debugId = rawDebugId === undefined || rawDebugId === null || rawDebugId === "" ? "" : normalizeDebugId(rawDebugId);
	if (debugId === null) return null;
	// Everything is stored as sent, extension fields included: symbolication
	// reads `x_autter_scopes` (function scopes) from it, and the CLI hashes
	// exactly this JSON to skip maps already uploaded. `sourcesContent` is
	// kept for in-app sources (RF-05: context lines around in-app frames),
	// within the stored-map limit; the lines taken from it are scrubbed when
	// they are attached to an occurrence (symbolicate.ts).
	const { sourcesContent: _content, ...withoutContent } = parsed;
	if (JSON.stringify(withoutContent).length > SOURCE_MAP_MAX_CHARS) return null;
	const map = storedSourceMapJson(parsed);
	return { release: input.release, filename, map, debugId, contentHash: sourceMapContentHash(map) };
}

/** One entry of a `/v1/sourcemaps/check` request. */
export interface SourceMapCheckEntry {
	filename: string;
	debugId: string;
	/** sha256 of the stored map, or "" for a check by debug id alone (1.7.0+). */
	hash: string;
}

export interface SourceMapCheck {
	release: string;
	entries: SourceMapCheckEntry[];
}

/** Most entries one check request may name. */
export const SOURCE_MAP_CHECK_MAX = 500;

/**
 * Validate a `/v1/sourcemaps/check` request:
 * `{ release, files: [{ filename, debugId?, hash? }] }` (≤ 500 files). The
 * filenames and debug ids are normalised exactly as an upload would store
 * them. Each file needs a hash (is this exact map stored? — what `upload`
 * asks to skip maps) or, from 1.7.0, a debug id alone (is any map stored
 * for this bundle? — what `sourcemaps verify` asks after the maps were
 * deleted). Null when invalid.
 */
export function validateSourceMapCheck(body: unknown): SourceMapCheck | null {
	if (!body || typeof body !== "object") return null;
	const input = body as Record<string, unknown>;
	if (typeof input.release !== "string" || !RELEASE_RE.test(input.release)) return null;
	if (!Array.isArray(input.files) || input.files.length > SOURCE_MAP_CHECK_MAX) return null;
	const entries: SourceMapCheckEntry[] = [];
	for (const raw of input.files) {
		if (!raw || typeof raw !== "object") return null;
		const file = raw as Record<string, unknown>;
		if (typeof file.filename !== "string") return null;
		const hash = file.hash === undefined || file.hash === null || file.hash === "" ? "" : file.hash;
		if (typeof hash !== "string" || (hash !== "" && !/^[0-9a-f]{64}$/.test(hash))) return null;
		const filename = sourceMapPath(file.filename);
		if (!filename) return null;
		const debugId = file.debugId === undefined || file.debugId === null || file.debugId === "" ? "" : normalizeDebugId(file.debugId);
		if (debugId === null) return null;
		if (!hash && !debugId) return null;
		entries.push({ filename, debugId, hash });
	}
	return { release: input.release, entries };
}

/** Most scripts one browser event may name in `debugIds`. */
export const DEBUG_IDS_MAX = 50;

/**
 * The `debugIds` of a browser event (runtime-browser 1.6.0+, EI-13): script
 * URL → debug id. Keys lose their query and hash and are scrubbed, invalid ids
 * are dropped one by one, at most 50 are kept. `{ debugIds }` for the occurrence, or `{}`.
 */
export function browserDebugIds(raw: Record<string, unknown> | undefined): { debugIds?: Record<string, string> } {
	if (!raw) return {};
	const debugIds: Record<string, string> = {};
	let count = 0;
	for (const [url, value] of Object.entries(raw)) {
		const id = normalizeDebugId(value);
		// Scrubbed like the stack it was taken from, so keys still match its frames.
		const script = scrubText(url.split(/[?#]/)[0] ?? "");
		if (!id || !script) continue;
		debugIds[script] = id;
		if (++count >= DEBUG_IDS_MAX) break;
	}
	return count ? { debugIds } : {};
}

/**
 * The attribute server SDKs put the debug ids of the bundles in an
 * exception's stack under (`@autter/runtime-core` errorAttributes, RF-05):
 * a JSON object of script path, as it appears in the stack → debug id.
 */
export const DEBUG_IDS_ATTRIBUTE = "autter.debug_ids";

/**
 * `{ debugIds }` from a server exception's `autter.debug_ids` (a JSON
 * string, or the object the sanitiser made of it), validated exactly like a
 * browser event's (browserDebugIds); `{}` when absent or malformed. Only
 * locates source maps: like the browser's, never stored or forwarded.
 */
export function serverDebugIds(raw: unknown): { debugIds?: Record<string, string> } {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return {};
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return browserDebugIds(value as Record<string, unknown>);
}

/** `attributes` without `autter.debug_ids`, which locates maps and is not kept. */
export function withoutDebugIdsAttribute(attributes: Record<string, unknown>): Record<string, unknown> {
	if (!(DEBUG_IDS_ATTRIBUTE in attributes)) return attributes;
	const { [DEBUG_IDS_ATTRIBUTE]: _ids, ...rest } = attributes;
	return rest;
}
