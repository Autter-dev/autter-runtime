/**
 * Small, AST-checked edits to bundler config files for `sourcemaps setup`.
 *
 * Files are parsed with acorn (JavaScript) or acorn + @sveltejs/acorn-typescript
 * (TypeScript), and changed by splicing text at node positions, so the rest of
 * the file keeps its formatting and comments. An edit is only made when the
 * config has a shape we recognise (an object literal reached through
 * `export default` / `module.exports`, a `defineConfig(...)` call, a config
 * variable, or a function that returns an object literal); anything else
 * returns a reason and the caller emits a manual action instead. The result is
 * parsed again before it is used.
 */
import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";

// ESTree nodes as acorn returns them (plus the TypeScript plugin's node types).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNode = { type: string; start: number; end: number } & Record<string, any>;

const TsParser = Parser.extend(tsPlugin());

export const isTypeScriptFile = (file: string): boolean => /\.[cm]?tsx?$/.test(file);

/** The file's AST, or null when it does not parse (we then never edit it). */
export function parseFile(code: string, file: string): AnyNode | null {
	const parser = isTypeScriptFile(file) ? TsParser : Parser;
	for (const sourceType of ["module", "script"] as const) {
		const comments: Array<{ start: number; end: number }> = [];
		try {
			const ast = parser.parse(code, {
				ecmaVersion: "latest",
				sourceType,
				locations: true,
				allowHashBang: true,
				onComment: (_block, _text, start, end) => comments.push({ start, end }),
			}) as unknown as AnyNode;
			ast.comments = comments;
			return ast;
		} catch {
			// try the next source type
		}
	}
	return null;
}

/** Every node under `node`, depth first. */
export function walk(node: unknown, visit: (node: AnyNode) => void): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	const n = node as AnyNode;
	if (typeof n.type !== "string") return;
	visit(n);
	for (const key of Object.keys(n)) {
		if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
		const value = n[key];
		if (value && typeof value === "object") walk(value, visit);
	}
}

const TS_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ParenthesizedExpression"]);

/** `x as T`, `x satisfies T`, `x!`, `(x)` → x. */
export function unwrap(node: AnyNode | null | undefined): AnyNode | null {
	let n = node ?? null;
	while (n && TS_WRAPPERS.has(n.type)) n = n.expression as AnyNode;
	return n;
}

const isModuleExports = (node: AnyNode | null): boolean =>
	!!node &&
	node.type === "MemberExpression" &&
	!node.computed &&
	node.object?.type === "Identifier" &&
	node.object.name === "module" &&
	node.property?.type === "Identifier" &&
	node.property.name === "exports";

export interface ExportSite {
	kind: "esm" | "cjs";
	/** The exported expression (as written, TypeScript wrappers included). */
	expr: AnyNode;
}

/** The file's one `export default <expr>` or `module.exports = <expr>`. */
export function findExport(ast: AnyNode): ExportSite | { error: string } {
	const sites: ExportSite[] = [];
	for (const statement of ast.body as AnyNode[]) {
		if (statement.type === "ExportDefaultDeclaration") {
			const declaration = statement.declaration as AnyNode;
			if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
				return { error: "the default export is a function or class declaration" };
			}
			sites.push({ kind: "esm", expr: declaration });
		} else if (
			statement.type === "ExpressionStatement" &&
			statement.expression.type === "AssignmentExpression" &&
			statement.expression.operator === "=" &&
			isModuleExports(statement.expression.left)
		) {
			sites.push({ kind: "cjs", expr: statement.expression.right });
		}
	}
	if (sites.length === 0) return { error: "no `export default` or `module.exports =` found" };
	if (sites.length > 1) return { error: "the config is exported more than once" };
	return sites[0]!;
}

/** The initializer of a top-level `const|let|var name = …`, when `name` is
 * never reassigned. */
export function resolveBinding(ast: AnyNode, name: string): AnyNode | null {
	let init: AnyNode | null = null;
	for (const statement of ast.body as AnyNode[]) {
		const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
		if (declaration?.type !== "VariableDeclaration") continue;
		for (const declarator of declaration.declarations as AnyNode[]) {
			if (declarator.id?.type === "Identifier" && declarator.id.name === name) init = declarator.init ?? null;
		}
	}
	if (!init) return null;
	let reassigned = false;
	walk(ast, (node) => {
		if (node.type === "AssignmentExpression" && node.left?.type === "Identifier" && node.left.name === name) reassigned = true;
	});
	return reassigned ? null : init;
}

