import {
	isIgnored,
	sourceContentFor,
	TraceMap,
	type SourceMapInput,
} from "@jridgewell/trace-mapping";
import {
	DecodedMappings,
	decodedMappingsBytes,
	findInMappings,
	type GeneratedPosition,
	type MappedSegment,
} from "./source-map-mappings.js";
import { scrubText } from "./redact.js";
import { SCOPES_KEY, ScopeIndex, type ScopeName } from "./source-map-scopes.js";
import type { SourceMapKey } from "./source-maps-lookup.js";
import { isInAppPath, stripQueryAndHash } from "./stack-frames.js";
import type { StackFrame } from "./types.js";

/**
 * Symbolication at ingest: minified browser frames, and bundled Node and
 * edge frames (RF-05), are resolved through the source maps uploaded for
 * the release (`/v1/sourcemaps`) BEFORE they are fingerprinted, so
 * `frames-v3` hashes `checkout.tsx`, not `index-5f3a9c1e.js` — and an issue
 * survives deploys and preview domains.
 *
 * - Browser frames find their map by debug id, else by release + the
 *   script's path. Server frames (`server: true`) by debug id (server SDKs
 *   send `autter.debug_ids`), else by the release's map stored
 *   under the longest suffix of the path the process ran the bundle from
 *   (source-maps-lookup.ts): the upload knows `/server.js`, the stack says
 *   `/app/dist/server.js`. Only in-app server frames are looked up — a
 *   `node_modules/` or `node:` frame never belongs to an uploaded bundle.
 *
 * - Function names: when the map carries function scopes
 *   (`x_autter_scopes`, uploaded by @autter/runtime-cli after 1.0.0), a
 *   frame is named after the innermost function containing it, with that
 *   function's original name (null in an anonymous function or top-level
 *   code) — see source-map-scopes.ts. Maps without scopes keep the earlier
 *   rule: the name mapped at the CALLER's position is the callee's original
 *   name; without one, a resolved frame keeps its parsed name only when
 *   that is not an obviously mangled one (≤ 2 characters), since a mangled
 *   name changes on every build. That rule is wrong for calls through a
 *   variable (`const run = actions.captured; run()` names the frame `run`)
 *   and for handlers a framework calls, which is why scopes exist.
 * - Sources the map lists in `ignoreList` / `x_google_ignoreList` are not
 *   in-app; a resolved path under node_modules/ etc. is not in-app either.
 * - Context lines (RF-05): an in-app resolved frame gets its original line
 *   and up to CONTEXT_LINES lines before and after it, each cut to 300
 *   characters and scrubbed like the stack, when the map carries the
 *   source's `sourcesContent` (kept at upload for in-app sources,
 *   source-maps.ts). Dependency frames get none.
 * - Never fails ingest: any error leaves the frame as parsed.
 *
 * Parsed maps are cached per (org, repository, release, file) — or per debug
 * id — in a byte-bounded LRU, so a busy issue never refetches its map. A map
 * that would take more than half of that budget is used for its lookup and
 * not kept (source-map-mappings.ts reads it without decoding it), so one huge
 * vendor chunk cannot flush every other map.
 */

export type MapFetcher = (key: SourceMapKey) => Promise<string | null>;

export interface SymbolicationScope {
	orgId: string;
	repositoryId: string;
	release: string | null;
	/** Script URL (or, on a server, script path) → debug id (EI-13), when the SDK sent them. */
	debugIds?: Record<string, string> | null;
	/**
	 * A Node or edge stack (RF-05): only in-app frames are looked up, their
	 * paths are normalised (serverScriptPath), and without a debug id the
	 * release's map is found by path suffix.
	 */
	server?: boolean;
}

const JS_FILE_RE = /\.[cm]?js$/i;
const MAX_CONTEXT_CHARS = 300;
/** Lines kept before and after an in-app frame's own line (RF-05). */
export const CONTEXT_LINES = 5;

/**
 * In-app browser frames a source map could resolve, counted after
 * symbolication (EI-27): `resolved` ones, and `unresolved` .js/.mjs/.cjs
 * frames left as parsed (no map uploaded, no release or debug id, no
 * mapping at that position). Frames a map moved out of the app
 * (node_modules, ignoreList) and non-JS frames count in neither. Stored per
 * occurrence (`in_app_frames_resolved` / `in_app_frames_unresolved`) for the
 * EI-14 rule: over 30% unresolved means the release needs source maps.
 */
