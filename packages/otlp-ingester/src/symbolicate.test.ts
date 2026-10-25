import assert from "node:assert/strict";
import { test } from "node:test";
import { framesV3Fingerprint } from "./fingerprint-v3.js";
import type { SourceMapKey } from "./source-maps-lookup.js";
import { ScopeIndex } from "./source-map-scopes.js";
import { parseStackFrames } from "./stack-frames.js";
import {
	CONTEXT_LINES,
	parseSourceMap,
	serverScriptPath,
	SourceMapCache,
	Symbolicator,
	type MapFetcher,
} from "./symbolicate.js";

// ── A tiny source-map writer (base64 VLQ), so the tests need no extra deps ──

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n: number): string {
	let v = n < 0 ? (-n << 1) | 1 : n << 1;
	let out = "";
	do {
		let digit = v & 31;
		v >>>= 5;
		if (v > 0) digit |= 32;
		out += B64[digit];
	} while (v > 0);
	return out;
}
/** Segments are absolute and 0-based: [genCol, source, line, col, name?]. */
function mappings(lines: number[][][]): string {
	let src = 0;
	let line = 0;
	let col = 0;
	let name = 0;
	return lines
		.map((segments) => {
			let gen = 0;
			return segments
				.map((s) => {
					const parts = [s[0]! - gen];
					gen = s[0]!;
					parts.push(s[1]! - src, s[2]! - line, s[3]! - col);
					src = s[1]!;
					line = s[2]!;
					col = s[3]!;
					if (s.length > 4) {
						parts.push(s[4]! - name);
						name = s[4]!;
					}
					return parts.map(vlq).join("");
				})
				.join(",");
		})
		.join(";");
}

const SOURCES = [
	"webpack://shop/./src/checkout/total.ts",
	"webpack://shop/./src/checkout/Checkout.tsx",
	"webpack://shop/./node_modules/react-dom/index.js",
	"webpack://shop/./src/vendor-shim/invariant.js",
];
const NAMES = ["total", "computeTotal", "onSubmit", "invariant"];
/** `sources` entries as the map resolves them ("./" segments normalised). */
const RESOLVED = SOURCES.map((source) => source.replace("/./", "/"));

/** One bundle build: the same original code at build-specific generated columns. */
function buildMap(columns: [number, number, number, number], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 3,
		sources: SOURCES,
		names: NAMES,
		mappings: mappings([
			[
				[columns[0], 0, 11, 4, 0],
				[columns[1], 1, 87, 6, 1],
				[columns[2], 2, 4, 2, 2],
				[columns[3], 3, 0, 0, 3],
			],
		]),
		x_google_ignoreList: [3],
		...extra,
	});
}

const BUILD_A = { url: "https://app.example.com/assets/index-abc12345.js", map: buildMap([10, 50, 90, 130]) };
const BUILD_B = { url: "https://preview-7.example.dev/assets/index-def67890.js", map: buildMap([20, 70, 120, 160]) };

function stack(url: string, cols: [number, number, number], names = ["a", "b", "HTMLButtonElement.c"]): string {
	return [
		"TypeError: Cannot read properties of undefined (reading 'total')",
		`    at ${names[0]} (${url}:1:${cols[0]})`,
		`    at ${names[1]} (${url}:1:${cols[1]})`,
		`    at ${names[2]} (${url}:1:${cols[2]})`,
	].join("\n");
}

function fetcherFor(maps: Record<string, string>, calls: SourceMapKey[] = []): MapFetcher {
	return async (key) => {
		calls.push(key);
		return maps[key.filename] ?? null;
	};
}

const scope = { orgId: "org", repositoryId: "repo", release: "r1" };

test("resolves minified frames: original files, lines, caller-derived names, in-app from the map", async () => {
	const calls: SourceMapKey[] = [];
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": BUILD_A.map }, calls));
	const frames = await symbolicator.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	assert.deepEqual(frames, [
		{ function: "computeTotal", module: null, filename: RESOLVED[0], lineno: 12, colno: 5, inApp: true, resolved: true },
		{ function: "onSubmit", module: null, filename: RESOLVED[1], lineno: 88, colno: 7, inApp: true, resolved: true },
		// No caller to name it, and "c" is a mangled name; node_modules → not in-app.
		{ function: null, module: null, filename: RESOLVED[2], lineno: 5, colno: 3, inApp: false, resolved: true },
	]);
	// One map lookup for three frames of the same file, path-only key.
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { orgId: "org", repositoryId: "repo", release: "r1", filename: "/assets/index-abc12345.js" });
});