/** The object a function returns, when it returns exactly one object literal. */
function returnedObject(fn: AnyNode): AnyNode | null {
	const body = fn.body as AnyNode;
	if (body.type !== "BlockStatement") {
		const value = unwrap(body);
		return value?.type === "ObjectExpression" ? value : null;
	}
	const returns: AnyNode[] = [];
	walk(body, (node) => {
		if (node.type === "ReturnStatement") returns.push(node);
	});
	// Returns inside nested functions count too: refuse rather than guess.
	if (returns.length !== 1) return null;
	const last = (body.body as AnyNode[]).at(-1);
	if (last !== returns[0]) return null;
	const value = unwrap(returns[0]!.argument);
	return value?.type === "ObjectExpression" ? value : null;
}

/**
 * The config object behind an exported expression: an object literal,
 * `defineConfig({...})` (any `define…Config`), a top-level variable holding
 * one, or a (possibly `define…Config`-wrapped) function that returns one.
 */
export function configObject(ast: AnyNode, expr: AnyNode | null, depth = 0): AnyNode | null {
	const node = unwrap(expr);
	if (!node || depth > 4) return null;
	switch (node.type) {
		case "ObjectExpression":
			return node;
		case "Identifier": {
			const init = resolveBinding(ast, node.name);
			return init ? configObject(ast, init, depth + 1) : null;
		}
		case "CallExpression":
			if (node.callee?.type === "Identifier" && /^define\w*Config$/.test(node.callee.name) && node.arguments.length === 1) {
				return configObject(ast, node.arguments[0], depth + 1);
			}
			return null;
		case "ArrowFunctionExpression":
		case "FunctionExpression":
			return returnedObject(node);
		default:
			return null;
	}
}

/** A non-computed `name: value` property of an object literal. */
export function findProperty(obj: AnyNode, name: string): AnyNode | null | "ambiguous" {
	const matches = (obj.properties as AnyNode[]).filter(
		(p) =>
			p.type === "Property" &&
			!p.computed &&
			((p.key.type === "Identifier" && p.key.name === name) || (p.key.type === "Literal" && p.key.value === name)),
	);
	if (matches.length > 1) return "ambiguous";
	const [match] = matches;
	if (!match) return null;
	if (match.kind !== "init" || match.method) return "ambiguous";
	return match;
}

/** A literal property value (string, number, boolean), or undefined. */
export function literalProperty(obj: AnyNode | null, path: string[]): string | number | boolean | null | undefined {
	let node: AnyNode | null = obj;
	for (const [i, name] of path.entries()) {
		if (!node || node.type !== "ObjectExpression") return undefined;
		const property = findProperty(node, name);
		if (!property || property === "ambiguous") return undefined;
		node = unwrap(property.value);
		if (i === path.length - 1) {
			if (node?.type === "Literal" && (typeof node.value !== "object" || node.value === null)) return node.value as string | number | boolean | null;
			if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked as string;
			return undefined;
		}
	}
	return undefined;
}

export interface Edit {
	start: number;
	end: number;
	text: string;
}

export function applyEdits(code: string, edits: Edit[]): string {
	let out = code;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
	return out;
}

function lineIndent(code: string, pos: number): string {
	const lineStart = code.lastIndexOf("\n", pos - 1) + 1;
	return /^[ \t]*/.exec(code.slice(lineStart))![0];
}

const spansLines = (code: string, node: AnyNode) => code.slice(node.start, node.end).includes("\n");

/** Insert `text` after `last`, the final item of a list inside `container`:
 * on its own line in a multi-line list (after a trailing comma and a comment
 * on that line, keeping the trailing-comma style), else `, text`. */
function appendAfter(code: string, container: AnyNode, last: AnyNode, text: string): Edit {
	if (!spansLines(code, container)) return { start: last.end, end: last.end, text: `, ${text}` };
	const indent = lineIndent(code, last.start);
	const trailing = /^[^\S\n]*,[^\S\n]*(?:\/\/[^\n]*|\/\*[^\n]*?\*\/)?[^\S\n]*(?=\n)/.exec(code.slice(last.end, container.end));
	if (trailing) {
		const at = last.end + trailing[0].length;
		return { start: at, end: at, text: `\n${indent}${text},` };
	}
	return { start: last.end, end: last.end, text: `,\n${indent}${text}` };
}

/** Append `text` as the last element of an array literal. */
function appendElement(code: string, array: AnyNode, text: string): Edit {
	const elements = (array.elements as Array<AnyNode | null>).filter((e): e is AnyNode => !!e);
	const last = elements.at(-1);
	if (!last) {
		const inner = code.slice(array.start + 1, array.end - 1);
		return inner.trim() === "" ? { start: array.start + 1, end: array.end - 1, text } : { start: array.end - 1, end: array.end - 1, text };
	}
	return appendAfter(code, array, last, text);
}

