import { Parser, type Options } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";
import {
	BASE_OPTIONS,
	collectFunctions,
	encodeScopes,
	lineStarts,
	positionOf,
	SCOPES_VERSION,
	type AstNode,
	type FunctionScope,
	type ScopeEntry,
} from "./scopes.js";

/**
 * Function scopes of the ORIGINAL sources (`x_autter_original_scopes`).
 *
 * `x_autter_scopes` names a frame after the bundle function it ran in. A
 * minifier that inlines functions (SWC in Next.js, terser) moves a
 * function's body into its caller, so the bundle function is the caller:
 * the throw in `applyDiscount` (pricing.js) inlined into `onCheckoutClick`
 * (main.js) read as `onCheckoutClick` at pricing.js:4, and the same defect
 * built without inlining (Vite, esbuild) read as `applyDiscount`: two
 * frame identities, two issues. The original source knows better: a
 * frame's original position lies in exactly one original function.
 *
 * So `upload` parses each in-app source it sends (`sourcesContent`;
 * JavaScript, TypeScript, JSX) and records that file's functions, each named
 * by its own name, else its binding or key, as written. The ingester names a
 * resolved frame after the innermost original function at its original
 * position, and keeps the bundle-scope rule for sources without one (not
 * sent, not parsed: `.vue`, `.svelte`, a syntax error).
 *
 * Shape: `{ version: 1, names: (string)[], sources: (string | null)[] }`,
 * `sources` aligned with the map's `sources`. Each string is encoded exactly
 * like `x_autter_scopes.scopes` (see SourceMapScopes), with positions in
 * that source file; name indexes continue the map's own `names` with
 * `names`.
 */

export const ORIGINAL_SCOPES_KEY = "x_autter_original_scopes";

export interface OriginalScopes {
	version: typeof SCOPES_VERSION;
	names: string[];
	sources: Array<string | null>;
}

const TsxParser = Parser.extend(tsPlugin({ jsx: true }));
const TsParser = Parser.extend(tsPlugin());
const JsxParser = TsxParser;

const PARSE_OPTIONS = {
	...BASE_OPTIONS,
	sourceType: "module",
	allowAwaitOutsideFunction: true,
	allowImportExportEverywhere: true,
} satisfies Partial<Options>;

/** Parsers to try for a source, by its extension: TypeScript (with JSX for
 * .tsx), JavaScript then JavaScript with JSX. Null for anything else
 * (.vue, .svelte, .astro, CSS): those are not parsed. */
function parsersFor(source: string): Array<typeof Parser> | null {
	const path = source.split(/[?#]/)[0]!.toLowerCase();
	if (/\.tsx$/.test(path)) return [TsxParser];
	if (/\.[cm]?ts$/.test(path)) return [TsParser, TsxParser];
	if (/\.[cm]?jsx?$/.test(path)) return [Parser, JsxParser];
	return null;
}

function parseSource(source: string, content: string): AstNode | null {
	const parsers = parsersFor(source);
	if (!parsers) return null;
	for (const parser of parsers) {
		for (const sourceType of ["module", "script"] as const) {
			try {
				return parser.parse(content, { ...PARSE_OPTIONS, sourceType }) as unknown as AstNode;
			} catch {
				// try the next parser / source type
			}
		}
	}
	return null;
}

/** The name a function is known by in its own source: its own name, else
 * its binding or key (identifiers as written: nothing is minified here). */
function nameOf(fn: FunctionScope): string | null {
	if (fn.own) return fn.own.name;
	for (const token of fn.context) if (token.name) return token.name;
	return null;
}

/**
 * Original function scopes for every source of `map` that has content
 * (`sourcesContent`, as it will be stored: in-app sources only). Null when
 * no source could be parsed. Never throws.
 */
export function computeOriginalScopes(map: Record<string, unknown>): OriginalScopes | null {
	const sources = Array.isArray(map.sources) ? map.sources : [];
	const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
	const mapNames = Array.isArray(map.names) ? map.names : [];
	const nameIndex = new Map<string, number>();
	mapNames.forEach((name, index) => {
		if (typeof name === "string" && !nameIndex.has(name)) nameIndex.set(name, index);
	});
	const extraNames: string[] = [];
	const indexOf = (name: string): number => {
		let index = nameIndex.get(name);
		if (index === undefined) {
			index = mapNames.length + extraNames.push(name) - 1;
			nameIndex.set(name, index);
		}
		return index;
	};
	let any = false;
	const encoded = sources.map((source, i): string | null => {
		const content = contents[i];
		if (typeof source !== "string" || typeof content !== "string" || !content) return null;
		try {
			const program = parseSource(source, content);
			if (!program) return null;
			const functions = collectFunctions(program).sort((a, b) => a.start - b.start || b.end - a.end);
			const starts = lineStarts(content);
			const entries: ScopeEntry[] = functions.map((fn) => {
				const name = nameOf(fn);
				const [startLine, startColumn] = positionOf(starts, fn.start);
				const [endLine, endColumn] = positionOf(starts, fn.end);
				return [startLine, startColumn, endLine, endColumn, name !== null ? indexOf(name) : -1];
			});
			any = true;
			return encodeScopes(entries);
		} catch {
			return null;
		}
	});
	return any ? { version: SCOPES_VERSION, names: extraNames, sources: encoded } : null;
}