test("frames-v3 over resolved frames survives a rebuild with a new chunk hash, origin and offsets", async () => {
	const symbolicator = new Symbolicator(
		fetcherFor({ "/assets/index-abc12345.js": BUILD_A.map, "/assets/index-def67890.js": BUILD_B.map }),
	);
	const a = await symbolicator.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	const b = await symbolicator.symbolicate(
		parseStackFrames(stack(BUILD_B.url, [21, 71, 121], ["Qt", "Zr", "HTMLButtonElement.k"])),
		{ ...scope, release: "r2" },
	);
	const fp = (frames: typeof a) =>
		framesV3Fingerprint({ service: "web", errorType: "TypeError", message: "m", frames });
	assert.equal(fp(a).fingerprint, fp(b).fingerprint);
	assert.deepEqual(fp(a).record.parts, ["TypeError", "computeTotal@total.ts", "onSubmit@checkout.tsx"]);
});

test("ignore-listed sources are not in-app", async () => {
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": BUILD_A.map }));
	const [frame] = await symbolicator.symbolicate(
		parseStackFrames(`Error: x\n    at invariantImpl (${BUILD_A.url}:1:131)`),
		scope,
	);
	assert.equal(frame!.filename, RESOLVED[3]);
	assert.equal(frame!.resolved, true);
	assert.equal(frame!.inApp, false);
	// Not mangled, no caller: the parsed name is kept.
	assert.equal(frame!.function, "invariantImpl");
});

test("source contents never weigh on the map's cache entry: a map caches exactly as without them", async () => {
	const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const big = content + "\n" + "x".repeat(400_000);
	const withContents = buildMap([10, 50, 90, 130], { sourcesContent: [big, null, null, null] });
	// Same weight as the map without contents, whatever their size.
	assert.equal(parseSourceMap(withContents).bytes, parseSourceMap(BUILD_A.map).bytes);
	assert.equal(parseSourceMap(withContents).map.sourcesContent, undefined);
	assert.equal(parseSourceMap(withContents).contentOf(0), big);
	// A budget that only fits the map: still decoded and kept (not bypassed),
	// and the contents live in their own store.
	const weight = parseSourceMap(BUILD_A.map).bytes;
	const cache = new SourceMapCache({ maxBytes: weight * 2 + 1, maxContentBytes: 4 * 1024 * 1024 });
	const calls: SourceMapKey[] = [];
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": withContents }, calls), cache);
	const frames = parseStackFrames(stack(BUILD_A.url, [11, 51, 91]));
	const [first] = await symbolicator.symbolicate(frames, scope);
	assert.equal(cache.bypassed, 0);
	assert.equal(cache.bytes, weight);
	assert.ok(cache.contentBytes > 2 * big.length, `${cache.contentBytes} content bytes`);
	assert.equal(first!.contextLine, "line 12");
	// A cache hit reads the contents from their store: no refetch, same lines.
	const [again] = await symbolicator.symbolicate(frames, scope);
	assert.equal(calls.length, 1);
	assert.deepEqual(again, first);
	// Evicting the map drops its contents too.
	const fetchOther: MapFetcher = async () => BUILD_A.map;
	await cache.get({ ...scope, release: "r2", filename: "/a.js" }, fetchOther);
	await cache.get({ ...scope, release: "r3", filename: "/a.js" }, fetchOther);
	assert.equal(cache.size, 2);
	assert.equal(cache.contentBytes, 0);
	// A file over half the content budget is not kept: the frame resolves, without lines.
	const tight = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": withContents }), new SourceMapCache({ maxContentBytes: big.length }));
	const [unkept] = await tight.symbolicate(frames, scope);
	assert.equal(unkept!.resolved, true);
	assert.equal("contextLine" in unkept!, false);
});

