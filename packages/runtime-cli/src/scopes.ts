import { parse, type Options } from "acorn";

/**
 * Function scopes for scope-based frame names (like Sentry's
 * js-source-scopes and PostHog cymbal's `token.scope()`).
 *
 * The ingester used to name a resolved frame with the name the source map
 * holds at its CALLER's position. That is right for `computeTotal()`, and
 * wrong whenever the call goes through a variable: `const run =
 * actions.captured; run()` reported `run`, and handlers a framework calls
 * got the framework's identifier (`func`, `listener`, `fn`). So `upload`
 * parses each bundle (the final file the browser loads, after `inject`),
 * collects every function's generated range and the token that names it,
 * maps that token to its ORIGINAL identifier, and sends the result with the
 * map as `x_autter_scopes`. The ingester names a frame after the innermost
 * function that contains it.
 */

/** Source map extension field that carries the bundle's function scopes. */
export const SCOPES_KEY = "x_autter_scopes";
export const SCOPES_VERSION = 1;

/**
 * The `x_autter_scopes` value. `scopes` is encoded like `mappings`: base64
 * VLQ, `;` between generated lines (the line each scope starts on), `,`
 * between the scopes that start on one line, in start order (outer first on
 * a tie). Each scope is 3 or 4 values, 0-based, in UTF-16 columns:
 *
 *   1. start column, relative to the previous scope's start on the same
 *      line (absolute for a line's first scope);
 *   2. end line, relative to the start line;
 *   3. end column (exclusive), relative to the start column when the scope
 *      ends on its start line, else absolute;
 *   4. the name, when the function has one: an index into the map's own
 *      `names` followed by these `names`, relative to the last name index
 *      written (starting from 0).
 *
 * A 3-value scope is anonymous. `names` holds only names the map's own
 * `names` lacks; a `null` entry stands for a minified name that could not
 * be mapped back (the ingester then keeps the frame's call-site name).
 */
export interface SourceMapScopes {
	version: typeof SCOPES_VERSION;
	names: Array<string | null>;
	scopes: string;
}

/** A scope before encoding: generated range, and the index of its name in
 * the map's `names` + extra names (-1 when anonymous). */
type ScopeEntry = [startLine: number, startColumn: number, endLine: number, endColumn: number, nameIndex: number];

export type ScopesResult = { scopes: SourceMapScopes } | { error: string };

// ── Parsing ───────────────────────────────────────────────────────────────