export function inAppFrameResolution(frames: readonly StackFrame[] | undefined): { resolved: number; unresolved: number } {
	let resolved = 0;
	let unresolved = 0;
	for (const frame of frames ?? []) {
		if (!frame.inApp) continue;
		if (frame.resolved) resolved += 1;
		else if (frame.filename && JS_FILE_RE.test(frame.filename)) unresolved += 1;
	}
	return { resolved, unresolved };
}

/** Path-only form of a script URL — the key uploads are stored under. */
export function scriptPath(filename: string): string | null {
	try {
		return new URL(filename, "https://autter.invalid").pathname;
	} catch {
		return null;
	}
}

/**
 * The path form of a server frame's file, comparable with stored upload
 * paths: `file:///app/dist/index.mjs` → `/app/dist/index.mjs`,
 * `C:\app\dist\index.js` → `/app/dist/index.js`, `index.js` (a Worker
 * script) → `/index.js`. Null when it is not a path.
 */
export function serverScriptPath(filename: string): string | null {
	let path = filename;
	if (/^file:\/\//i.test(path)) {
		try {
			path = new URL(path).pathname;
		} catch {
			return null;
		}
	}
	path = path.replace(/\\/g, "/").replace(/^\/?[A-Za-z]:(?=\/)/, "");
	return scriptPath(path);
}

// ── Cache ─────────────────────────────────────────────────────────────────

export interface SourceMapCacheOptions {
	/** Budget for the estimated in-memory size of parsed maps (default 64 MiB).
	 * A map that would take more than half of it is not cached. */
	maxBytes?: number;
	maxEntries?: number;
	/** How long a found map is reused (default 1 h). */
	hitTtlMs?: number;
	/** How long "no map uploaded" is remembered (default 5 min). */
	missTtlMs?: number;
	/** How long a failed lookup is remembered (default 30 s). */
	errorTtlMs?: number;
	now?: () => number;
}

/** A parsed map: its metadata, its function scopes, and position lookups. */
export interface LoadedSourceMap {
	/** Sources, names, ignore list and sourcesContent. Its own `mappings`
	 * are left empty: positions go through `lookup`. */
	map: TraceMap;
	scopes: ScopeIndex | null;
	/** Original positions for 0-based generated positions (one call per stack). */
	lookup(positions: readonly GeneratedPosition[]): Array<MappedSegment | null>;
	/** Estimated heap: decoded mappings (when decoded), strings and scopes. */
	bytes: number;
	/** False when the map was too big to keep, so its mappings were not decoded. */
	cacheable: boolean;
}

interface CacheEntry {
	map: LoadedSourceMap | null;
	weight: number;
	expiresAt: number;
}

/**
 * The largest share of the budget one map may take. A bigger one is used
 * for its lookup and dropped: keeping it would evict most other maps, and
 * every event in those files would then refetch theirs.
 */
const MAX_SHARE_OF_BUDGET = 0.5;