test("context lines come only from sourcesContent: the line and 5 on each side (RF-05)", async () => {
	assert.equal(CONTEXT_LINES, 5);
	const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\r\n");
	const map = buildMap([10, 50, 90, 130], { sourcesContent: [content, null, null, null] });
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": map }));
	const [frame, caller] = await symbolicator.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	assert.equal(frame!.contextLine, "line 12");
	assert.deepEqual(frame!.preContext, ["line 7", "line 8", "line 9", "line 10", "line 11"]);
	assert.deepEqual(frame!.postContext, ["line 13", "line 14", "line 15", "line 16", "line 17"]);
	assert.equal("contextLine" in caller!, false);
});

test("context lines near the edges of a file, and none past its end", async () => {
	// total.ts:12 is the frame's line: a 13-line file has 1 line after it.
	const short = Array.from({ length: 13 }, (_, i) => `l${i + 1}`).join("\n");
	const symbolicator = new Symbolicator(
		fetcherFor({ "/assets/index-abc12345.js": buildMap([10, 50, 90, 130], { sourcesContent: [short, null, null, null] }) }),
	);
	const [frame] = await symbolicator.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	assert.deepEqual([frame!.preContext, frame!.contextLine, frame!.postContext], [["l7", "l8", "l9", "l10", "l11"], "l12", ["l13"]]);
	const tooShort = new Symbolicator(
		fetcherFor({ "/assets/index-abc12345.js": buildMap([10, 50, 90, 130], { sourcesContent: ["only\nfour\nlines\nhere", null, null, null] }) }),
	);
	const [past] = await tooShort.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	assert.equal(past!.resolved, true);
	assert.equal("contextLine" in past!, false);
});

test("context lines are scrubbed and cut to 300 characters, and only in-app frames get them", async () => {
	const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
	lines[11] = 'const key = "sk_live_abcdefghijklmnop";';
	lines[12] = "x".repeat(400);
	const react = Array.from({ length: 10 }, (_, i) => `react ${i + 1}`).join("\n");
	const map = buildMap([10, 50, 90, 130], { sourcesContent: [lines.join("\n"), null, react, null] });
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": map }));
	const [frame, , dependency] = await symbolicator.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	assert.equal(frame!.contextLine, 'const key = "[redacted]";');
	assert.equal(frame!.postContext![0], "x".repeat(300));
	// react-dom (node_modules) resolved but out of the app: no source shown.
	assert.equal(dependency!.inApp, false);
	assert.equal(dependency!.resolved, true);
	assert.equal("contextLine" in dependency!, false);
});

test("parsed maps are cached per release and file; misses are remembered briefly", async () => {
	let now = 1_000;
	const calls: SourceMapKey[] = [];
	const cache = new SourceMapCache({ now: () => now, missTtlMs: 60_000 });
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": BUILD_A.map }, calls), cache);
	const frames = parseStackFrames(stack(BUILD_A.url, [11, 51, 91]));
	await symbolicator.symbolicate(frames, scope);
	await symbolicator.symbolicate(frames, scope);
	assert.equal(calls.length, 1, "a busy issue never refetches its map");
	await symbolicator.symbolicate(frames, { ...scope, release: "r9" });
	assert.equal(calls.length, 2, "another release is another key");

	const missing = parseStackFrames("Error: x\n    at f (https://app.example.com/assets/other.js:1:5)");
	await symbolicator.symbolicate(missing, scope);
	await symbolicator.symbolicate(missing, scope);
	assert.equal(calls.length, 3, "a miss is cached");
	now += 61_000;
	await symbolicator.symbolicate(missing, scope);
	assert.equal(calls.length, 4, "an expired miss is looked up again (a map may have been uploaded)");
});

test("concurrent lookups of the same map share one fetch", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let fetches = 0;
	const symbolicator = new Symbolicator(async () => {
		fetches += 1;
		await gate;
		return BUILD_A.map;
	});
	const frames = parseStackFrames(stack(BUILD_A.url, [11, 51, 91]));
	const pending = Promise.all([symbolicator.symbolicate(frames, scope), symbolicator.symbolicate(frames, scope)]);
	release();
	const [a, b] = await pending;
	assert.equal(fetches, 1);
	assert.deepEqual(a, b);
});

