// Function scopes (x_autter_scopes): computed by `upload` on the bundle as
// served, named through its source map, and used by the ingester to name
// each frame after the function it is in.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { computeScopes, injectDir, MAX_MAP_CHARS, SCOPES_KEY, uploadDir } from "../dist/index.js";
import { framesV3Fingerprint } from "../../otlp-ingester/dist/fingerprint-v3.js";
import { ScopeIndex } from "../../otlp-ingester/dist/source-map-scopes.js";
import { parseStackFrames } from "../../otlp-ingester/dist/stack-frames.js";
import { SourceMapCache, Symbolicator } from "../../otlp-ingester/dist/symbolicate.js";
import { read, readJson, SERVER_KEY, SIMPLE_MAP, startIngester, tempDir } from "./helpers.mjs";

const quiet = { log: () => {} };

/** Bundle `entry` of `files` with esbuild, minified, with a source map
 * (sourcesContent included, as esbuild writes it by default). */
async function bundle(files, { entry = "src/main.js", format = "esm", outfile = "assets/app.js", globalName } = {}) {
	const dir = tempDir(files);
	await build({
		entryPoints: [join(dir, entry)],
		outfile: join(dir, "dist", outfile),
		bundle: true,
		minify: true,
		sourcemap: true,
		format,
		...(globalName ? { globalName } : {}),
		logLevel: "silent",
	});
	return { root: dir, dir: join(dir, "dist"), js: outfile, map: `${outfile}.map` };
}

/**
 * Name of the function around `marker` in `code`, as the ingester reads the
 * scopes (its own decoder, so the CLI's encoding is checked against it): a
 * string, null (anonymous or top-level), or "<unknown>".
 */
function nameAround(code, scopes, map, marker) {
	const index = ScopeIndex.from(scopes, map.names ?? []);
	assert.ok(index, "the ingester accepts the scopes");
	const offset = code.indexOf(marker);
	assert.ok(offset >= 0, `marker ${marker} is in the bundle`);
	const before = code.slice(0, offset).split("\n");
	const found = index.nameAt(before.length - 1, before.at(-1).length);
	return found.kind === "named" ? found.name : found.kind === "unknown" ? "<unknown>" : null;
}

/** Every marker's name. */
const namesAround = (code, scopes, map) =>
	Object.fromEntries(Object.keys(EXPECTED).map((marker) => [marker, nameAround(code, scopes, map, marker)]));

// Each function holds a marker string, which survives minification.
const CONSTRUCTS = {
	"src/main.js": `
export function computeTotal(cart) {
  if (!cart) throw new Error("@function-declaration");
  return cart.items.length;
}
export const formatPrice = (value) => {
  if (value == null) throw new TypeError("@const-arrow");
  return "$" + value.toFixed(2);
};
export const actions = {
  captured() {
    throw new Error("@object-method");
  },
  refunded: function () {
    throw new Error("@object-function");
  },
};
export async function runAction(name) {
  const run = actions[name];
  await run("@calls-through-a-variable");
}
export class Cart {
  total = computeTotal({ items: ["@field-initializer"] });
  constructor(items) {
    if (!items) throw new Error("@constructor");
    this.items = items;
  }
  addItem(item) {
    if (!item) throw new Error("@class-method");
    this.items.push(item);
  }
  get size() {
    if (!this.items) throw new Error("@getter");
    return this.items.length;
  }
}
const listeners = [];
export function subscribe(fn) {
  listeners.push(fn);
}
export function dispatch() {
  listeners.forEach((fn) => fn("@dispatcher-arrow"));
}
subscribe(function onPayClick() {
  throw new Error("@inline-named-handler");
});
const onCartClick = () => {
  throw new Error("@const-handler");
};
subscribe(onCartClick);
export function later(callback) {
  [1].forEach(function () {
    callback("@anonymous-callback");
  });
}
export function outer(values) {
  const inner = (value) => {
    if (!value) throw new Error("@nested-arrow");
    return value;
  };
  return values.map(inner).join("@after-nested");
}
console.log("@top-level");
`,
};

