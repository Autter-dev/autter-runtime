import { readFile, writeFile } from "node:fs/promises";
import {
	debugIdFor,
	debugIdSnippet,
	hasDebugIdSnippet,
	readDebugIdComment,
} from "./debug-id.js";
import { findBundles, stripSourceMappingUrl, type BundleWithMap } from "./files.js";

export interface InjectOptions {
	/** Only these bundles (absolute, or relative to the directory). */
	files?: string[];
	/** Report what would change without writing anything. */
	dryRun?: boolean;
	/** Also drop the bundle's `//# sourceMappingURL=` comment (hidden maps). */
	stripSourceMappingUrl?: boolean;
}

export interface InjectResult {
	/** Bundle path relative to the directory. */
	path: string;
	js: string;
	map: string;
	debugId: string;
	/** "injected": files were (or, in a dry run, would be) changed. */
	status: "injected" | "unchanged" | "invalid-map";
}

/** Source map extension field recording the generated line our snippet was
 * inserted on (its mappings were shifted down by one line from there). */
export const SNIPPET_LINE_KEY = "x_autter_snippet_line";

/**
 * Index of the generated line the snippet goes on, or -1 to append it at the
 * end instead. Line 0 normally (line 1 after a `#!` shebang), so the snippet
 * runs before the bundle's own code and registers its id even when that
 * code throws while loading. A leading directive prologue ("use strict",
 * "use client") must stay first, so those bundles get the snippet appended.
 */
export function snippetLine(code: string): number {
	let line = 0;
	let i = 0;
	if (code.startsWith("#!")) {
		const nl = code.indexOf("\n");
		if (nl < 0) return -1;
		line = 1;
		i = nl + 1;
	}
	for (;;) {
		while (i < code.length && /\s/.test(code[i]!)) i++;
		if (code.startsWith("//", i)) {
			const nl = code.indexOf("\n", i);
			if (nl < 0) return -1;
			i = nl + 1;
		} else if (code.startsWith("/*", i)) {
			const end = code.indexOf("*/", i + 2);
			if (end < 0) return -1;
			i = end + 2;
		} else {
			break;
		}
	}
	return code[i] === '"' || code[i] === "'" ? -1 : line;
}

/** Insert `count` empty generated lines before line `at` of a VLQ `mappings`
 * string. Segment fields other than the column are relative across lines,
 * so empty lines need no other change. */
export function shiftMappings(mappings: string, at: number, count = 1): string {
	const lines = mappings.split(";");
	while (lines.length < at) lines.push("");
	lines.splice(at, 0, ...Array<string>(count).fill(""));
	return lines.join(";");
}

/** Put `text` (one or more full lines) before a trailing run of `//#`
 * comments such as `sourceMappingURL`, which conventionally end the file. */
function insertBeforeTrailingComments(code: string, text: string): string {
	const lines = code.split("\n");
	let at = lines.length;
	while (at > 0) {
		const line = lines[at - 1]!.trim();
		if (line === "" || line.startsWith("//#") || line.startsWith("//@")) at--;
		else break;
	}
	const head = lines.slice(0, at).join("\n");
	const tail = lines.slice(at).join("\n");
	return `${head}${head && !head.endsWith("\n") ? "\n" : ""}${text}${tail ? `\n${tail.replace(/^\n+/, "")}` : "\n"}`;
}

/**
 * Give one bundle its debug id. Idempotent: a bundle that already has our
 * snippet and a `//# debugId=` comment is left byte-for-byte alone (its map
 * only gains `debugId` if it lacks it). A bundle whose bundler already wrote
 * a debug id comment keeps that id and only gains the snippet.
 */
export async function injectBundle(bundle: BundleWithMap, options: InjectOptions = {}): Promise<InjectResult> {
	const bytes = await readFile(bundle.js);
	const code = bytes.toString("utf8");
	const base = { path: bundle.path, js: bundle.js, map: bundle.map };
	let map: Record<string, unknown>;
	try {
		map = JSON.parse(await readFile(bundle.map, "utf8")) as Record<string, unknown>;
		if (!map || typeof map !== "object") throw new Error("not an object");
	} catch {
		return { ...base, debugId: "", status: "invalid-map" };
	}

	const existing = readDebugIdComment(code);
	const hasSnippet = hasDebugIdSnippet(code);
	const debugId = existing ?? debugIdFor(bytes);
	let out = code;
	let mapDirty = false;
	if (!hasSnippet) {
		// Set when the map was already shifted for a snippet line but the
		// bundle write never happened (a crash between the two writes):
		// re-insert on that line without shifting twice.
		const shifted = typeof map[SNIPPET_LINE_KEY] === "number" ? (map[SNIPPET_LINE_KEY] as number) : null;
		const line = shifted ?? snippetLine(code);
		if (line >= 0 && (shifted !== null || (typeof map.mappings === "string" && !("sections" in map)))) {
			let offset = 0;
			for (let n = 0; n < line; n++) offset = out.indexOf("\n", offset) + 1;
			out = `${out.slice(0, offset)}${debugIdSnippet(debugId)}\n${out.slice(offset)}`;
			if (shifted === null) {
				map.mappings = shiftMappings(map.mappings as string, line);
				map[SNIPPET_LINE_KEY] = line;
				mapDirty = true;
			}
		} else {
			// Appended code doesn't move any mapped position.
			out = insertBeforeTrailingComments(out, debugIdSnippet(debugId));
		}
	}
	if (!existing) out = `${out}${out.endsWith("\n") ? "" : "\n"}//# debugId=${debugId}\n`;
	if (options.stripSourceMappingUrl) out = stripSourceMappingUrl(out);
	if (map.debugId !== debugId) {
		map.debugId = debugId;
		mapDirty = true;
	}
	const changed = mapDirty || out !== code;
	if (changed && !options.dryRun) {
		// Map first: after a crash between the writes the next run finds the
		// shifted map (SNIPPET_LINE_KEY) and finishes the bundle.
		if (mapDirty) await writeFile(bundle.map, JSON.stringify(map));
		if (out !== code) await writeFile(bundle.js, out);
	}
	return { ...base, debugId, status: changed ? "injected" : "unchanged" };
}

/** Inject every bundle with a map under `dir` (see injectBundle). */
export async function injectDir(dir: string, options: InjectOptions = {}): Promise<InjectResult[]> {
	const results: InjectResult[] = [];
	for (const bundle of await findBundles(dir, options.files)) results.push(await injectBundle(bundle, options));
	return results;
}