test("the cache evicts least recently used maps past its byte budget", async () => {
	const weight = parseSourceMap(BUILD_A.map).bytes;
	const cache = new SourceMapCache({ maxBytes: weight * 2 + 1 });
	const fetch: MapFetcher = async () => BUILD_A.map;
	for (const release of ["r1", "r2", "r3"]) {
		await cache.get({ ...scope, release, filename: "/a.js" }, fetch);
	}
	assert.equal(cache.size, 2);
	assert.equal(cache.fetches, 3);
	await cache.get({ ...scope, release: "r1", filename: "/a.js" }, fetch);
	assert.equal(cache.fetches, 4, "the oldest entry was evicted");
});

test("a map too big for half the cache is used for its stack and not kept, so cached maps stay", async () => {
	const small = parseSourceMap(BUILD_A.map).bytes;
	const cache = new SourceMapCache({ maxBytes: small * 3 });
	// Same positions as BUILD_A, plus 20 000 more generated lines: ~400 KB decoded.
	const base = JSON.parse(BUILD_A.map) as { mappings: string };
	const big = JSON.stringify({ ...base, mappings: base.mappings + ";AAAA".repeat(20_000) });
	assert.ok(parseSourceMap(big).bytes > small * 1.5);
	const calls: SourceMapKey[] = [];
	const symbolicator = new Symbolicator(
		fetcherFor({ "/assets/index-abc12345.js": BUILD_A.map, "/assets/vendor-big.js": big }, calls),
		cache,
	);
	const bigUrl = "https://app.example.com/assets/vendor-big.js";
	const expected = await symbolicator.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	assert.equal(cache.size, 1);
	// The big map resolves the same frames (read without decoding)…
	const resolved = await symbolicator.symbolicate(parseStackFrames(stack(bigUrl, [11, 51, 91])), scope);
	assert.deepEqual(resolved, expected);
	// …once for the whole stack, and is not kept: nothing was evicted for it.
	assert.equal(calls.length, 2);
	assert.equal(cache.bypassed, 1);
	assert.equal(cache.size, 1);
	assert.equal(cache.bytes, small);
	await symbolicator.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	assert.equal(calls.length, 2, "the small map is still cached");
	await symbolicator.symbolicate(parseStackFrames(stack(bigUrl, [11, 51, 91])), scope);
	assert.equal(calls.length, 3, "the big one is fetched again");
	assert.equal(cache.bypassed, 2);
});

test("symbolication never fails ingest: lookup errors and bad maps keep the parsed frames", async () => {
	const frames = parseStackFrames(stack(BUILD_A.url, [11, 51, 91]));
	const failing = new Symbolicator(async () => {
		throw new Error("clickhouse down");
	});
	assert.deepEqual(await failing.symbolicate(frames, scope), frames);
	const garbage = new Symbolicator(async () => "{not json");
	assert.deepEqual(await garbage.symbolicate(frames, scope), frames);
	const noPosition = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": BUILD_A.map }));
	const far = parseStackFrames(`Error: x\n    at f (${BUILD_A.url}:9:1)`);
	assert.deepEqual(await noPosition.symbolicate(far, scope), far);
});

test("no release and no debug id: nothing to look up", async () => {
	const calls: SourceMapKey[] = [];
	const symbolicator = new Symbolicator(fetcherFor({}, calls));
	const frames = parseStackFrames(stack(BUILD_A.url, [11, 51, 91]));
	assert.deepEqual(await symbolicator.symbolicate(frames, { ...scope, release: null }), frames);
	assert.equal(calls.length, 0);
});

test("a debug id for the script is passed to the lookup, even without a release", async () => {
	const calls: SourceMapKey[] = [];
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": BUILD_A.map }, calls));
	const frames = parseStackFrames(stack(BUILD_A.url, [11, 51, 91]));
	const resolved = await symbolicator.symbolicate(frames, {
		...scope,
		release: null,
		debugIds: { [`${BUILD_A.url}?v=3`]: "c0ffee00-0000-4000-8000-000000000001" },
	});
	assert.equal(calls[0]?.debugId, "c0ffee00-0000-4000-8000-000000000001");
	assert.equal(resolved[0]!.resolved, true);
});