/** Add `text` (`key: value`) as the last property of an object literal. */
function appendProperty(code: string, obj: AnyNode, text: string): Edit | null {
	const last = (obj.properties as AnyNode[]).at(-1);
	if (!last) {
		if (code.slice(obj.start + 1, obj.end - 1).trim() !== "") return null;
		return { start: obj.start, end: obj.end, text: `{ ${text} }` };
	}
	return appendAfter(code, obj, last, text);
}

/**
 * Edit that puts `element` into `obj.plugins` (under `container` first, e.g.
 * Nuxt's and Astro's `vite`, Vue CLI's `configureWebpack`), creating the
 * array or the container when absent.
 */
export function addPluginEdit(code: string, obj: AnyNode, element: string, container?: string): Edit | { error: string } {
	let target = obj;
	if (container) {
		const property = findProperty(obj, container);
		if (property === "ambiguous") return { error: `\`${container}\` is defined more than once or as a method` };
		if (!property) {
			if ((obj.properties as AnyNode[]).some((p) => p.type === "SpreadElement")) {
				return { error: `the config spreads another object, which may already set \`${container}\`` };
			}
			return appendProperty(code, obj, `${container}: { plugins: [${element}] }`) ?? { error: "the config object holds only comments" };
		}
		const value = unwrap(property.value);
		if (value?.type !== "ObjectExpression") return { error: `\`${container}\` is not an object literal` };
		target = value;
	}
	const plugins = findProperty(target, "plugins");
	if (plugins === "ambiguous") return { error: "`plugins` is defined more than once or as a method" };
	if (!plugins) {
		if ((target.properties as AnyNode[]).some((p) => p.type === "SpreadElement")) {
			return { error: "the config spreads another object, which may already set `plugins`" };
		}
		return appendProperty(code, target, `plugins: [${element}]`) ?? { error: "the config object holds only comments" };
	}
	const value = unwrap(plugins.value);
	if (value?.type !== "ArrayExpression") return { error: "`plugins` is not an array literal" };
	return appendElement(code, value, element);
}

/** The `require("…")` call at the head of an initializer such as
 * `require("x")`, `require("x").default` or `require("x")(options)`. */
function requireCall(init: AnyNode | null): AnyNode | null {
	let node = unwrap(init);
	while (node) {
		if (node.type === "CallExpression") {
			if (node.callee?.type === "Identifier" && node.callee.name === "require") return node;
			node = unwrap(node.callee);
		} else if (node.type === "MemberExpression") node = unwrap(node.object);
		else return null;
	}
	return null;
}

/** Where and how to add `import { name } from "spec"` (or a require):
 * after the last import (or require), in its quote and semicolon style,
 * else before the first statement. */
export function importEdit(code: string, ast: AnyNode, name: string, spec: string, kind: "esm" | "cjs"): Edit {
	const body = ast.body as AnyNode[];
	let last: AnyNode | undefined;
	let source: AnyNode | null = null;
	if (kind === "esm") {
		last = body.filter((s) => s.type === "ImportDeclaration").at(-1);
		source = last?.source ?? null;
	} else {
		last = body
			.filter((s) => s.type === "VariableDeclaration" && (s.declarations as AnyNode[]).every((d) => requireCall(d.init)))
			.at(-1);
		source = last ? (requireCall(last.declarations[0].init)?.arguments[0] ?? null) : null;
	}
	const quote = source && code[source.start] === "'" ? "'" : '"';
	const semi = last ? (code[last.end - 1] === ";" ? ";" : "") : ";";
	const line = kind === "esm" ? `import { ${name} } from ${quote}${spec}${quote}${semi}` : `const { ${name} } = require(${quote}${spec}${quote})${semi}`;
	if (last) return { start: last.end, end: last.end, text: `\n${line}` };
	const first = body.find((s) => !(s.type === "ExpressionStatement" && typeof s.directive === "string"));
	if (!first) return { start: code.length, end: code.length, text: `${code.endsWith("\n") || !code ? "" : "\n"}${line}\n` };
	// Above the comments attached to the first statement (a JSDoc type, a
	// docs link), which must stay next to it.
	let at = first.start;
	const comments = ((ast.comments ?? []) as Array<{ start: number; end: number }>).filter((c) => c.end <= first.start);
	for (let i = comments.length - 1; i >= 0; i--) {
		const gap = code.slice(comments[i]!.end, at);
		if (gap.trim() !== "" || (gap.match(/\n/g) ?? []).length > 1) break;
		at = comments[i]!.start;
	}
	at = code.lastIndexOf("\n", at - 1) + 1;
	return { start: at, end: at, text: `${line}\n\n` };
}