interface AstNode {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

/** A parsed node and the chain of its ancestors. */
interface Path {
	node: AstNode;
	parent: Path | null;
}

/** A token that names a function: the identifier at `offset`, or a string
 * key (`literal`), which minifiers never rename. */
interface NameToken {
	offset: number;
	name: string;
	literal: boolean;
}

interface FunctionScope {
	start: number;
	end: number;
	/** The function's own name (`function computeTotal`). */
	own: NameToken | null;
	/** Where a nameless `function` expression starts: minifiers drop unused
	 * function-expression names, which the original source still has. */
	recoverAt: number | null;
	/** Then the binding it is assigned to, else its object or class key. */
	context: NameToken[];
}

const BASE_OPTIONS = {
	ecmaVersion: "latest",
	allowHashBang: true,
	allowReturnOutsideFunction: true,
	allowReserved: true,
} satisfies Partial<Options>;

/** Module first (most bundles), then a sloppy script (`with`, octal escapes). */
function parseBundle(code: string): AstNode {
	try {
		return parse(code, {
			...BASE_OPTIONS,
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowImportExportEverywhere: true,
		}) as unknown as AstNode;
	} catch (moduleError) {
		try {
			return parse(code, { ...BASE_OPTIONS, sourceType: "script" }) as unknown as AstNode;
		} catch (scriptError) {
			// Report whichever attempt got further: that is the real error.
			const pos = (err: unknown) => (typeof (err as { pos?: unknown }).pos === "number" ? (err as { pos: number }).pos : -1);
			throw pos(scriptError) > pos(moduleError) ? scriptError : moduleError;
		}
	}
}

function isNode(value: unknown): value is AstNode {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

const IDENTIFIER_NAME_RE = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

function identifierToken(node: unknown): NameToken | null {
	if (!isNode(node)) return null;
	if (node.type === "Identifier") return { offset: node.start, name: node.name as string, literal: false };
	if (node.type === "PrivateIdentifier") return { offset: node.start, name: `#${node.name as string}`, literal: false };
	return null;
}

/** A string key that reads like a name; numeric keys (webpack module ids)
 * and computed expressions name nothing stable. */
function literalToken(node: unknown): NameToken | null {
	if (!isNode(node) || node.type !== "Literal" || typeof node.value !== "string") return null;
	return IDENTIFIER_NAME_RE.test(node.value) ? { offset: node.start, name: node.value, literal: true } : null;
}

/** The key of `{ key: fn }`, `{ key() {} }`, `class { key() {} }`, `class { key = fn }`. */
function keyToken(property: AstNode): NameToken | null {
	if (!property.computed) {
		const id = identifierToken(property.key);
		if (id) return id;
	}
	return literalToken(property.key);
}

/** `x = fn` → x; `obj.x = fn` / `this.#x = fn` / `obj["x"] = fn` → x. */
function bindingToken(target: unknown): NameToken | null {
	if (!isNode(target)) return null;
	if (target.type === "Identifier") return identifierToken(target);
	if (target.type === "MemberExpression") {
		return target.computed ? literalToken(target.property) : identifierToken(target.property);
	}
	return null;
}

/** What a function or class is assigned to, else its key. */
function contextTokens(node: AstNode, parent: AstNode | undefined): NameToken[] {
	let token: NameToken | null = null;
	switch (parent?.type) {
		case "VariableDeclarator":
			if (parent.init === node) token = bindingToken(parent.id);
			break;
		case "AssignmentExpression":
		case "AssignmentPattern":
			if (parent.right === node) token = bindingToken(parent.left);
			break;
		case "Property":
		case "PropertyDefinition":
		case "MethodDefinition":
			if (parent.value === node) token = keyToken(parent);
			break;
	}
	return token ? [token] : [];
}

/** A class's own name, then its binding (`o=class{…}` after minification). */
function classTokens(path: Path | null): NameToken[] {
	if (!path || (path.node.type !== "ClassDeclaration" && path.node.type !== "ClassExpression")) return [];
	const own = identifierToken(path.node.id);
	return [...(own ? [own] : []), ...contextTokens(path.node, path.parent?.node)];
}

function describe(path: Path): FunctionScope {
	const fn = path.node;
	const parent = path.parent?.node;
	const own = identifierToken(fn.id);
	const isMethod =
		parent?.type === "MethodDefinition" ||
		(parent?.type === "Property" && parent.value === fn && (parent.method === true || parent.kind !== "init"));
	let context: NameToken[];
	if (parent?.type === "MethodDefinition" && parent.kind === "constructor") {
		// V8 names a constructor frame `new Cart`; frames-v3 drops the `new `.
		context = classTokens(path.parent?.parent?.parent ?? null);
	} else {
		context = contextTokens(fn, parent);
	}
	return {
		start: fn.start,
		end: fn.end,
		own,
		recoverAt: !own && fn.type !== "ArrowFunctionExpression" && !isMethod ? fn.start : null,
		context,
	};
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * Class field initializers (`x = compute()`) and static blocks run in
 * functions V8 synthesises for the class (`<instance_members_initializer>`,
 * `<static_initializer>`), not in the code around the class: give them a
 * scope named after the class, like its constructor.
 */
function classInitializer(path: Path): FunctionScope | null {
	const node = path.node;
	let range: AstNode | null = null;
	if (node.type === "StaticBlock") range = node;
	else if (node.type === "PropertyDefinition" && isNode(node.value) && !FUNCTION_TYPES.has(node.value.type)) range = node.value;
	if (!range) return null;
	// PropertyDefinition / StaticBlock → ClassBody → class.
	return { start: range.start, end: range.end, own: null, recoverAt: null, context: classTokens(path.parent?.parent ?? null) };
}

/** Every function in the bundle: declarations, expressions, arrows, class
 * and object methods, getters and setters, and class initializers
 * (iterative: minified bundles nest deeply). */
function collectFunctions(program: AstNode): FunctionScope[] {
	const found: FunctionScope[] = [];
	const stack: Path[] = [{ node: program, parent: null }];
	for (let path = stack.pop(); path; path = stack.pop()) {
		const node = path.node;
		if (FUNCTION_TYPES.has(node.type)) found.push(describe(path));
		else {
			const initializer = classInitializer(path);
			if (initializer) found.push(initializer);
		}
		for (const key in node) {
			const value = node[key];
			if (Array.isArray(value)) {
				for (let i = value.length - 1; i >= 0; i--) if (isNode(value[i])) stack.push({ node: value[i] as AstNode, parent: path });
			} else if (isNode(value)) {
				stack.push({ node: value, parent: path });
			}
		}
	}
	return found;
}

// ── Positions ─────────────────────────────────────────────────────────────

/** Offsets where each line starts (ECMAScript line terminators, as V8 counts
 * them for stack positions). */
function lineStarts(code: string): number[] {
	const starts = [0];
	for (let i = 0; i < code.length; i++) {
		const c = code.charCodeAt(i);
		if (c === 10 || c === 0x2028 || c === 0x2029) starts.push(i + 1);
		else if (c === 13) {
			if (code.charCodeAt(i + 1) === 10) i++;
			starts.push(i + 1);
		}
	}
	return starts;
}

function positionOf(starts: number[], offset: number): [line: number, column: number] {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid]! <= offset) lo = mid;
		else hi = mid - 1;
	}
	return [lo, offset - starts[lo]!];
}