test("non-JS and position-less frames are left alone", async () => {
	const calls: SourceMapKey[] = [];
	const symbolicator = new Symbolicator(fetcherFor({}, calls));
	const frames = parseStackFrames(
		"Error: x\n    at f (https://app.example.com/page.html:1:1)\n    at Array.map (<anonymous>)",
	);
	assert.deepEqual(await symbolicator.symbolicate(frames, scope), frames);
	assert.equal(calls.length, 0);
});

// ── Server frames (RF-05) ─────────────────────────────────────────────────

test("server frames: in-app .js frames are looked up by path suffix; dependency frames never", async () => {
	const calls: SourceMapKey[] = [];
	const symbolicator = new Symbolicator(async (key) => {
		calls.push(key);
		return key.suffix && key.filename === "/app/dist/server.js" ? BUILD_A.map : null;
	});
	const parsed = parseStackFrames(
		[
			"TypeError: Cannot read properties of undefined (reading 'total')",
			"    at a (/app/dist/server.js:1:11)",
			"    at b (file:///app/dist/server.js:1:51)",
			"    at c (/app/node_modules/express/lib/router.js:1:91)",
			"    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
		].join("\n"),
	);
	const frames = await symbolicator.symbolicate(parsed, { ...scope, server: true });
	assert.deepEqual(frames, [
		{ function: "computeTotal", module: null, filename: RESOLVED[0], lineno: 12, colno: 5, inApp: true, resolved: true },
		// No resolved caller to name it, and "b" is a mangled name.
		{ function: null, module: null, filename: RESOLVED[1], lineno: 88, colno: 7, inApp: true, resolved: true },
		parsed[2],
		parsed[3],
	]);
	// file:// and plain paths are one key; express (node_modules) is never looked up.
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { orgId: "org", repositoryId: "repo", release: "r1", filename: "/app/dist/server.js", suffix: true });
});

test("server frames: a debug id from autter.debug_ids is used, even without a release", async () => {
	const calls: SourceMapKey[] = [];
	const symbolicator = new Symbolicator(fetcherFor({ "/app/dist/server.js": BUILD_A.map }, calls));
	const frames = await symbolicator.symbolicate(
		parseStackFrames("Error: x\n    at a (file:///app/dist/server.js:1:11)"),
		{ ...scope, release: null, server: true, debugIds: { "file:///app/dist/server.js": "c0ffee00-0000-4000-8000-000000000002" } },
	);
	assert.equal(calls[0]?.debugId, "c0ffee00-0000-4000-8000-000000000002");
	assert.equal(calls[0]?.filename, "/app/dist/server.js");
	assert.equal(frames[0]!.resolved, true);
	// Without one, and without a release, nothing is looked up.
	calls.length = 0;
	await symbolicator.symbolicate(parseStackFrames("Error: x\n    at a (/app/dist/server.js:1:11)"), { ...scope, release: null, server: true });
	assert.equal(calls.length, 0);
});

test("server script paths: file URLs, Windows paths and bare Worker scripts", () => {
	assert.equal(serverScriptPath("/app/dist/server.js"), "/app/dist/server.js");
	assert.equal(serverScriptPath("file:///app/dist/index.mjs"), "/app/dist/index.mjs");
	assert.equal(serverScriptPath("file:///C:/app/dist/index.mjs"), "/app/dist/index.mjs");
	assert.equal(serverScriptPath("C:\\app\\dist\\index.cjs"), "/app/dist/index.cjs");
	assert.equal(serverScriptPath("index.js"), "/index.js");
	assert.equal(serverScriptPath("/var/task/.next/server/app/(shop)/[id]/page.js"), "/var/task/.next/server/app/(shop)/[id]/page.js");
	// Same encoding as stored upload paths (sourceMapPath).
	assert.equal(serverScriptPath("/app/my app/x.js"), "/app/my%20app/x.js");
});