export type EditResult =
	| { status: "edited"; code: string }
	| { status: "already"; note?: string }
	| { status: "manual"; reason: string };

/** Whether `name` is called (or constructed) anywhere in the file. */
function calls(ast: AnyNode, name: string): AnyNode[] {
	const found: AnyNode[] = [];
	walk(ast, (node) => {
		if ((node.type === "CallExpression" || node.type === "NewExpression") && node.callee?.type === "Identifier" && node.callee.name === name) {
			found.push(node);
		}
	});
	return found;
}

function finish(original: string, file: string, edits: Edit[], name: string): EditResult {
	const code = applyEdits(original, edits);
	const ast = parseFile(code, file);
	if (!ast || calls(ast, name).length === 0) return { status: "manual", reason: "the edited file did not parse back as expected" };
	return { status: "edited", code };
}

/**
 * Add a bundler plugin (Vite/Rollup `autterSourceMaps()`, webpack
 * `new AutterSourceMapsWebpackPlugin()`) to a config file.
 */
export function addBundlerPlugin(
	code: string,
	file: string,
	plugin: { name: string; spec: string; element: string; container?: string },
): EditResult {
	const ast = parseFile(code, file);
	if (!ast) return { status: "manual", reason: `${file} does not parse as ${isTypeScriptFile(file) ? "TypeScript" : "JavaScript"}` };
	if (calls(ast, plugin.name).length) return { status: "already" };
	if (code.includes(plugin.spec)) return { status: "manual", reason: `${file} imports ${plugin.spec} but never uses ${plugin.name}` };
	const site = findExport(ast);
	if ("error" in site) return { status: "manual", reason: site.error };
	const obj = configObject(ast, site.expr);
	if (!obj) return { status: "manual", reason: "the exported config is not an object literal, a define…Config({...}) call, a variable holding one, or a function returning one" };
	const edit = addPluginEdit(code, obj, plugin.element, plugin.container);
	if ("error" in edit) return { status: "manual", reason: edit.error };
	return finish(code, file, [edit, importEdit(code, ast, plugin.name, plugin.spec, site.kind)], plugin.name);
}

const NEXT_WRAPPABLE = new Set(["ObjectExpression", "Identifier", "CallExpression", "ArrowFunctionExpression", "FunctionExpression", "MemberExpression"]);

/** Wrap a Next.js config's export in `withAutterSourceMaps(...)`, outermost. */
export function wrapNextConfig(code: string, file: string): EditResult {
	const name = "withAutterSourceMaps";
	const spec = "@autter/runtime-cli/next";
	const ast = parseFile(code, file);
	if (!ast) return { status: "manual", reason: `${file} does not parse as ${isTypeScriptFile(file) ? "TypeScript" : "JavaScript"}` };
	const site = findExport(ast);
	const existing = calls(ast, name);
	if (existing.length) {
		if (!("error" in site) && unwrap(site.expr) === existing[0]) return { status: "already" };
		return {
			status: "manual",
			reason: `${name} is not the outermost wrapper of the exported config, so other wrappers' webpack and runAfterProductionCompile hooks may not be chained`,
		};
	}
	if (code.includes(spec)) return { status: "manual", reason: `${file} imports ${spec} but never calls ${name}` };
	if ("error" in site) return { status: "manual", reason: site.error };
	const target = unwrap(site.expr);
	if (!target || !NEXT_WRAPPABLE.has(target.type)) {
		return { status: "manual", reason: "the exported config is not an object, a variable, a wrapper call or a function" };
	}
	const edits: Edit[] = [
		{ start: site.expr.start, end: site.expr.start, text: `${name}(` },
		{ start: site.expr.end, end: site.expr.end, text: ")" },
		importEdit(code, ast, name, spec, site.kind),
	];
	return finish(code, file, edits, name);
}

/** The config object of a Next.js config, looking through wrapper calls. */
export function nextConfigObject(ast: AnyNode): AnyNode | null {
	const site = findExport(ast);
	if ("error" in site) return null;
	let node = unwrap(site.expr);
	for (let depth = 0; node && depth < 6; depth++) {
		const obj = configObject(ast, node);
		if (obj) return obj;
		if (node.type === "CallExpression" && node.arguments.length) node = unwrap(node.arguments[0]);
		else return null;
	}
	return null;
}

/** The config object of a Vite/webpack/Rollup config file, or null. */
export function exportedConfigObject(ast: AnyNode): AnyNode | null {
	const site = findExport(ast);
	return "error" in site ? null : configObject(ast, site.expr);
}