// ── Mappings ──────────────────────────────────────────────────────────────

/** The mapping segment that starts exactly at a generated position. */
interface Segment {
	/** -1 when the segment maps to no source. */
	source: number;
	line: number;
	column: number;
	/** -1 when the segment has no name. */
	name: number;
}

const BASE64 = new Int8Array(128).fill(-1);
for (const [i, ch] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries()) BASE64[ch.charCodeAt(0)] = i;

/**
 * Fill `wanted` (generated line → column → null) with the segment that
 * starts exactly at each wanted position, in one pass over `mappings`
 * without keeping the decoded map.
 */
function findSegments(mappings: string, wanted: Map<number, Map<number, Segment | null>>): void {
	let line = 0;
	let column = 0;
	let source = 0;
	let originalLine = 0;
	let originalColumn = 0;
	let name = 0;
	let want = wanted.get(0);
	const fields = [0, 0, 0, 0, 0];
	let i = 0;
	while (i < mappings.length) {
		const ch = mappings.charCodeAt(i);
		if (ch === 59 /* ; */) {
			line++;
			column = 0;
			want = wanted.get(line);
			i++;
			continue;
		}
		if (ch === 44 /* , */) {
			i++;
			continue;
		}
		let count = 0;
		while (i < mappings.length) {
			const next = mappings.charCodeAt(i);
			if (next === 44 || next === 59) break;
			let value = 0;
			let shift = 0;
			let digit: number;
			do {
				const code = mappings.charCodeAt(i++);
				digit = code < 128 ? BASE64[code]! : -1;
				if (digit < 0 || shift > 30) throw new Error("invalid mappings");
				value |= (digit & 31) << shift;
				shift += 5;
			} while (digit & 32);
			const decoded = value & 1 ? -(value >>> 1) : value >>> 1;
			if (count < 5) fields[count] = decoded;
			count++;
		}
		column += fields[0]!;
		if (count >= 4) {
			source += fields[1]!;
			originalLine += fields[2]!;
			originalColumn += fields[3]!;
		}
		if (count >= 5) name += fields[4]!;
		if (want && want.get(column) === null) {
			want.set(column, {
				source: count >= 4 ? source : -1,
				line: originalLine,
				column: originalColumn,
				name: count >= 5 ? name : -1,
			});
		}
	}
}