const EXPECTED = {
	"@function-declaration": "computeTotal",
	"@const-arrow": "formatPrice",
	"@object-method": "captured",
	"@object-function": "refunded",
	"@calls-through-a-variable": "runAction",
	"@constructor": "Cart",
	// Runs in V8's <instance_members_initializer>, not in the code around the class.
	"@field-initializer": "Cart",
	"@class-method": "addItem",
	"@getter": "size",
	// The React-like dispatcher's `(fn) => fn()` and a callback are anonymous.
	"@dispatcher-arrow": null,
	// esbuild drops the unused name of `function onPayClick() {}`; it is read
	// back from sourcesContent at the function's mapped start.
	"@inline-named-handler": "onPayClick",
	"@const-handler": "onCartClick",
	"@anonymous-callback": null,
	"@nested-arrow": "inner",
	"@after-nested": "outer",
	"@top-level": null,
};

test("every kind of function maps to its original name through a minified esbuild bundle", async () => {
	const out = await bundle(CONSTRUCTS);
	const code = read(out.dir, out.js);
	const map = readJson(out.dir, out.map);
	assert.ok(!code.includes("function computeTotal") && !code.includes("\n  "), "the bundle is minified");
	const result = computeScopes(code, map);
	assert.ok("scopes" in result, result.error);
	assert.deepEqual(namesAround(code, result.scopes, map), EXPECTED);
	// Compact: a VLQ string, and only names the map's own `names` lacks
	// (computeTotal, formatPrice, Cart… are there already), each once.
	const { scopes, names } = result.scopes;
	assert.match(scopes, /^[A-Za-z0-9+/,;]+$/);
	assert.equal(new Set(names).size, names.length);
	assert.ok(names.every((name) => !map.names.includes(name)));
	assert.ok(names.includes("captured") && names.includes("onPayClick") && !names.includes("computeTotal"));
	assert.equal(ScopeIndex.from(result.scopes, map.names).size, 18);
	assert.ok(scopes.length < 18 * 10, scopes);
});

test("without `names`, minified names are read from sourcesContent; without either they are unknown", async () => {
	const out = await bundle(CONSTRUCTS);
	const code = read(out.dir, out.js);
	const { names: _names, ...noNames } = readJson(out.dir, out.map);
	const fromSources = computeScopes(code, noNames);
	assert.deepEqual(namesAround(code, fromSources.scopes, noNames), EXPECTED);
	const { sourcesContent: _content, ...bare } = noNames;
	const blind = computeScopes(code, bare);
	const names = namesAround(code, blind.scopes, bare);
	// Keys and properties are never minified; mangled bindings are unknown
	// (the ingester keeps their call-site names), not guessed.
	assert.equal(names["@object-method"], "captured");
	assert.equal(names["@class-method"], "addItem");
	assert.equal(names["@getter"], "size");
	assert.equal(names["@function-declaration"], "<unknown>");
	assert.equal(names["@const-handler"], "<unknown>");
	assert.equal(names["@inline-named-handler"], null);
	assert.equal(names["@anonymous-callback"], null);
});

test("scopes parse scripts, shebangs and the injected debug-id line; positions are those of the final file", async () => {
	// Line 1, columns 15 to 34, named "named" (index 0 of the extra names).
	const script = computeScopes("#!/usr/bin/env node\nwith (x) { y = function named() {}; }\n", { version: 3, sources: [], names: [], mappings: "" });
	assert.deepEqual(script, { scopes: { version: 1, names: ["named"], scopes: ";eAmBA" } });

	const out = await bundle(CONSTRUCTS);
	const beforeCode = read(out.dir, out.js);
	const beforeMap = readJson(out.dir, out.map);
	const before = computeScopes(beforeCode, beforeMap).scopes;
	await injectDir(out.dir);
	const code = read(out.dir, out.js);
	const map = readJson(out.dir, out.map);
	const after = computeScopes(code, map).scopes;
	// Everything moved down one line (the snippet's) and kept its name; the
	// snippet is an anonymous function of its own.
	assert.ok(code.startsWith(";!function(){") && !beforeCode.startsWith(";!"));
	assert.deepEqual(namesAround(code, after, map), EXPECTED);
	assert.equal(ScopeIndex.from(after, map.names).size, ScopeIndex.from(before, beforeMap.names).size + 1);
	assert.equal(ScopeIndex.from(after, map.names).nameAt(0, code.indexOf("try")).kind, "anonymous");
});