test("an exact lookup and a suffix lookup of one path never share a cache entry", () => {
	const key = { orgId: "o", repositoryId: "r", release: "1", filename: "/app/dist/server.js" };
	assert.notEqual(SourceMapCache.keyOf(key), SourceMapCache.keyOf({ ...key, suffix: true }));
	// A debug id names the bundle whatever the lookup kind.
	assert.equal(
		SourceMapCache.keyOf({ ...key, debugId: "c0ffee00-0000-4000-8000-000000000002" }),
		SourceMapCache.keyOf({ ...key, debugId: "c0ffee00-0000-4000-8000-000000000002", suffix: true }),
	);
});

// ── Function scopes (x_autter_scopes) ─────────────────────────────────────

/** One minified line: an object method called through a variable, and a
 * React-like dispatcher that calls a handler through `fn`. */
const SCOPED_CODE =
	'var u={captured(){throw new Error("captured failed")}};' +
	"async function a(t){let r=u[t];await r()}" +
	"var e=[];function p(){e.forEach(t=>t())}" +
	"e.push(function(){i(null)});" +
	'var i=t=>{throw new TypeError("no price")};';
const SCOPED_URL = "https://app.example.com/assets/index-5c0bed00.js";

/** 0-based column of `fragment` (+ `offset`) in the minified line. */
function colOf(fragment: string, offset = 0): number {
	const index = SCOPED_CODE.indexOf(fragment);
	assert.ok(index >= 0 && SCOPED_CODE.indexOf(fragment, index + 1) < 0, `unique fragment ${fragment}`);
	return index + offset;
}
/** A function's [startLine, startCol, endLine, endCol] from its exact text. */
function rangeOf(text: string): [number, number, number, number] {
	return [0, colOf(text), 0, colOf(text) + text.length];
}

const SCOPED_NAMES = ["run", "formatPrice", "fn"];
/** Each frame position maps into actions.ts; call sites carry the name of
 * the variable they call through, as esbuild writes them. */
const SCOPED_MAPPINGS = mappings([
	[
		[colOf('new Error("captured'), 0, 9, 10],
		[colOf("r()}"), 0, 19, 8, 0],
		[colOf("forEach("), 0, 29, 12],
		[colOf("t())"), 0, 29, 30, 2],
		[colOf("e.push("), 0, 39, 0],
		[colOf("i(null)"), 0, 39, 30, 1],
		[colOf("new TypeError"), 0, 49, 4],
	].sort((a, b) => a[0]! - b[0]!),
]);
/** Scope rows → the `x_autter_scopes` encoding (base64 VLQ, as the CLI writes it). */
function encodeScopes(rows: number[][]): string {
	let out = "";
	let line = 0;
	let start = 0;
	let name = 0;
	let first = true;
	for (const [sl, sc, el, ec, n] of rows) {
		if (sl! > line) {
			out += ";".repeat(sl! - line);
			line = sl!;
			start = 0;
			first = true;
		}
		if (!first) out += ",";
		first = false;
		out += vlq(sc! - start) + vlq(el! - sl!) + vlq(el === sl ? ec! - sc! : ec!);
		start = sc!;
		if (n! >= 0) {
			out += vlq(n! - name);
			name = n!;
		}
	}
	return out;
}

/** Name indexes continue the map's `names` (SCOPED_NAMES: run, formatPrice,
 * fn); `x_autter_scopes.names` adds the rest. */
const EXTRA_NAMES = ["captured", "runAction", "dispatch", "onCheckoutClick"];
const nameIndex = (name: string) =>
	SCOPED_NAMES.includes(name) ? SCOPED_NAMES.indexOf(name) : SCOPED_NAMES.length + EXTRA_NAMES.indexOf(name);
const SCOPE_ROWS = [
	[...rangeOf('(){throw new Error("captured failed")}'), nameIndex("captured")],
	[...rangeOf("async function a(t){let r=u[t];await r()}"), nameIndex("runAction")],
	[...rangeOf("function p(){e.forEach(t=>t())}"), nameIndex("dispatch")],
	[...rangeOf("t=>t()"), -1],
	[...rangeOf("function(){i(null)}"), nameIndex("onCheckoutClick")],
	// The map's own `names` already holds formatPrice: no extra copy.
	[...rangeOf('t=>{throw new TypeError("no price")}'), nameIndex("formatPrice")],
];
const scopesOf = (rows: number[][], extra: Array<string | null> = EXTRA_NAMES) => ({
	version: 1,
	names: extra,
	scopes: encodeScopes([...rows].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || b[3]! - a[3]!)),
});
const SCOPES = scopesOf(SCOPE_ROWS);

