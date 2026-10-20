import assert from "node:assert/strict";
import { test } from "node:test";
import { framesV3Fingerprint } from "./fingerprint-v3.js";
import type { SourceMapKey } from "./source-maps-lookup.js";
import { parseStackFrames } from "./stack-frames.js";
import { SourceMapCache, Symbolicator, type MapFetcher } from "./symbolicate.js";

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

test("context lines come only from sourcesContent", async () => {
	const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const map = buildMap([10, 50, 90, 130], { sourcesContent: [content, null, null, null] });
	const symbolicator = new Symbolicator(fetcherFor({ "/assets/index-abc12345.js": map }));
	const [frame, caller] = await symbolicator.symbolicate(parseStackFrames(stack(BUILD_A.url, [11, 51, 91])), scope);
	assert.equal(frame!.contextLine, "line 12");
	assert.deepEqual(frame!.preContext, ["line 9", "line 10", "line 11"]);
	assert.deepEqual(frame!.postContext, ["line 13", "line 14", "line 15"]);
	assert.equal("contextLine" in caller!, false);
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
	const cache = new SourceMapCache({ maxBytes: BUILD_A.map.length * 8 * 2 + 1 });
	const fetch: MapFetcher = async () => BUILD_A.map;
	for (const release of ["r1", "r2", "r3"]) {
		await cache.get({ ...scope, release, filename: "/a.js" }, fetch);
	}
	assert.equal(cache.size, 2);
	assert.equal(cache.fetches, 3);
	await cache.get({ ...scope, release: "r1", filename: "/a.js" }, fetch);
	assert.equal(cache.fetches, 4, "the oldest entry was evicted");
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