test("a bundle that does not parse is uploaded without scopes, with a warning", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const dir = tempDir({ "broken.js": "function (\n", "broken.js.map": SIMPLE_MAP, "ok.js": "function okay() {}\n", "ok.js.map": SIMPLE_MAP });
	const warnings = [];
	const summary = await uploadDir(dir, { release: "r1", endpoint: ingester.url, key: SERVER_KEY, log: (line) => warnings.push(line) });
	assert.equal(summary.uploaded.length, 2);
	assert.deepEqual(summary.failed, []);
	assert.match(warnings.join("\n"), /broken\.js: no function scopes \(could not parse the bundle: Unexpected token/);
	const stored = Object.fromEntries(ingester.rows.map((row) => [row.filename, JSON.parse(row.map)]));
	assert.equal(SCOPES_KEY in stored["/broken.js"], false);
	assert.deepEqual(stored["/ok.js"][SCOPES_KEY], { version: 1, names: ["okay"], scopes: "AAkBA" });
});

test("scopes already in a map are replaced by the ones computed from the served file", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const stale = { version: 1, names: ["stale"], scopes: "AAmGA" };
	const dir = tempDir({ "a.js": "x()\n", "a.js.map": { ...SIMPLE_MAP, [SCOPES_KEY]: stale } });
	await uploadDir(dir, { ...quiet, release: "r1", endpoint: ingester.url, key: SERVER_KEY });
	assert.deepEqual(JSON.parse(ingester.rows[0].map)[SCOPES_KEY], { version: 1, names: [], scopes: "" });
});

test("a map that only fits the 32 MB limit without scopes is uploaded without them", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const functions = Array.from({ length: 2000 }, (_, i) => `function handler${i}() {}`).join("\n");
	const { sourcesContent: _content, ...stored } = SIMPLE_MAP;
	// 1000 characters short of the limit without scopes; 2000 scopes don't fit.
	const padding = MAX_MAP_CHARS - JSON.stringify({ ...stored, names: [""] }).length - 1000;
	const dir = tempDir({ "big.js": `${functions}\n`, "big.js.map": { ...SIMPLE_MAP, names: ["n".repeat(padding)] } });
	const warnings = [];
	const summary = await uploadDir(dir, { release: "r1", endpoint: ingester.url, key: SERVER_KEY, log: (line) => warnings.push(line) });
	assert.equal(summary.uploaded.length, 1);
	assert.match(warnings.join("\n"), /big\.js: its map is over 32 MB with function scopes, so it is uploaded without them/);
	assert.equal(SCOPES_KEY in JSON.parse(ingester.rows[0].map), false);
});

// ── End to end: esbuild → inject → upload → a real V8 stack → ingester ─────

const APP = {
	"src/main.js": `
import "./handlers.js";
export { actions, runAction } from "./actions.js";
export { dispatch } from "./events.js";
`,
	"src/actions.js": `
export const actions = {
  captured() {
    throw new Error("payment failed");
  },
  refunded() {
    throw new Error("payment failed");
  },
};

export async function runAction(name) {
  const run = actions[name];
  await run();
}
`,
	"src/events.js": `
const listeners = {};

export function subscribe(type, fn) {
  (listeners[type] ||= []).push(fn);
}

// What a framework does: the handler is called as \`fn\`.
export function dispatch(type) {
  listeners[type].forEach((fn) => fn());
}
`,
	"src/handlers.js": `
import { subscribe } from "./events.js";
import { formatPrice } from "./format.js";

subscribe("pay", function onPayClick() {
  formatPrice(null);
});

const onCartClick = () => {
  formatPrice(undefined);
};
subscribe("cart", onCartClick);
`,
	"src/format.js": `
export function formatPrice(value) {
  if (value == null) throw new TypeError("no price");
  return "$" + value.toFixed(2);
}
`,
};

