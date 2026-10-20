import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import {
	DEBUG_ID_RE,
	debugIdFor,
	findBundles,
	hasDebugIdSnippet,
	injectDir,
	readDebugIdComment,
	shiftMappings,
	SNIPPET_LINE_KEY,
	snippetLine,
	stripSourceMappingUrl,
} from "../dist/index.js";
import { decodeMappings, read, readJson, SIMPLE_MAP, snapshot, tempDir } from "./helpers.mjs";

const APP = "console.log(1);\nfunction add(a,b){return a+b}\n";

function build() {
	return tempDir({
		"assets/app.js": APP,
		"assets/app.js.map": SIMPLE_MAP,
		"assets/chunk.mjs": "export const x=1;\n",
		"assets/chunk.mjs.map": { ...SIMPLE_MAP, file: "chunk.mjs" },
		"server/entry.cjs": '"use strict";var a=1;\n//# sourceMappingURL=entry.cjs.map\n',
		"server/entry.cjs.map": { ...SIMPLE_MAP, file: "entry.cjs" },
		"assets/no-map.js": "console.log('no map');\n",
		"assets/styles.css": "body{}",
		"assets/styles.css.map": { version: 3, sources: [], mappings: "" },
	});
}

test("debug ids are UUIDs derived from the bundle bytes", () => {
	const id = debugIdFor("console.log(1)");
	assert.match(id, DEBUG_ID_RE);
	assert.equal(id[14], "4");
	assert.equal(id, debugIdFor(Buffer.from("console.log(1)")));
	assert.notEqual(id, debugIdFor("console.log(2)"));
});

test("inject finds every .js/.mjs/.cjs bundle that has a map and nothing else", async () => {
	const dir = build();
	assert.deepEqual((await findBundles(dir)).map((b) => b.path), ["assets/app.js", "assets/chunk.mjs", "server/entry.cjs"]);
});