function scopedMap(scopes?: unknown): string {
	return JSON.stringify({
		version: 3,
		sources: ["webpack://shop/./src/checkout/actions.ts"],
		names: SCOPED_NAMES,
		mappings: SCOPED_MAPPINGS,
		...(scopes === undefined ? {} : { x_autter_scopes: scopes }),
	});
}

const at = (fn: string | null, fragment: string, offset = 0) =>
	`    at ${fn ? `${fn} (${SCOPED_URL}:1:${colOf(fragment, offset) + 1})` : `${SCOPED_URL}:1:${colOf(fragment, offset) + 1}`}`;
/** `const run = actions.captured; await run()`. */
const RUN_STACK = ["Error: captured failed", at("captured", 'new Error("captured'), at("a", "r()}")].join("\n");
/** dispatch() → listeners.forEach(fn => fn()) → handler → formatPrice. */
const DISPATCH_STACK = [
	"TypeError: no price",
	at("i", "new TypeError"),
	at(null, "i(null)"),
	at(null, "t())"),
	"    at Array.forEach (<anonymous>)",
	at("p", "forEach("),
].join("\n");

async function names(map: string, stackText: string): Promise<Array<string | null>> {
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-5c0bed00.js": map }));
	const frames = await symbolicator.symbolicate(parseStackFrames(stackText), scope);
	return frames.map((frame) => frame.function);
}

test("with scopes, a frame is named after the function it is in, not its call site", async () => {
	const map = scopedMap(SCOPES);
	// The method called through `const run = actions.captured` is `captured`.
	assert.deepEqual(await names(map, RUN_STACK), ["captured", "runAction"]);
	// The handler the dispatcher calls as `fn` is `onCheckoutClick`; the
	// dispatcher's own arrow is anonymous.
	assert.deepEqual(await names(map, DISPATCH_STACK), ["formatPrice", "onCheckoutClick", null, "Array.forEach", "dispatch"]);
	// Resolution is otherwise unchanged.
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-5c0bed00.js": map }));
	const [captured] = await symbolicator.symbolicate(parseStackFrames(RUN_STACK), scope);
	assert.deepEqual(captured, {
		function: "captured",
		module: null,
		filename: "webpack://shop/src/checkout/actions.ts",
		lineno: 10,
		colno: 11,
		inApp: true,
		resolved: true,
	});
});

test("without scopes, names still come from the caller's position (older uploads keep their fingerprints)", async () => {
	const map = scopedMap();
	assert.deepEqual(await names(map, RUN_STACK), ["run", null]);
	assert.deepEqual(await names(map, DISPATCH_STACK), ["formatPrice", "fn", null, "Array.forEach", null]);
});

test("a frame in top-level code is anonymous; an unmapped scope name falls back to the caller's", async () => {
	const top = [`Error: x`, at("i", "new TypeError"), at(null, "e.push(")].join("\n");
	assert.deepEqual(await names(scopedMap(SCOPES), top), ["formatPrice", null]);
	// A `null` name: the CLI could not map `captured` back.
	const unknown = scopesOf(SCOPE_ROWS, [null, ...EXTRA_NAMES.slice(1)]);
	assert.deepEqual(await names(scopedMap(unknown), RUN_STACK), ["run", "runAction"]);
});