const SCRIPT_URL = "https://app.example.com/assets/app-5f3a9c1e.js";
const SCOPE = { orgId: "org-a", repositoryId: "repo-a", release: "e2e-1" };

/** Run the served bundle in a fresh V8 context and capture the stacks the
 * browser SDK would send. */
async function captureStacks(code) {
	const context = vm.createContext({});
	vm.runInContext(code, context, { filename: SCRIPT_URL });
	const stackOf = async (source) => {
		try {
			await vm.runInContext(source, context, { filename: "https://app.example.com/index.html" });
		} catch (err) {
			return err.stack;
		}
		throw new Error(`${source} did not throw`);
	};
	return {
		captured: await stackOf('app.runAction("captured")'),
		refunded: await stackOf('app.runAction("refunded")'),
		pay: await stackOf('app.dispatch("pay")'),
		cart: await stackOf('app.dispatch("cart")'),
	};
}

async function symbolicate(map, stack) {
	const symbolicator = new Symbolicator(async (key) => (key.filename === "/assets/app-5f3a9c1e.js" ? map : null));
	const frames = await symbolicator.symbolicate(parseStackFrames(stack), SCOPE);
	return frames.filter((frame) => frame.resolved);
}

const describeFrames = (frames) => frames.map((frame) => `${frame.function ?? "<anonymous>"} ${frame.filename.split("/").pop()}:${frame.lineno}`);
const fingerprint = (frames, errorType) =>
	framesV3Fingerprint({ service: "web", errorType, message: "m", frames });

test("end to end: minified bundle, inject, upload, real V8 stacks — frames are named by the function they are in", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const out = await bundle(APP, { format: "iife", globalName: "app", outfile: "assets/app-5f3a9c1e.js" });
	await injectDir(out.dir);
	const summary = await uploadDir(out.dir, { ...quiet, release: SCOPE.release, endpoint: ingester.url, key: SERVER_KEY });
	assert.deepEqual(summary.failed, []);
	const [row] = ingester.rows;
	const stored = JSON.parse(row.map);
	assert.ok(stored[SCOPES_KEY].scopes.length > 0, "the stored map carries scopes");
	const { [SCOPES_KEY]: _scopes, ...unscoped } = stored;
	const before = JSON.stringify(unscoped);
	const after = row.map;

	const stacks = await captureStacks(read(out.dir, out.js));
	const resolved = {};
	for (const [name, stack] of Object.entries(stacks)) {
		resolved[name] = { before: await symbolicate(before, stack), after: await symbolicate(after, stack) };
	}
	const names = (frames) => frames.map((frame) => frame.function);

	// `const run = actions[name]; await run()`.
	assert.deepEqual(names(resolved.captured.before), ["run", null]);
	assert.deepEqual(names(resolved.captured.after), ["captured", "runAction"]);
	assert.deepEqual(names(resolved.refunded.after), ["refunded", "runAction"]);
	// listeners.forEach((fn) => fn()): the handler was named `fn`.
	assert.deepEqual(names(resolved.pay.before), ["formatPrice", "fn", null, null]);
	assert.deepEqual(names(resolved.pay.after), ["formatPrice", "onPayClick", null, "dispatch"]);
	assert.deepEqual(names(resolved.cart.after), ["formatPrice", "onCartClick", null, "dispatch"]);
	// Original files and lines are unaffected by naming.
	assert.deepEqual(describeFrames(resolved.pay.after), [
		"formatPrice format.js:3",
		"onPayClick handlers.js:6",
		"<anonymous> events.js:10",
		"dispatch events.js:10",
	]);
	assert.deepEqual(
		describeFrames(resolved.pay.before).map((line) => line.split(" ")[1]),
		describeFrames(resolved.pay.after).map((line) => line.split(" ")[1]),
	);

	// frames-v3: call-site names merged two different bugs into one issue
	// each; scope names keep them apart.
	const v3 = (key, when, type) => fingerprint(resolved[key][when], type).fingerprint;
	assert.equal(v3("captured", "before", "Error"), v3("refunded", "before", "Error"));
	assert.notEqual(v3("captured", "after", "Error"), v3("refunded", "after", "Error"));
	assert.equal(v3("pay", "before", "TypeError"), v3("cart", "before", "TypeError"));
	assert.notEqual(v3("pay", "after", "TypeError"), v3("cart", "after", "TypeError"));
	assert.deepEqual(fingerprint(resolved.pay.after, "TypeError").record.parts, [
		"TypeError",
		"formatPrice@format.js",
		"onPayClick@handlers.js",
		"@events.js",
		"dispatch@events.js",
	]);

	// A re-run uploads nothing: the scopes are deterministic, so the hash is too.
	const again = await uploadDir(out.dir, { ...quiet, release: SCOPE.release, endpoint: ingester.url, key: SERVER_KEY });
	assert.equal(again.skipped.length, 1);
	t.diagnostic(
		Object.entries(resolved)
			.map(([key, { before: b, after: a }]) => `${key}: ${JSON.stringify(names(b))} -> ${JSON.stringify(names(a))}`)
			.join("; "),
	);
});