export class SourceMapCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly inFlight = new Map<string, Promise<LoadedSourceMap | null>>();
	private weight = 0;
	private readonly maxBytes: number;
	private readonly maxEntries: number;
	private readonly hitTtlMs: number;
	private readonly missTtlMs: number;
	private readonly errorTtlMs: number;
	private readonly now: () => number;
	/** Fetches made (cache misses) — for tests and /healthz-style debugging. */
	fetches = 0;
	/** Maps used without being cached because they were too big to keep. */
	bypassed = 0;

	constructor(options: SourceMapCacheOptions = {}) {
		this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
		this.maxEntries = options.maxEntries ?? 500;
		this.hitTtlMs = options.hitTtlMs ?? 60 * 60_000;
		this.missTtlMs = options.missTtlMs ?? 5 * 60_000;
		this.errorTtlMs = options.errorTtlMs ?? 30_000;
		this.now = options.now ?? Date.now;
	}

	static keyOf(key: SourceMapKey): string {
		const scope = `${key.orgId}\u0000${key.repositoryId}\u0000`;
		// A suffix lookup (server frame) can find another map than an exact one
		// for the same path, so the two never share an entry.
		return key.debugId
			? `${scope}d\u0000${key.debugId}`
			: `${scope}${key.suffix ? "s" : "r"}\u0000${key.release ?? ""}\u0000${key.filename}`;
	}

	get size(): number {
		return this.entries.size;
	}

	/** Estimated bytes of the cached maps (what `maxBytes` bounds). */
	get bytes(): number {
		return this.weight;
	}

	/** The parsed map for `key` (null when none), fetching at most once at a time. */
	async get(key: SourceMapKey, fetchMap: MapFetcher): Promise<LoadedSourceMap | null> {
		const id = SourceMapCache.keyOf(key);
		const hit = this.entries.get(id);
		if (hit) {
			if (hit.expiresAt > this.now()) {
				// Refresh recency: Map iteration order is insertion order.
				this.entries.delete(id);
				this.entries.set(id, hit);
				return hit.map;
			}
			this.remove(id);
		}
		const pending = this.inFlight.get(id);
		if (pending) return pending;
		const load = this.load(id, key, fetchMap).finally(() => this.inFlight.delete(id));
		this.inFlight.set(id, load);
		return load;
	}

	private async load(id: string, key: SourceMapKey, fetchMap: MapFetcher): Promise<LoadedSourceMap | null> {
		this.fetches += 1;
		let json: string | null;
		try {
			json = await fetchMap(key);
		} catch (err) {
			console.warn(
				"source map lookup failed — frames stay unresolved:",
				err instanceof Error ? err.message : err,
			);
			this.store(id, null, 0, this.errorTtlMs);
			return null;
		}
		if (!json) {
			this.store(id, null, 0, this.missTtlMs);
			return null;
		}
		let loaded: LoadedSourceMap;
		try {
			loaded = parseSourceMap(json, this.maxBytes * MAX_SHARE_OF_BUDGET);
		} catch {
			// A malformed upload is a miss until it is replaced.
			this.store(id, null, 0, this.missTtlMs);
			return null;
		}
		if (loaded.cacheable) this.store(id, loaded, loaded.bytes, this.hitTtlMs);
		else this.bypassed += 1;
		return loaded;
	}

	private store(id: string, map: LoadedSourceMap | null, weight: number, ttlMs: number): void {
		// A map bigger than the whole budget serves this lookup but is not kept:
		// caching it would evict everything else.
		if (weight > this.maxBytes) return;
		this.remove(id);
		this.entries.set(id, { map, weight, expiresAt: this.now() + ttlMs });
		this.weight += weight;
		while (
			(this.weight > this.maxBytes || this.entries.size > this.maxEntries) &&
			this.entries.size > 1
		) {
			const oldest = this.entries.keys().next().value as string;
			this.remove(oldest);
		}
	}

	private remove(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		this.weight -= entry.weight;
	}
}

/** Rough heap of a list of strings (V8 strings plus array slots). */
function stringsBytes(list: unknown): number {
	if (!Array.isArray(list)) return 0;
	let bytes = 16;
	for (const item of list) bytes += 8 + (typeof item === "string" ? 2 * item.length + 24 : 0);
	return bytes;
}

/**
 * Parse a stored map once: metadata, scopes (null when absent or malformed
 * — a bad scope field never loses the map) and position lookups. When the
 * estimated heap is at most `maxDecodedBytes`, the mappings are decoded
 * once into a compact table; otherwise they are left encoded and each
 * lookup reads them in one pass (`cacheable: false`). Throws when the map
 * itself is unusable.
 */
export function parseSourceMap(json: string, maxDecodedBytes = Number.POSITIVE_INFINITY): LoadedSourceMap {
	const raw: unknown = JSON.parse(json);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a source map");
	const fields = raw as Record<string, unknown>;
	const { mappings } = fields;
	if (typeof mappings !== "string") throw new Error("no mappings");
	// TraceMap copies only the standard fields, but given an object that has
	// its private `_decodedMemo` it would return that object as is. It gets
	// no mappings: decoding them is this module's job.
	delete fields._decodedMemo;
	const map = new TraceMap({ ...fields, mappings: "" } as unknown as SourceMapInput);
	let scopes: ScopeIndex | null = null;
	try {
		scopes = ScopeIndex.from(fields[SCOPES_KEY], map.names);
	} catch {
		scopes = null;
	}
	const bytes =
		decodedMappingsBytes(mappings) +
		stringsBytes(map.names) +
		stringsBytes(map.sources) +
		stringsBytes(map.resolvedSources) +
		stringsBytes(map.sourcesContent) +
		(scopes?.bytes ?? 0);
	if (bytes <= maxDecodedBytes) {
		const decoded = DecodedMappings.decode(mappings);
		return {
			map,
			scopes,
			bytes,
			cacheable: true,
			lookup: (positions) => positions.map((position) => decoded.find(position.line, position.column)),
		};
	}
	return { map, scopes, bytes, cacheable: false, lookup: (positions) => findInMappings(mappings, positions) };
}