test("a malformed x_autter_scopes is ignored: the map is used as if it had none", async () => {
	const legacy = {
		run: await names(scopedMap(), RUN_STACK),
		dispatch: await names(scopedMap(), DISPATCH_STACK),
	};
	const entry = SCOPE_ROWS[0]!;
	const malformed: unknown[] = [
		null,
		"scopes",
		[SCOPES.scopes],
		{ ...SCOPES, version: 2 },
		{ ...SCOPES, names: "captured" },
		{ ...SCOPES, names: [...EXTRA_NAMES, 7] },
		// The array form never shipped.
		{ ...SCOPES, scopes: SCOPE_ROWS },
		{ ...SCOPES, scopes: `${SCOPES.scopes},!!` },
		{ ...SCOPES, scopes: `${SCOPES.scopes},AA` },
		{ ...SCOPES, scopes: `${SCOPES.scopes},AAAAA` },
		scopesOf([...SCOPE_ROWS, [0, 1, 0, 2, 99]]),
		scopesOf([...SCOPE_ROWS, [0, -1, 0, 2, 0]]),
		scopesOf([...SCOPE_ROWS, [0, 3, 0, 3, 0]]),
		scopesOf([...SCOPE_ROWS, [0, 2 ** 31, 0, 2 ** 31 + 5, 0]]),
		// Overlaps `captured` without nesting in it.
		scopesOf([...SCOPE_ROWS, [0, entry[1]! + 2, 0, entry[3]! + 2, 0]]),
	];
	for (const scopes of malformed) {
		assert.equal(ScopeIndex.from(scopes, SCOPED_NAMES), null, JSON.stringify(scopes));
		assert.deepEqual(await names(scopedMap(scopes), RUN_STACK), legacy.run, JSON.stringify(scopes));
		assert.deepEqual(await names(scopedMap(scopes), DISPATCH_STACK), legacy.dispatch, JSON.stringify(scopes));
	}
});

test("scope lookup finds the innermost function across lines, with exclusive ends", () => {
	const index = ScopeIndex.from(
		scopesOf(
			[
				[0, 10, 2, 5, 1],
				[1, 4, 1, 20, 2],
				[1, 8, 1, 12, -1],
				[3, 0, 4, 1, 3],
			],
			["inner", "later"],
		),
		["map-name", "outer"],
	)!;
	assert.equal(index.size, 4);
	const at = (line: number, col: number) => {
		const found = index.nameAt(line, col);
		return found.kind === "named" ? found.name : found.kind;
	};
	assert.equal(at(0, 9), "anonymous", "before every function: top-level code");
	assert.equal(at(0, 10), "outer", "a start is inside");
	assert.equal(at(1, 3), "outer");
	assert.equal(at(1, 4), "inner");
	assert.equal(at(1, 9), "anonymous");
	assert.equal(at(1, 12), "inner", "an end is outside: back in the parent");
	assert.equal(at(1, 20), "outer");
	assert.equal(at(2, 4), "outer");
	assert.equal(at(2, 5), "anonymous");
	assert.equal(at(3, 0), "later");
	assert.equal(at(4, 1), "anonymous");
	assert.equal(ScopeIndex.from({ version: 1, names: [], scopes: "" })!.nameAt(0, 0).kind, "anonymous");
});

test("the cache budget counts a map's decoded mappings and its scope table", async () => {
	const key = { ...scope, filename: "/assets/index-5c0bed00.js" };
	const cache = new SourceMapCache();
	const loaded = await cache.get(key, async () => scopedMap(SCOPES));
	assert.ok(loaded?.scopes);
	assert.equal(loaded.scopes.size, SCOPE_ROWS.length);
	assert.ok(loaded.scopes.bytes >= SCOPE_ROWS.length * 6 * 4);
	assert.equal(cache.bytes, loaded.bytes);
	const plain = new SourceMapCache();
	const unscoped = await plain.get(key, async () => scopedMap());
	assert.equal(plain.bytes, unscoped!.bytes);
	assert.equal(cache.bytes - plain.bytes, loaded.scopes.bytes);
	// 7 segments of 5 Int32s, plus line starts and strings: measured, not a multiple of the JSON.
	assert.ok(unscoped!.bytes >= 7 * 5 * 4 && unscoped!.bytes < 2048, String(unscoped!.bytes));
});

test("the x_autter_scopes encoding is compact: a few bytes per function", () => {
	assert.ok(SCOPES.scopes.length <= SCOPE_ROWS.length * 9, SCOPES.scopes);
	assert.match(SCOPES.scopes, /^[A-Za-z0-9+/,;]+$/);
});
