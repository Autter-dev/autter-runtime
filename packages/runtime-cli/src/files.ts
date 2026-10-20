import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** A JS bundle and the source map that belongs to it. */
export interface BundleWithMap {
	/** Absolute path of the bundle. */
	js: string;
	/** Absolute path of its `.map`. */
	map: string;
	/** Bundle path relative to the scanned directory, with `/` separators. */
	path: string;
}

/** Bundles a map can be uploaded for. */
export const BUNDLE_RE = /\.[cm]?js$/;

const SOURCE_MAPPING_URL_RE = /^[ \t]*\/\/[#@] sourceMappingURL=([^\s'"]+)[ \t]*\r?$/gm;

/** The last `//# sourceMappingURL=` value in a bundle, or null. */
export function readSourceMappingUrl(code: string): string | null {
	let found: string | null = null;
	for (const match of code.matchAll(SOURCE_MAPPING_URL_RE)) found = match[1]!;
	return found;
}

/**
 * Remove a trailing `//# sourceMappingURL=` comment (one that is followed by
 * nothing but whitespace or other `//#` comments), so the map is no longer
 * referenced by the served bundle. Line positions above it don't move.
 */
export function stripSourceMappingUrl(code: string): string {
	const lines = code.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.trim();
		if (line === "") continue;
		if (/^\/\/[#@] sourceMappingURL=/.test(line)) {
			lines.splice(i, 1);
			return lines.join("\n");
		}
		if (!line.startsWith("//#")) break;
	}
	return code;
}

/** The map file for a bundle: its relative `sourceMappingURL`, else `<file>.map`. */
export function mapPathFor(js: string, code: string): string | null {
	const url = readSourceMappingUrl(code);
	if (url && !/^[a-z][\w+.-]*:/i.test(url) && !url.startsWith("/")) {
		let decoded = url.split(/[?#]/)[0]!;
		try {
			decoded = decodeURIComponent(decoded);
		} catch {
			// keep the raw value
		}
		const candidate = resolve(dirname(js), decoded);
		if (existsSync(candidate)) return candidate;
	}
	const sibling = `${js}.map`;
	return existsSync(sibling) ? sibling : null;
}

async function walk(dir: string, out: string[], pattern: RegExp = BUNDLE_RE): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) await walk(full, out, pattern);
		else if (entry.isFile() && pattern.test(entry.name)) out.push(full);
	}
}

/** Every `.map` file under `dir` (absolute paths, sorted). */
export async function findMapFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	await walk(resolve(dir), out, /\.map$/);
	return out.sort();
}

const CSS_SOURCE_MAPPING_URL_RE = /\/\*[#@] sourceMappingURL=([^\s*]+)\s*\*\/\s*$/;

/** Whether a sourceMappingURL value, read from `file`, names `map`. */
function pointsAt(file: string, url: string | null | undefined, map: string): boolean {
	if (!url || /^[a-z][\w+.-]*:/i.test(url) || url.startsWith("/")) return false;
	let path = url.split(/[?#]/)[0]!;
	try {
		path = decodeURIComponent(path);
	} catch {
		// keep the raw value
	}
	return resolve(dirname(file), path) === map;
}

/** Drop `file`'s trailing sourceMappingURL comment when it names `map`. */
async function stripReference(file: string, map: string): Promise<void> {
	let code: string;
	try {
		code = await readFile(file, "utf8");
	} catch {
		return;
	}
	let stripped = code;
	if (BUNDLE_RE.test(file)) {
		if (pointsAt(file, readSourceMappingUrl(code), map)) stripped = stripSourceMappingUrl(code);
	} else if (file.endsWith(".css")) {
		const match = CSS_SOURCE_MAPPING_URL_RE.exec(code);
		if (match && pointsAt(file, match[1], map)) stripped = code.slice(0, match.index).replace(/\n?$/, "\n");
	}
	if (stripped !== code) await writeFile(file, stripped);
}

/**
 * Delete source maps, and the sourceMappingURL comment of the file each one
 * belongs to when it names the deleted map. `owners` maps a map to its file
 * when that isn't the map's name without `.map` (a bundle whose comment
 * points elsewhere). Returns the maps that existed and were deleted.
 */
export async function removeSourceMaps(maps: Iterable<string>, owners: ReadonlyMap<string, string> = new Map()): Promise<string[]> {
	const removed: string[] = [];
	for (const map of [...new Set(maps)].sort()) {
		if (!existsSync(map)) continue;
		await rm(map, { force: true });
		removed.push(map);
		const owner = owners.get(map) ?? map.replace(/\.map$/, "");
		await stripReference(owner, map);
	}
	return removed;
}

/**
 * Every `.js`/`.mjs`/`.cjs` bundle under `dir` that has a source map, sorted
 * by path. `files` restricts the scan to those bundles (as a bundler plugin
 * knows exactly what it emitted).
 */
export async function findBundles(dir: string, files?: string[]): Promise<BundleWithMap[]> {
	const root = resolve(dir);
	const candidates: string[] = [];
	if (files) {
		for (const file of files) if (BUNDLE_RE.test(file)) candidates.push(resolve(root, file));
	} else {
		await walk(root, candidates);
	}
	const bundles: BundleWithMap[] = [];
	for (const js of [...new Set(candidates)].sort()) {
		let code: string;
		try {
			code = await readFile(js, "utf8");
		} catch {
			continue;
		}
		const map = mapPathFor(js, code);
		if (map) bundles.push({ js, map, path: relative(root, js).split(sep).join("/") });
	}
	return bundles;
}