test("inject writes the comment, the snippet and the map's debugId", async () => {
	const dir = build();
	const results = await injectDir(dir);
	assert.deepEqual(results.map((r) => r.status), ["injected", "injected", "injected"]);
	const [app] = results;
	assert.equal(app.debugId, debugIdFor(APP));
	const code = read(dir, "assets/app.js");
	assert.equal(readDebugIdComment(code), app.debugId);
	assert.ok(code.endsWith(`//# debugId=${app.debugId}\n`));
	assert.ok(hasDebugIdSnippet(code));
	assert.ok(code.startsWith(";!function(){"), "snippet runs before the bundle's own code");
	const map = readJson(dir, "assets/app.js.map");
	assert.equal(map.debugId, app.debugId);
	// Prepending one line shifts every mapping down by exactly one line.
	assert.equal(map.mappings, ";AAAA;AACE");
	assert.equal(map[SNIPPET_LINE_KEY], 0);
	// A directive prologue stays first: the snippet is appended instead,
	// before the trailing sourceMappingURL comment, and mappings don't move.
	const cjs = read(dir, "server/entry.cjs");
	assert.ok(cjs.startsWith('"use strict";var a=1;\n;!function(){'));
	assert.match(cjs, /\n\/\/# sourceMappingURL=entry\.cjs\.map\n\/\/# debugId=[0-9a-f-]{36}\n$/);
	assert.equal(readJson(dir, "server/entry.cjs.map").mappings, SIMPLE_MAP.mappings);
});

test("inject is idempotent: a second run changes nothing", async () => {
	const dir = build();
	await injectDir(dir);
	const before = snapshot(dir);
	const again = await injectDir(dir);
	assert.deepEqual(again.map((r) => r.status), ["unchanged", "unchanged", "unchanged"]);
	assert.deepEqual(snapshot(dir), before);
});

test("inject is deterministic: the same bytes produce the same output anywhere", async () => {
	const a = build();
	const b = build();
	const [ra, rb] = [await injectDir(a), await injectDir(b)];
	assert.deepEqual(ra.map((r) => r.debugId), rb.map((r) => r.debugId));
	assert.deepEqual(snapshot(a), snapshot(b));
});

test("dry runs report without writing", async () => {
	const dir = build();
	const before = snapshot(dir);
	const results = await injectDir(dir, { dryRun: true });
	assert.deepEqual(results.map((r) => r.status), ["injected", "injected", "injected"]);
	assert.deepEqual(snapshot(dir), before);
});

test("the snippet registers the bundle's id under a stack naming the script", async () => {
	const dir = tempDir({ "app.js": "var answer = 42;\n", "app.js.map": SIMPLE_MAP });
	const [result] = await injectDir(dir);
	const context = vm.createContext({});
	vm.runInContext(read(dir, "app.js"), context, { filename: "https://app.example.test/assets/app.js" });
	const ids = context._autterDebugIds;
	const [stack] = Object.keys(ids);
	assert.match(stack, /https:\/\/app\.example\.test\/assets\/app\.js:1:\d+/);
	assert.equal(ids[stack], result.debugId);
	assert.equal(context.answer, 42, "the bundle still runs");
});

test("a bundler's own debug id is kept and gains the snippet", async () => {
	const native = "4f3c6a1e-9b2d-4e8f-a1b2-c3d4e5f60718";
	const dir = tempDir({
		"app.js": `console.log(1);\n//# debugId=${native}\n//# sourceMappingURL=app.js.map\n`,
		"app.js.map": { ...SIMPLE_MAP, debugId: native },
	});
	const [result] = await injectDir(dir);
	assert.equal(result.debugId, native);
	const code = read(dir, "app.js");
	assert.equal(code.match(/\/\/# debugId=/g).length, 1);
	assert.ok(code.includes(`[s]="${native}"`));
});

test("a bundle that contains the browser SDK (and so the registry name) still gets the snippet", async () => {
	const dir = tempDir({ "app.js": "var ids=globalThis._autterDebugIds;\n", "app.js.map": SIMPLE_MAP });
	await injectDir(dir);
	assert.ok(hasDebugIdSnippet(read(dir, "app.js")));
});

test("maps named by sourceMappingURL are found; hidden maps by <file>.map", async () => {
	const dir = tempDir({
		"a.js": "x()\n//# sourceMappingURL=maps/a.map?v=1\n",
		"maps/a.map": SIMPLE_MAP,
		"b.js": "y()\n",
		"b.js.map": SIMPLE_MAP,
		"c.js": "z()\n//# sourceMappingURL=data:application/json;base64,e30=\n",
	});
	assert.deepEqual((await findBundles(dir)).map((b) => [b.path, b.map.slice(dir.length + 1)]), [["a.js", join("maps", "a.map")], ["b.js", "b.js.map"]]);
});

test("a shebang stays on line 0 and the snippet goes on line 1", async () => {
	const dir = tempDir({ "bin.cjs": "#!/usr/bin/env node\nrun();\n", "bin.cjs.map": { ...SIMPLE_MAP, mappings: ";AAAA" } });
	await injectDir(dir);
	const lines = read(dir, "bin.cjs").split("\n");
	assert.equal(lines[0], "#!/usr/bin/env node");
	assert.ok(lines[1].startsWith(";!function(){"));
	assert.equal(lines[2], "run();");
	assert.equal(readJson(dir, "bin.cjs.map").mappings, ";;AAAA");
});

test("snippet placement and mapping shifts", () => {
	assert.equal(snippetLine("var a"), 0);
	assert.equal(snippetLine("/*! license */\n(()=>{\"use strict\"})()"), 0);
	assert.equal(snippetLine("/*! license */\n\"use strict\";var a"), -1);
	assert.equal(snippetLine("'use client';import x"), -1);
	assert.equal(snippetLine("#!/usr/bin/env node\nvar a"), 1);
	assert.equal(snippetLine("#!/usr/bin/env node"), -1);
	assert.equal(shiftMappings("AAAA;AACA", 0), ";AAAA;AACA");
	assert.equal(shiftMappings("AAAA;AACA", 1), "AAAA;;AACA");
	assert.equal(shiftMappings("", 2), ";;");
	assert.equal(stripSourceMappingUrl("a\n//# sourceMappingURL=a.js.map\n//# debugId=x\n"), "a\n//# debugId=x\n");
	assert.equal(stripSourceMappingUrl("a\n//# sourceMappingURL=a.js.map\nmore()\n"), "a\n//# sourceMappingURL=a.js.map\nmore()\n");
});

test("every original position survives the prepend", async () => {
	const mappings = "AAAA,IAAI,MAAMA;AACN,OAAO;;AAET";
	const dir = tempDir({ "app.js": "a;b;c\nd;e\n\nf\n", "app.js.map": { ...SIMPLE_MAP, names: ["n"], mappings } });
	await injectDir(dir);
	const before = decodeMappings(mappings);
	const after = decodeMappings(readJson(dir, "app.js.map").mappings);
	assert.deepEqual(after[0], []);
	assert.deepEqual(after.slice(1), before);
});

test("a crash between the map and bundle writes never shifts mappings twice", async () => {
	const dir = tempDir({ "app.js": APP, "app.js.map": SIMPLE_MAP });
	await injectDir(dir);
	const injected = { js: read(dir, "app.js"), map: read(dir, "app.js.map") };
	// The shifted map was written, the bundle was not.
	writeFileSync(join(dir, "app.js"), APP);
	await injectDir(dir);
	assert.equal(read(dir, "app.js"), injected.js);
	assert.equal(read(dir, "app.js.map"), injected.map);
});

test("an unreadable map is reported, not fatal", async () => {
	const dir = tempDir({ "a.js": "x\n", "a.js.map": "{not json", "b.js": "y\n", "b.js.map": SIMPLE_MAP });
	const results = await injectDir(dir);
	assert.deepEqual(results.map((r) => r.status), ["invalid-map", "injected"]);
	assert.equal(read(dir, "a.js"), "x\n");
});
