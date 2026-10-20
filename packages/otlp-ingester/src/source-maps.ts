import { createHash } from "node:crypto";
import { scrubText } from "./redact.js";

/** Largest stored map (after `sourcesContent` is removed), in characters. */
export const SOURCE_MAP_MAX_CHARS = 5 * 1024 * 1024;

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
	/** The map JSON without `sourcesContent`. */
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
	// Source contents are unnecessary for position lookup and may contain secrets.
	const { sourcesContent: _omitted, ...safe } = parsed;
	const map = JSON.stringify(safe);
	if (map.length > SOURCE_MAP_MAX_CHARS) return null;
	return { release: input.release, filename, map, debugId, contentHash: sourceMapContentHash(map) };
}

/** One entry of a `/v1/sourcemaps/check` request. */
export interface SourceMapCheckEntry {
	filename: string;
	debugId: string;
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
 * `{ release, files: [{ filename, debugId?, hash }] }` (≤ 500 files). The
 * filenames and debug ids are normalised exactly as an upload would store
 * them. Null when invalid.
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
		if (typeof file.filename !== "string" || typeof file.hash !== "string" || !/^[0-9a-f]{64}$/.test(file.hash)) return null;
		const filename = sourceMapPath(file.filename);
		if (!filename) return null;
		const debugId = file.debugId === undefined || file.debugId === null || file.debugId === "" ? "" : normalizeDebugId(file.debugId);
		if (debugId === null) return null;
		entries.push({ filename, debugId, hash: file.hash });
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