// ── Resolution ────────────────────────────────────────────────────────────

/** A name a minifier evidently produced ("a", "Xe", "Object.t"). */
function looksMangled(name: string): boolean {
	const bare = name.replace(/^(?:async\s+)?(?:new\s+)?/, "");
	const last = bare.split(/[.\s]/).filter(Boolean).pop() ?? "";
	return last.length <= 2;
}

/**
 * Lines `index - radius` … `index + radius` (0-based) of `content`, found
 * without splitting the whole file (a busy frame in a big file would split
 * it on every event); `at` is where line `index` sits in `lines`. Null when
 * the file is shorter than `index + 1` lines.
 */
function linesAround(content: string, index: number, radius: number): { lines: string[]; at: number } | null {
	if (index < 0) return null;
	const first = Math.max(0, index - radius);
	let start = 0;
	for (let line = 0; line < first; line++) {
		const newline = content.indexOf("\n", start);
		if (newline < 0) return null;
		start = newline + 1;
	}
	const lines: string[] = [];
	for (let line = first; line <= index + radius; line++) {
		const newline = content.indexOf("\n", start);
		const end = newline < 0 ? content.length : newline;
		lines.push(content.slice(start, end).replace(/\r$/, ""));
		if (newline < 0) break;
		start = newline + 1;
	}
	const at = index - first;
	return at < lines.length ? { lines, at } : null;
}

function contextFor(map: TraceMap, source: string, line: number): Pick<StackFrame, "contextLine" | "preContext" | "postContext"> {
	let content: string | null = null;
	try {
		content = sourceContentFor(map, source);
	} catch {
		content = null;
	}
	if (!content) return {};
	const window = linesAround(content, line - 1, CONTEXT_LINES);
	if (!window) return {};
	// Source code can hold secrets: scrubbed like the stack. Cut first so the
	// scrub work stays bounded, with slack so a secret straddling the cut is
	// still seen whole.
	const clean = (value: string) => scrubText(value.slice(0, MAX_CONTEXT_CHARS + 512)).slice(0, MAX_CONTEXT_CHARS);
	return {
		contextLine: clean(window.lines[window.at]!),
		preContext: window.lines.slice(0, window.at).map(clean),
		postContext: window.lines.slice(window.at + 1).map(clean),
	};
}

interface Resolution {
	frame: StackFrame;
	/** The original name mapped at this frame's own position (the callee it calls). */
	nameHere: string | null;
	/** The function this frame is in, when its map carries scopes. */
	scope: ScopeName | null;
}

export class Symbolicator {
	constructor(
		private readonly fetchMap: MapFetcher,
		readonly cache: SourceMapCache = new SourceMapCache(),
	) {}

	/**
	 * Resolve the JS frames of one stack. Returns a new array; frames that
	 * cannot be resolved (no map, no position, non-JS) are returned as given.
	 */
	async symbolicate(frames: StackFrame[], scope: SymbolicationScope): Promise<StackFrame[]> {
		if (frames.length === 0) return frames;
		try {
			return await this.resolveAll(frames, scope);
		} catch (err) {
			console.warn(
				"symbolication failed — using parsed frames:",
				err instanceof Error ? err.message : err,
			);
			return frames;
		}
	}

	private debugIdFor(filename: string, debugIds: Record<string, string> | null | undefined): string | null {
		if (!debugIds) return null;
		const direct = debugIds[filename];
		if (typeof direct === "string" && direct) return direct;
		for (const [url, id] of Object.entries(debugIds)) {
			if (typeof id === "string" && id && stripQueryAndHash(url) === filename) return id;
		}
		return null;
	}