test("end to end: a vendor-sized map over 5 MB uploads gzipped and symbolicates, cached or not", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	// 60 000 handlers called through `const fn = handlers[i]`: ~5 MB of
	// minified code with a ~6.6 MB map.
	const count = 60_000;
	const source =
		Array.from({ length: count }, (_, i) => `function handler${i}(value) {\n  if (value === ${i}) throw new Error("handler failed");\n  return value + ${i};\n}`).join("\n") +
		`\nexport const handlers = [${Array.from({ length: count }, (_, i) => `handler${i}`).join(", ")}];\n` +
		"export function call(i) {\n  const fn = handlers[i];\n  return fn(i);\n}\n";
	const out = await bundle({ "src/main.js": source }, { format: "iife", globalName: "app", outfile: "assets/vendor-5f3a9c1e.js" });
	await injectDir(out.dir);
	const summary = await uploadDir(out.dir, { ...quiet, release: SCOPE.release, endpoint: ingester.url, key: SERVER_KEY });
	assert.deepEqual(summary.failed, []);
	const [row] = ingester.rows;
	assert.ok(row.map.length > 5 * 1024 * 1024, `stored map is ${row.map.length} characters`);
	const [request] = ingester.uploads();
	assert.equal(request.encoding, "gzip");
	assert.ok(request.bytes < row.map.length / 3, `${request.bytes} bytes on the wire`);

	const context = vm.createContext({});
	const url = "https://app.example.com/assets/vendor-5f3a9c1e.js";
	vm.runInContext(read(out.dir, out.js), context, { filename: url });
	let stack = "";
	try {
		vm.runInContext("app.call(54321)", context, { filename: "https://app.example.com/index.html" });
	} catch (err) {
		stack = err.stack;
	}
	const resolve = async (cache) => {
		const symbolicator = new Symbolicator(async (key) => (key.filename === "/assets/vendor-5f3a9c1e.js" ? row.map : null), cache);
		const frames = await symbolicator.symbolicate(parseStackFrames(stack), SCOPE);
		return frames.filter((frame) => frame.resolved).map((frame) => `${frame.function} ${frame.filename.split("/").pop()}:${frame.lineno}`);
	};
	// handler54321 throws on line 54321 × 4 + 2; `return fn(i)` is line 240 004.
	const expected = ["handler54321 main.js:217286", "call main.js:240004"];
	// Default 64 MiB cache: decoded and kept (~20 MB).
	const cached = new SourceMapCache();
	assert.deepEqual(await resolve(cached), expected);
	assert.equal(cached.bypassed, 0);
	assert.ok(cached.bytes > 5 * 1024 * 1024 && cached.bytes < 4 * row.map.length, `${cached.bytes} bytes cached`);
	// A cache too small to keep it: read in one pass, same frames, not kept.
	// (The test runner's own .mjs frames are remembered as misses, at 0 bytes.)
	const small = new SourceMapCache({ maxBytes: 4 * 1024 * 1024 });
	assert.deepEqual(await resolve(small), expected);
	assert.equal(small.bypassed, 1);
	assert.equal(small.bytes, 0);
});