// ── Names ─────────────────────────────────────────────────────────────────

/** A name a minifier evidently produced (same rule as the ingester). */
function looksMangled(name: string): boolean {
	return name.replace(/^#/, "").length <= 2;
}

const IDENTIFIER_AT_RE = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/uy;
const OWN_NAME_AT_RE = /(?:async\s+)?function\b\s*\*?\s*([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)/uy;

/** Words that sit where a name could be but never name a function. */
const NOT_A_NAME = new Set(
	(
		"abstract async await break case catch class const continue debugger declare default delete do else enum " +
		"export extends false finally for function get if implements import in instanceof interface let new null of " +
		"override package private protected public readonly return set static super switch this throw true try " +
		"typeof var void while with yield"
	).split(" "),
);

class NameResolver {
	private readonly names: unknown[];
	private readonly sourcesContent: unknown[];
	private readonly sourceLines = new Map<number, string[] | null>();

	constructor(
		map: Record<string, unknown>,
		private readonly segmentAt: (offset: number) => Segment | null,
	) {
		this.names = Array.isArray(map.names) ? map.names : [];
		this.sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
	}

	private originalLine(segment: Segment): string | null {
		if (segment.source < 0) return null;
		let lines = this.sourceLines.get(segment.source);
		if (lines === undefined) {
			const content = this.sourcesContent[segment.source];
			lines = typeof content === "string" ? content.split(/\r\n|[\n\r\u2028\u2029]/) : null;
			this.sourceLines.set(segment.source, lines);
		}
		return lines?.[segment.line] ?? null;
	}

	/** The original identifier at a segment's source position. */
	private identifierAt(segment: Segment, re: RegExp, group = 0): string | null {
		const text = this.originalLine(segment);
		if (text === null) return null;
		re.lastIndex = segment.column;
		const found = re.exec(text)?.[group];
		return found && !NOT_A_NAME.has(found) ? found : null;
	}

	/** Original name of a token: the map's `names` at its exact position;
	 * else the generated name when it isn't mangled; else the identifier
	 * at the mapped position in `sourcesContent`. Null when unknown. */
	resolve(token: NameToken): string | null {
		if (token.literal) return token.name;
		const segment = this.segmentAt(token.offset);
		if (segment && segment.name >= 0) {
			const name = this.names[segment.name];
			if (typeof name === "string" && name) return name;
		}
		if (!looksMangled(token.name)) return token.name;
		return segment ? this.identifierAt(segment, IDENTIFIER_AT_RE) : null;
	}

	/** The name a minifier removed from `function name() {}`, read from the
	 * original source at the function's mapped start. */
	recover(offset: number): string | null {
		const segment = this.segmentAt(offset);
		return segment ? this.identifierAt(segment, OWN_NAME_AT_RE, 1) : null;
	}
}

// ── Encoding ──────────────────────────────────────────────────────────────

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
	let rest = value < 0 ? (-value << 1) | 1 : value << 1;
	let out = "";
	do {
		let digit = rest & 31;
		rest >>>= 5;
		if (rest > 0) digit |= 32;
		out += BASE64_DIGITS[digit];
	} while (rest > 0);
	return out;
}

/** Scopes sorted by start, as the `scopes` string (see SourceMapScopes). */
function encodeScopes(entries: readonly ScopeEntry[]): string {
	const parts: string[] = [];
	let line = 0;
	let previousStart = 0;
	let previousName = 0;
	let firstOnLine = true;
	for (const [startLine, startColumn, endLine, endColumn, nameIndex] of entries) {
		if (startLine > line) {
			parts.push(";".repeat(startLine - line));
			line = startLine;
			previousStart = 0;
			firstOnLine = true;
		}
		if (!firstOnLine) parts.push(",");
		firstOnLine = false;
		let segment =
			vlq(startColumn - previousStart) +
			vlq(endLine - startLine) +
			vlq(endLine === startLine ? endColumn - startColumn : endColumn);
		previousStart = startColumn;
		if (nameIndex >= 0) {
			segment += vlq(nameIndex - previousName);
			previousName = nameIndex;
		}
		parts.push(segment);
	}
	return parts.join("");
}

// ── Entry point ───────────────────────────────────────────────────────────

/**
 * The function scopes of `code` (the bundle exactly as served), named
 * through its source map. Never throws: a bundle that does not parse, or a
 * map without string `mappings`, gives `{ error }` (an upload then goes
 * ahead without scopes).
 */
export function computeScopes(code: string, map: Record<string, unknown>): ScopesResult {
	try {
		return scopesOf(code, map);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function scopesOf(code: string, map: Record<string, unknown>): ScopesResult {
	if (typeof map.mappings !== "string") return { error: "the map has no mappings string" };
	let functions: FunctionScope[];
	try {
		functions = collectFunctions(parseBundle(code));
	} catch (err) {
		return { error: `could not parse the bundle: ${err instanceof Error ? err.message : String(err)}` };
	}
	const starts = lineStarts(code);
	const wanted = new Map<number, Map<number, Segment | null>>();
	const want = (offset: number) => {
		const [line, column] = positionOf(starts, offset);
		let columns = wanted.get(line);
		if (!columns) wanted.set(line, (columns = new Map()));
		columns.set(column, null);
	};
	for (const fn of functions) {
		if (fn.own && !fn.own.literal) want(fn.own.offset);
		if (fn.recoverAt !== null) want(fn.recoverAt);
		for (const token of fn.context) if (!token.literal) want(token.offset);
	}
	try {
		findSegments(map.mappings, wanted);
	} catch (err) {
		return { error: `could not read the map: ${err instanceof Error ? err.message : String(err)}` };
	}
	const resolver = new NameResolver(map, (offset) => {
		const [line, column] = positionOf(starts, offset);
		return wanted.get(line)?.get(column) ?? null;
	});

	functions.sort((a, b) => a.start - b.start || b.end - a.end);
	// Name indexes continue the map's own `names`, which already hold most
	// original names; only the others are stored in `extraNames`.
	const mapNames = Array.isArray(map.names) ? map.names : [];
	const nameIndex = new Map<string | null, number>();
	mapNames.forEach((name, index) => {
		if (typeof name === "string" && !nameIndex.has(name)) nameIndex.set(name, index);
	});
	const extraNames: Array<string | null> = [];
	const indexOf = (name: string | null): number => {
		let index = nameIndex.get(name);
		if (index === undefined) {
			index = mapNames.length + extraNames.push(name) - 1;
			nameIndex.set(name, index);
		}
		return index;
	};
	const entries: ScopeEntry[] = functions.map((fn) => {
		let name = fn.own ? resolver.resolve(fn.own) : null;
		if (name === null && fn.recoverAt !== null) name = resolver.recover(fn.recoverAt);
		for (const token of fn.context) {
			if (name !== null) break;
			name = resolver.resolve(token);
		}
		// A named function whose name could not be mapped back gets the
		// `null` name; one with no name at all is anonymous (-1).
		const index = name !== null ? indexOf(name) : fn.own || fn.context.length > 0 ? indexOf(null) : -1;
		const [startLine, startColumn] = positionOf(starts, fn.start);
		const [endLine, endColumn] = positionOf(starts, fn.end);
		return [startLine, startColumn, endLine, endColumn, index];
	});
	return { scopes: { version: SCOPES_VERSION, names: extraNames, scopes: encodeScopes(entries) } };
}