	private keyFor(frame: StackFrame, scope: SymbolicationScope): SourceMapKey | null {
		if (!frame.filename || frame.lineno == null || frame.lineno < 1) return null;
		if (!JS_FILE_RE.test(frame.filename)) return null;
		// A server's dependency and runtime frames (node_modules/, node:) run
		// from files no upload covers; looking them up by suffix could even
		// pick an app bundle that happens to share the file name.
		if (scope.server && !frame.inApp) return null;
		const path = scope.server ? serverScriptPath(frame.filename) : scriptPath(frame.filename);
		if (!path) return null;
		const debugId = this.debugIdFor(frame.filename, scope.debugIds);
		if (!debugId && !scope.release) return null;
		return {
			orgId: scope.orgId,
			repositoryId: scope.repositoryId,
			release: scope.release,
			filename: path,
			...(debugId ? { debugId } : {}),
			...(scope.server ? { suffix: true } : {}),
		};
	}

	private async resolveAll(frames: StackFrame[], scope: SymbolicationScope): Promise<StackFrame[]> {
		const keys = frames.map((frame) => this.keyFor(frame, scope));
		if (!keys.some(Boolean)) return frames;
		const maps = await Promise.all(
			keys.map((key) => (key ? this.cache.get(key, this.fetchMap) : Promise.resolve(null))),
		);
		const resolutions = resolveFrames(frames, maps);
		if (!resolutions.some(Boolean)) return frames;
		return frames.map((frame, i) => {
			const resolution = resolutions[i];
			if (!resolution) return frame;
			const { scope } = resolution;
			if (scope?.kind === "named") return { ...resolution.frame, function: scope.name };
			if (scope?.kind === "anonymous") return { ...resolution.frame, function: null };
			// No scopes (an older upload), or a function whose name the CLI
			// could not map: innermost first, so the caller is the next frame.
			const callerName = resolutions[i + 1]?.nameHere ?? null;
			const parsed = frame.function;
			const name = callerName ?? (parsed && !looksMangled(parsed) ? parsed : null);
			return { ...resolution.frame, function: name };
		});
	}
}

/** A frame's 0-based generated position (stack lines and columns are 1-based). */
function generatedPosition(frame: StackFrame): GeneratedPosition {
	return { line: frame.lineno! - 1, column: Math.max(0, (frame.colno ?? 1) - 1) };
}

/** Resolve every frame that has a map, with one lookup per map: a map too
 * big to keep is read in a single pass for the whole stack. */
function resolveFrames(frames: StackFrame[], maps: Array<LoadedSourceMap | null>): Array<Resolution | null> {
	const resolutions: Array<Resolution | null> = frames.map(() => null);
	const byMap = new Map<LoadedSourceMap, number[]>();
	maps.forEach((loaded, index) => {
		if (!loaded) return;
		const indexes = byMap.get(loaded);
		if (indexes) indexes.push(index);
		else byMap.set(loaded, [index]);
	});
	for (const [loaded, indexes] of byMap) {
		const positions = indexes.map((index) => generatedPosition(frames[index]!));
		let segments: Array<MappedSegment | null>;
		try {
			segments = loaded.lookup(positions);
		} catch {
			continue;
		}
		indexes.forEach((frameIndex, k) => {
			try {
				resolutions[frameIndex] = resolveFrame(loaded, frames[frameIndex]!, positions[k]!, segments[k] ?? null);
			} catch {
				resolutions[frameIndex] = null;
			}
		});
	}
	return resolutions;
}

function resolveFrame(
	loaded: LoadedSourceMap,
	frame: StackFrame,
	position: GeneratedPosition,
	segment: MappedSegment | null,
): Resolution | null {
	const { map } = loaded;
	if (!segment) return null;
	const source = map.resolvedSources[segment.source];
	if (!source) return null;
	const filename = stripQueryAndHash(source);
	const ignored = (() => {
		try {
			return isIgnored(map, source);
		} catch {
			return false;
		}
	})();
	const line = segment.line + 1;
	const inApp = !ignored && isInAppPath(filename);
	const resolved: StackFrame = {
		function: frame.function,
		module: null,
		filename,
		lineno: line,
		colno: segment.column + 1,
		inApp,
		resolved: true,
		// Context lines are the evidence for the app's own code (RF-05).
		...(inApp ? contextFor(map, source, line) : {}),
	};
	const name = segment.name >= 0 ? map.names[segment.name] : undefined;
	return {
		frame: resolved,
		nameHere: typeof name === "string" ? name : null,
		scope: loaded.scopes ? loaded.scopes.nameAt(position.line, position.column) : null,
	};
}
