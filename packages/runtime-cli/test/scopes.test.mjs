// Function scopes (x_autter_scopes): computed by `upload` on the bundle as
// served, named through its source map, and used by the ingester to name
// each frame after the function it is in.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import {
	ANONYMOUS_SCOPE,
	computeScopes,
	injectDir,
	SCOPES_KEY,
	UNKNOWN_SCOPE_NAME,
	uploadDir,
} from "../dist/index.js";
import { framesV3Fingerprint } from "../../otlp-ingester/dist/fingerprint-v3.js";
import { parseStackFrames } from "../../otlp-ingester/dist/stack-frames.js";
import { Symbolicator } from "../../otlp-ingester/dist/symbolicate.js";
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

/** The scope entry innermost around a 0-based (line, column). */
function scopeAt(result, line, column) {
	let best = null;
	for (const entry of result.scopes) {
		const [sl, sc, el, ec] = entry;
		const afterStart = line > sl || (line === sl && column >= sc);
		const beforeEnd = line < el || (line === el && column < ec);
		if (afterStart && beforeEnd && (!best || sl > best[0] || (sl === best[0] && sc >= best[1]))) best = entry;
	}
	return best;
}

/** Name of the function around `marker` in `code`: a string, null (anonymous), or "<unknown>". */
function nameAround(code, result, marker) {
	const offset = code.indexOf(marker);
	assert.ok(offset >= 0, `marker ${marker} is in the bundle`);
	const before = code.slice(0, offset).split("\n");
	const entry = scopeAt(result, before.length - 1, before.at(-1).length);
	if (!entry) return "<top-level>";
	if (entry[4] === ANONYMOUS_SCOPE) return null;
	if (entry[4] === UNKNOWN_SCOPE_NAME) return "<unknown>";
	return result.names[entry[4]];
}

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
	"@top-level": "<top-level>",
};

test("every kind of function maps to its original name through a minified esbuild bundle", async () => {
	const out = await bundle(CONSTRUCTS);
	const code = read(out.dir, out.js);
	const map = readJson(out.dir, out.map);
	assert.ok(!code.includes("function computeTotal") && !code.includes("\n  "), "the bundle is minified");
	const result = computeScopes(code, map);
	assert.ok("scopes" in result, result.error);
	const actual = Object.fromEntries(Object.keys(EXPECTED).map((marker) => [marker, nameAround(code, result.scopes, marker)]));
	assert.deepEqual(actual, EXPECTED);
	// Compact: sorted by start, names stored once.
	const { scopes, names } = result.scopes;
	assert.equal(new Set(names).size, names.length);
	for (let i = 1; i < scopes.length; i++) {
		const [a, b] = [scopes[i - 1], scopes[i]];
		assert.ok(a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]), "sorted by start");
	}
	assert.ok(scopes.every((entry) => entry.length === 5 && entry.every(Number.isInteger)));
});

test("without `names`, minified names are read from sourcesContent; without either they are unknown", async () => {
	const out = await bundle(CONSTRUCTS);
	const code = read(out.dir, out.js);
	const { names: _names, ...noNames } = readJson(out.dir, out.map);
	const fromSources = computeScopes(code, noNames);
	assert.deepEqual(
		Object.fromEntries(Object.keys(EXPECTED).map((marker) => [marker, nameAround(code, fromSources.scopes, marker)])),
		EXPECTED,
	);
	const { sourcesContent: _content, ...bare } = noNames;
	const blind = computeScopes(code, bare);
	const names = Object.fromEntries(Object.keys(EXPECTED).map((marker) => [marker, nameAround(code, blind.scopes, marker)]));
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
	const script = computeScopes("#!/usr/bin/env node\nwith (x) { y = function named() {}; }\n", { version: 3, sources: [], names: [], mappings: "" });
	assert.deepEqual(script, { scopes: { version: 1, names: ["named"], scopes: [[1, 15, 1, 34, 0]] } });

	const out = await bundle(CONSTRUCTS);
	const before = computeScopes(read(out.dir, out.js), readJson(out.dir, out.map)).scopes;
	await injectDir(out.dir);
	const code = read(out.dir, out.js);
	const after = computeScopes(code, readJson(out.dir, out.map)).scopes;
	// The snippet is an anonymous function on line 0; everything else moved
	// down one line and kept its name.
	assert.deepEqual(after.scopes[0], [0, ";!".length, 0, code.indexOf("}();") + 1, ANONYMOUS_SCOPE]);
	assert.deepEqual(
		after.scopes.slice(1).map(([sl, sc, el, ec, n]) => [sl - 1, sc, el - 1, ec, after.names[n] ?? n]),
		before.scopes.map(([sl, sc, el, ec, n]) => [sl, sc, el, ec, before.names[n] ?? n]),
	);
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
	assert.deepEqual(stored["/ok.js"][SCOPES_KEY], { version: 1, names: ["okay"], scopes: [[0, 0, 0, 18, 0]] });
});

test("scopes already in a map are replaced by the ones computed from the served file", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const stale = { version: 1, names: ["stale"], scopes: [[0, 0, 0, 99, 0]] };
	const dir = tempDir({ "a.js": "x()\n", "a.js.map": { ...SIMPLE_MAP, [SCOPES_KEY]: stale } });
	await uploadDir(dir, { ...quiet, release: "r1", endpoint: ingester.url, key: SERVER_KEY });
	assert.deepEqual(JSON.parse(ingester.rows[0].map)[SCOPES_KEY], { version: 1, names: [], scopes: [] });
});

test("a map that only fits the 5 MB limit without scopes is uploaded without them", async (t) => {
	const ingester = await startIngester();
	t.after(ingester.close);
	const functions = Array.from({ length: 2000 }, (_, i) => `function handler${i}() {}`).join("\n");
	const padding = 5 * 1024 * 1024 - 40_000;
	const dir = tempDir({ "big.js": `${functions}\n`, "big.js.map": { ...SIMPLE_MAP, names: ["n".repeat(padding)] } });
	const warnings = [];
	const summary = await uploadDir(dir, { release: "r1", endpoint: ingester.url, key: SERVER_KEY, log: (line) => warnings.push(line) });
	assert.equal(summary.uploaded.length, 1);
	assert.match(warnings.join("\n"), /big\.js: its map is over 5 MB with function scopes, so it is uploaded without them/);
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
