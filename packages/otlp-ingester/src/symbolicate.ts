import {
	isIgnored,
	originalPositionFor,
	sourceContentFor,
	TraceMap,
} from "@jridgewell/trace-mapping";
import type { SourceMapKey } from "./source-maps-lookup.js";
import { isInAppPath, stripQueryAndHash } from "./stack-frames.js";
import type { StackFrame } from "./types.js";

/**
 * Symbolication at ingest: minified browser frames are resolved through the
 * source maps uploaded for the release (`/v1/sourcemaps`) BEFORE they are
 * fingerprinted, so `frames-v3` hashes `checkout.tsx`, not
 * `index-5f3a9c1e.js` — and an issue survives deploys and preview domains.
 *
 * - Function names come from the map's `names`: the name mapped at the
 *   CALLER's position is the callee's original name (the call site names
 *   what it calls). Without one, a resolved frame keeps its parsed name
 *   only when that is not an obviously mangled one (≤ 2 characters), since
 *   a mangled name changes on every build.
 * - Sources the map lists in `ignoreList` / `x_google_ignoreList` are not
 *   in-app; a resolved path under node_modules/ etc. is not in-app either.
 * - Context lines only when the map carries `sourcesContent` (the upload
 *   strips it today, so there are none for now).
 * - Never fails ingest: any error leaves the frame as parsed.
 *
 * Parsed maps are cached per (org, repository, release, file) — or per debug
 * id — in a byte-bounded LRU, so a busy issue never refetches its map.
 */

export type MapFetcher = (key: SourceMapKey) => Promise<string | null>;

export interface SymbolicationScope {
	orgId: string;
	repositoryId: string;
	release: string | null;
	/** Script URL → debug id (EI-13), when the browser sent them. */
	debugIds?: Record<string, string> | null;
}

const JS_FILE_RE = /\.[cm]?js$/i;
const MAX_CONTEXT_CHARS = 300;
const CONTEXT_LINES = 3;

/** Path-only form of a script URL — the key uploads are stored under. */
export function scriptPath(filename: string): string | null {
	try {
		return new URL(filename, "https://autter.invalid").pathname;
	} catch {
		return null;
	}
}

// ── Cache ─────────────────────────────────────────────────────────────────

export interface SourceMapCacheOptions {
	/** Budget for the estimated in-memory size of parsed maps (default 64 MiB). */
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

interface CacheEntry {
	map: TraceMap | null;
	weight: number;
	expiresAt: number;
}

/**
 * Decoded mappings take several times the JSON's size; the budget counts an
 * estimate so a handful of large bundles cannot exhaust a small container.
 */
const DECODED_WEIGHT_FACTOR = 8;

export class SourceMapCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly inFlight = new Map<string, Promise<TraceMap | null>>();
	private weight = 0;
	private readonly maxBytes: number;
	private readonly maxEntries: number;
	private readonly hitTtlMs: number;
	private readonly missTtlMs: number;
	private readonly errorTtlMs: number;
	private readonly now: () => number;
	/** Fetches made (cache misses) — for tests and /healthz-style debugging. */
	fetches = 0;

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
		return key.debugId
			? `${scope}d\u0000${key.debugId}`
			: `${scope}r\u0000${key.release ?? ""}\u0000${key.filename}`;
	}

	get size(): number {
		return this.entries.size;
	}

	/** The parsed map for `key` (null when none), fetching at most once at a time. */
	async get(key: SourceMapKey, fetchMap: MapFetcher): Promise<TraceMap | null> {
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

	private async load(id: string, key: SourceMapKey, fetchMap: MapFetcher): Promise<TraceMap | null> {
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
		let map: TraceMap;
		try {
			map = new TraceMap(json);
		} catch {
			// A malformed upload is a miss until it is replaced.
			this.store(id, null, 0, this.missTtlMs);
			return null;
		}
		this.store(id, map, json.length * DECODED_WEIGHT_FACTOR, this.hitTtlMs);
		return map;
	}

	private store(id: string, map: TraceMap | null, weight: number, ttlMs: number): void {
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

// ── Resolution ────────────────────────────────────────────────────────────

/** A name a minifier evidently produced ("a", "Xe", "Object.t"). */
function looksMangled(name: string): boolean {
	const bare = name.replace(/^(?:async\s+)?(?:new\s+)?/, "");
	const last = bare.split(/[.\s]/).filter(Boolean).pop() ?? "";
	return last.length <= 2;
}

function contextFor(map: TraceMap, source: string, line: number): Pick<StackFrame, "contextLine" | "preContext" | "postContext"> {
	let content: string | null = null;
	try {
		content = sourceContentFor(map, source);
	} catch {
		content = null;
	}
	if (!content) return {};
	const lines = content.split(/\r?\n/);
	const index = line - 1;
	if (index < 0 || index >= lines.length) return {};
	const cut = (value: string) => value.slice(0, MAX_CONTEXT_CHARS);
	return {
		contextLine: cut(lines[index]!),
		preContext: lines.slice(Math.max(0, index - CONTEXT_LINES), index).map(cut),
		postContext: lines.slice(index + 1, index + 1 + CONTEXT_LINES).map(cut),
	};
}

interface Resolution {
	frame: StackFrame;
	/** The original name mapped at this frame's own position (the callee it calls). */
	nameHere: string | null;
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
		const path = scriptPath(frame.filename);
		if (!path) return null;
		const debugId = this.debugIdFor(frame.filename, scope.debugIds);
		if (!debugId && !scope.release) return null;
		return {
			orgId: scope.orgId,
			repositoryId: scope.repositoryId,
			release: scope.release,
			filename: path,
			...(debugId ? { debugId } : {}),
		};
	}

	private async resolveAll(frames: StackFrame[], scope: SymbolicationScope): Promise<StackFrame[]> {
		const keys = frames.map((frame) => this.keyFor(frame, scope));
		if (!keys.some(Boolean)) return frames;
		const maps = await Promise.all(
			keys.map((key) => (key ? this.cache.get(key, this.fetchMap) : Promise.resolve(null))),
		);
		const resolutions: Array<Resolution | null> = frames.map((frame, i) => {
			const map = maps[i];
			if (!map) return null;
			try {
				return resolveFrame(map, frame);
			} catch {
				return null;
			}
		});
		if (!resolutions.some(Boolean)) return frames;
		return frames.map((frame, i) => {
			const resolution = resolutions[i];
			if (!resolution) return frame;
			// Innermost first: the caller is the next frame.
			const callerName = resolutions[i + 1]?.nameHere ?? null;
			const parsed = frame.function;
			const name = callerName ?? (parsed && !looksMangled(parsed) ? parsed : null);
			return { ...resolution.frame, function: name };
		});
	}
}

function resolveFrame(map: TraceMap, frame: StackFrame): Resolution | null {
	const position = originalPositionFor(map, {
		line: frame.lineno!,
		// Stack columns are 1-based, source map columns 0-based.
		column: Math.max(0, (frame.colno ?? 1) - 1),
	});
	if (!position.source || position.line == null) return null;
	const filename = stripQueryAndHash(position.source);
	const ignored = (() => {
		try {
			return isIgnored(map, position.source);
		} catch {
			return false;
		}
	})();
	const resolved: StackFrame = {
		function: frame.function,
		module: null,
		filename,
		lineno: position.line,
		colno: position.column == null ? null : position.column + 1,
		inApp: !ignored && isInAppPath(filename),
		resolved: true,
		...contextFor(map, position.source, position.line),
	};
	return { frame: resolved, nameHere: position.name ?? null };
}
