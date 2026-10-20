import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import type { ClickHouseClient } from "@clickhouse/client";
import { ClickHouseStore } from "./clickhouse.js";
import { loadConfig } from "./config.js";
import { MIGRATIONS } from "./migrations.js";
import { browserPayloadSchema, normalizeBrowserPayload } from "./normalize-browser.js";
import { createIngesterApp } from "./server.js";
import {
	SOURCE_MAP_MAX_BODY_BYTES,
	SOURCE_MAP_MAX_CHARS,
	browserDebugIds,
	sourceMapTableDDL,
	validateSourceMap,
	validateSourceMapCheck,
	type SourceMapCheck,
	type ValidSourceMap,
} from "./source-maps.js";
import { lookupSourceMap, presentSourceMaps } from "./source-maps-lookup.js";

const ID = "4f3c6a1e-9b2d-4e8f-a1b2-c3d4e5f60718";
const OTHER_ID = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const MAP = { version: 3, mappings: "AAAA", sources: ["src/app.ts"] };

test("uploads accept .js, .mjs and .cjs bundles and normalise the path", () => {
	for (const name of ["app.js", "app.mjs", "app.cjs"]) {
		assert.equal(validateSourceMap({ release: "abc", filename: `https://cdn.example.com/assets/${name}?v=1#x`, map: MAP })?.filename, `/assets/${name}`);
	}
	assert.equal(validateSourceMap({ release: "abc", filename: "/assets/app.ts", map: MAP }), null);
	assert.equal(validateSourceMap({ release: "abc", filename: "/assets/app.js.map", map: MAP }), null);
	assert.equal(validateSourceMap({ release: "not a release", filename: "/app.js", map: MAP }), null);
});

test("an upload's debug id comes from the body, else the map, and must be valid", () => {
	const fromBody = validateSourceMap({ release: "abc", filename: "/app.js", debugId: ID.toUpperCase(), map: MAP });
	assert.equal(fromBody?.debugId, ID);
	const fromMap = validateSourceMap({ release: "abc", filename: "/app.js", map: { ...MAP, debugId: ID } });
	assert.equal(fromMap?.debugId, ID);
	const legacyKey = validateSourceMap({ release: "abc", filename: "/app.js", map: JSON.stringify({ ...MAP, debug_id: ID }) });
	assert.equal(legacyKey?.debugId, ID);
	assert.equal(validateSourceMap({ release: "abc", filename: "/app.js", map: MAP })?.debugId, "");
	assert.equal(validateSourceMap({ release: "abc", filename: "/app.js", debugId: "not-an-id", map: MAP }), null);
});

test("the stored map drops sourcesContent and carries its own sha256", () => {
	const stored = validateSourceMap({ release: "abc", filename: "/app.js", map: { ...MAP, sourcesContent: ["const key = 'secret'"] } })!;
	assert.equal(stored.map.includes("secret"), false);
	assert.equal(stored.map, JSON.stringify(MAP));
	assert.equal(stored.contentHash, createHash("sha256").update(stored.map).digest("hex"));
});

test("the stored map keeps the function scopes the CLI sends (x_autter_scopes), as sent", () => {
	const x_autter_scopes = { version: 1, names: ["captured"], scopes: [[0, 4, 0, 30, 0], [0, 40, 0, 50, -1]] };
	const stored = validateSourceMap({
		release: "abc",
		filename: "/app.js",
		map: { ...MAP, sourcesContent: ["const key = 'secret'"], x_autter_scopes },
	})!;
	// Byte-for-byte what the CLI hashed (storedMapJson), so re-runs skip it.
	assert.equal(stored.map, JSON.stringify({ ...MAP, x_autter_scopes }));
	assert.deepEqual(JSON.parse(stored.map).x_autter_scopes, x_autter_scopes);
});

test("check requests name files by path, debug id and hash", () => {
	const hash = "a".repeat(64);
	assert.deepEqual(
		validateSourceMapCheck({ release: "abc", files: [{ filename: "https://x.test/a.js?q", debugId: ID, hash }, { filename: "/b.mjs", hash }] }),
		{ release: "abc", entries: [{ filename: "/a.js", debugId: ID, hash }, { filename: "/b.mjs", debugId: "", hash }] },
	);
	assert.equal(validateSourceMapCheck({ release: "abc", files: [{ filename: "/a.js", hash: "nope" }] }), null);
	assert.equal(validateSourceMapCheck({ release: "abc", files: [{ filename: "/a.js", debugId: "x", hash }] }), null);
	assert.equal(validateSourceMapCheck({ release: "abc", files: Array.from({ length: 501 }, () => ({ filename: "/a.js", hash })) }), null);
});

test("check entries may name a debug id without a hash (1.7.0, sourcemaps verify), never neither", () => {
	assert.deepEqual(
		validateSourceMapCheck({ release: "abc", files: [{ filename: "/a.js", debugId: ID.toUpperCase() }, { filename: "/b.js", debugId: ID, hash: "" }] }),
		{ release: "abc", entries: [{ filename: "/a.js", debugId: ID, hash: "" }, { filename: "/b.js", debugId: ID, hash: "" }] },
	);
	assert.equal(validateSourceMapCheck({ release: "abc", files: [{ filename: "/a.js" }] }), null);
	assert.equal(validateSourceMapCheck({ release: "abc", files: [{ filename: "/a.js", hash: 42 }] }), null);
});

test("migration 0016 adds debug_id, content_hash and its index idempotently, and the baseline matches", () => {
	const migration = MIGRATIONS.find((m) => m.id === "0017-source-maps-debug-id");
	assert.ok(migration);
	assert.equal(MIGRATIONS.filter((m) => m.id.startsWith("0017-source-maps")).length, 1);
	for (const statement of migration.statements) assert.match(statement, /IF NOT EXISTS/);
	assert.ok(migration.statements.some((s) => /ADD COLUMN IF NOT EXISTS debug_id String DEFAULT ''/.test(s)));
	assert.ok(migration.statements.some((s) => /ADD COLUMN IF NOT EXISTS content_hash String DEFAULT ''/.test(s)));
	assert.ok(migration.statements.some((s) => /ADD INDEX IF NOT EXISTS idx_sm_debug_id debug_id/.test(s)));
	const baseline = sourceMapTableDDL("db");
	assert.match(baseline, /debug_id String DEFAULT ''/);
	assert.match(baseline, /content_hash String DEFAULT ''/);
	assert.match(baseline, /INDEX idx_sm_debug_id debug_id TYPE bloom_filter/);
	// The dedupe key is unchanged: same release + path still replaces.
	assert.match(baseline, /ORDER BY \(org_id, repository_id, release, filename\)/);
});

interface Row { org_id: string; repository_id: string; release: string; filename: string; debug_id: string; content_hash: string; map: string; uploaded_at: number }

/** In-memory runtime_source_maps that answers the two lookup queries by their parameters. */
function fakeClient(rows: Row[]): { client: ClickHouseClient; queries: Array<{ query: string; params: Record<string, unknown> }> } {
	const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
	const client = {
		async query({ query, query_params: params }: { query: string; query_params: Record<string, unknown> }) {
			queries.push({ query, params });
			let found = rows.filter((r) => r.org_id === params.org && r.repository_id === params.repo);
			if (/debug_id = \{debugId:String\}/.test(query)) found = found.filter((r) => r.debug_id === params.debugId);
			if (/release = \{release:String\}/.test(query)) found = found.filter((r) => r.release === params.release);
			if (/filename = \{filename:String\}/.test(query)) found = found.filter((r) => r.filename === params.filename);
			if (/has\(\{hashes:Array\(String\)\}, content_hash\)/.test(query)) {
				found = found.filter((r) => (params.hashes as string[]).includes(r.content_hash));
			}
			if (/has\(\{debugIds:Array\(String\)\}, debug_id\)/.test(query)) {
				found = found.filter((r) => (params.debugIds as string[]).includes(r.debug_id));
			}
			found.sort((a, b) => b.uploaded_at - a.uploaded_at);
			return { json: async () => (/LIMIT 1/.test(query) ? found.slice(0, 1) : found) };
		},
	} as unknown as ClickHouseClient;
	return { client, queries };
}

const row = (over: Partial<Row>): Row => ({
	org_id: "org-a", repository_id: "repo-a", release: "r1", filename: "/assets/app.js",
	debug_id: "", content_hash: "", map: "{}", uploaded_at: 1, ...over,
});

test("lookupSourceMap finds a map by debug id, whatever the release", async () => {
	const { client, queries } = fakeClient([
		row({ release: "build-7", debug_id: ID, map: "by-id" }),
		row({ release: "r1", map: "by-release" }),
		row({ org_id: "org-b", debug_id: OTHER_ID, map: "other-tenant" }),
	]);
	const key = { orgId: "org-a", repositoryId: "repo-a", release: "r1", filename: "https://app.test/assets/app.js?v=3" };
	assert.equal(await lookupSourceMap(client, "db", { ...key, debugId: ID.toUpperCase() }), "by-id");
	assert.equal(await lookupSourceMap(client, "db", { ...key, release: null, debugId: ID }), "by-id");
	// Another tenant's debug id never matches.
	assert.equal(await lookupSourceMap(client, "db", { ...key, release: null, debugId: OTHER_ID }), null);
	// Values travel as query parameters, never inside the SQL.
	for (const q of queries) assert.ok(!q.query.includes(ID) && !q.query.includes("org-a"));
	assert.ok(queries.every((q) => q.query.includes("FROM db.runtime_source_maps")));
});

test("lookupSourceMap falls back to release + path (origin and query stripped)", async () => {
	const { client } = fakeClient([
		row({ map: "old", uploaded_at: 1 }),
		row({ map: "new", uploaded_at: 2 }),
		row({ release: "r2", map: "other-release" }),
	]);
	const key = { orgId: "org-a", repositoryId: "repo-a", release: "r1", filename: "https://cdn.test/assets/app.js?v=1#top" };
	assert.equal(await lookupSourceMap(client, "db", key), "new");
	// An id with no uploaded map falls through to release + path.
	assert.equal(await lookupSourceMap(client, "db", { ...key, debugId: OTHER_ID }), "new");
	// Malformed ids are ignored rather than queried.
	assert.equal(await lookupSourceMap(client, "db", { ...key, debugId: "garbage" }), "new");
	assert.equal(await lookupSourceMap(client, "db", { ...key, release: null }), null);
	assert.equal(await lookupSourceMap(client, "db", { ...key, filename: "/assets/missing.js" }), null);
});

test("presentSourceMaps returns entries already stored with the same path, debug id and hash", async () => {
	const hash = "b".repeat(64);
	const { client, queries } = fakeClient([
		row({ debug_id: ID, content_hash: hash }),
		row({ filename: "/assets/vendor.js", content_hash: hash }),
	]);
	const check: SourceMapCheck = { release: "r1", entries: [
		{ filename: "/assets/app.js", debugId: ID, hash },
		{ filename: "/assets/app.js", debugId: OTHER_ID, hash },
		{ filename: "/assets/vendor.js", debugId: "", hash },
		{ filename: "/assets/vendor.js", debugId: "", hash: "c".repeat(64) },
	] };
	assert.deepEqual(await presentSourceMaps(client, "db", { orgId: "org-a", repositoryId: "repo-a" }, check), [0, 2]);
	assert.match(queries[0]!.query, /uploaded_at >= now64\(3\) - INTERVAL 7 DAY/);
	assert.deepEqual(await presentSourceMaps(client, "db", { orgId: "org-a", repositoryId: "repo-a" }, { release: "r1", entries: [] }), []);
});

test("presentSourceMaps answers debug-id-only entries from any release or path, per tenant", async () => {
	const hash = "b".repeat(64);
	const { client, queries } = fakeClient([
		row({ release: "build-7", filename: "/old/path.js", debug_id: ID, content_hash: hash }),
		row({ org_id: "org-b", debug_id: OTHER_ID }),
	]);
	const tenant = { orgId: "org-a", repositoryId: "repo-a" };
	const check: SourceMapCheck = { release: "r1", entries: [
		{ filename: "/assets/app.js", debugId: ID, hash: "" },
		{ filename: "/assets/app.js", debugId: OTHER_ID, hash: "" },
		{ filename: "/old/path.js", debugId: ID, hash },
	] };
	// The hashed entry still needs its own release (r1 has none); the id-only one doesn't.
	assert.deepEqual(await presentSourceMaps(client, "db", tenant, check), [0]);
	const byId = queries.find((q) => /debug_id FROM db\.runtime_source_maps/.test(q.query))!;
	assert.doesNotMatch(byId.query, /release|uploaded_at/);
	assert.deepEqual(byId.params.debugIds, [ID, OTHER_ID]);
	queries.length = 0;
	assert.deepEqual(await presentSourceMaps(client, "db", tenant, { release: "r1", entries: [{ filename: "/a.js", debugId: ID, hash: "" }] }), [0]);
	assert.equal(queries.length, 1, "no hash query without hashed entries");
});

test("browser events keep valid debugIds, query-stripped, and drop bad ones without rejecting the beacon", () => {
	const parsed = browserPayloadSchema.parse({
		version: 1, service: "web", environment: "prod",
		events: [
			{ type: "exception", timestamp: new Date().toISOString(), message: "boom",
				stack: "Error: boom\n    at https://app.test/assets/app.js:1:10",
				debugIds: { "https://app.test/assets/app.js?v=2": ID.toUpperCase(), "https://app.test/x.js": "bad" } },
			{ type: "exception", timestamp: new Date().toISOString(), message: "no ids", debugIds: "not an object" },
		],
	});
	const { occurrences } = normalizeBrowserPayload(parsed);
	assert.deepEqual(occurrences[0]!.debugIds, { "https://app.test/assets/app.js": ID });
	assert.equal("debugIds" in occurrences[1]!, false);
	assert.deepEqual(browserDebugIds({}), {});
	assert.equal(Object.keys(browserDebugIds(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`https://a.test/${i}.js`, ID]))).debugIds!).length, 50);
	assert.deepEqual(browserDebugIds({ "https://user:hunter2@app.test/a.js": ID }), { debugIds: { "https://[redacted]@app.test/a.js": ID } });
});

test("/v1/sourcemaps stores the debug id and /v1/sourcemaps/check answers per tenant", async () => {
	const config = { ...loadConfig(), clickhouseUrl: "http://127.0.0.1:8123", ingestKeys: [
		{ key: "server-test", orgId: "org-a", repositoryId: "repo-a", scope: "server" as const },
		{ key: "client-test", orgId: "org-b", repositoryId: "repo-b", scope: "client" as const },
	] };
	const { app, store } = createIngesterApp(config);
	const stored: ValidSourceMap[] = [];
	let checked: { tenant: string; check: SourceMapCheck } | null = null;
	store.insertSourceMap = async (_ctx, sourceMap) => { stored.push(sourceMap); };
	store.sourceMapsPresent = async (ctx, check) => { checked = { tenant: `${ctx.orgId}/${ctx.repositoryId}`, check }; return [0]; };
	const server = app.listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no listener");
		const post = (path: string, body: unknown, key = "server-test") => fetch(`http://127.0.0.1:${address.port}${path}`, {
			method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body),
		});
		assert.equal((await post("/v1/sourcemaps", { release: "abc", filename: "/assets/app.mjs", debugId: ID, map: MAP })).status, 202);
		assert.equal(stored[0]?.debugId, ID);
		assert.equal(stored[0]?.filename, "/assets/app.mjs");
		assert.equal((await post("/v1/sourcemaps", { release: "abc", filename: "/app.js", debugId: "nope", map: MAP })).status, 400);

		const hash = "d".repeat(64);
		const res = await post("/v1/sourcemaps/check", { release: "abc", files: [{ filename: "/assets/app.mjs", debugId: ID, hash }] });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { present: [0] });
		assert.equal(checked!.tenant, "org-a/repo-a");
		assert.equal((await post("/v1/sourcemaps/check", { release: "abc", files: [{ filename: "/a.js", hash: "x" }] })).status, 400);
		assert.equal((await post("/v1/sourcemaps/check", { release: "abc", files: [] }, "client-test")).status, 403);
	} finally {
		server.close();
	}
});

test("/v1/sourcemaps: gzip bodies are inflated, limits count inflated bytes, and the key is checked before the body is read", async () => {
	const config = { ...loadConfig(), clickhouseUrl: "http://127.0.0.1:8123", ingestKeys: [
		{ key: "server-test", orgId: "org-a", repositoryId: "repo-a", scope: "server" as const },
	] };
	const { app, store } = createIngesterApp(config);
	const stored: ValidSourceMap[] = [];
	store.insertSourceMap = async (_ctx, sourceMap) => { stored.push(sourceMap); };
	const server = app.listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no listener");
		const post = (body: Uint8Array | string, headers: Record<string, string>) =>
			fetch(`http://127.0.0.1:${address.port}/v1/sourcemaps`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body,
			});
		const auth = { authorization: "Bearer server-test" };
		// A 12 MiB map (over the old 5 MiB limit), sent gzipped.
		const big = { ...MAP, mappings: `AAAA${";AACA".repeat(3 * 1024 * 1024)}` };
		const json = JSON.stringify({ release: "abc", filename: "/assets/vendor.js", map: big });
		const gzipped = gzipSync(json);
		assert.ok(json.length > 12 * 1024 * 1024 && gzipped.length < json.length / 50);
		const res = await post(gzipped, { ...auth, "content-encoding": "gzip" });
		assert.equal(res.status, 202, await res.text());
		assert.equal(stored.length, 1);
		assert.equal(stored[0]!.map, JSON.stringify(big));

		// The limit applies to the inflated body: a tiny gzip that inflates
		// past it is refused without being parsed.
		const bomb = gzipSync(Buffer.alloc(SOURCE_MAP_MAX_BODY_BYTES + 1, 32));
		assert.ok(bomb.length < 100_000);
		const tooBig = await post(bomb, { ...auth, "content-encoding": "gzip" });
		assert.equal(tooBig.status, 413);
		// A map over the stored limit is rejected even when its body fits.
		const overMap = JSON.stringify({ release: "abc", filename: "/a.js", map: { ...MAP, x_padding: "x".repeat(SOURCE_MAP_MAX_CHARS) } });
		assert.ok(Buffer.byteLength(overMap) < SOURCE_MAP_MAX_BODY_BYTES);
		assert.equal((await post(gzipSync(overMap), { ...auth, "content-encoding": "gzip" })).status, 400);

		// No key: refused before the body is read (it isn't even JSON).
		assert.equal((await post(gzipSync("not json"), { "content-encoding": "gzip" })).status, 401);
		assert.equal((await post("not json", auth)).status, 400);
		assert.equal(stored.length, 1);
	} finally {
		server.close();
	}
});

test("source map inserts never split the one JSON row, and big maps skip the async-insert buffer", async () => {
	const store = new ClickHouseStore({ ...loadConfig(), clickhouseUrl: "http://127.0.0.1:8123" });
	const inserts: Array<{ table: string; settings: Record<string, unknown>; mapChars: number }> = [];
	const client = {
		async insert({ table, clickhouse_settings: settings, values }: { table: string; clickhouse_settings: Record<string, unknown>; values: Array<{ map: string }> }) {
			inserts.push({ table, settings, mapChars: values[0]!.map.length });
		},
	};
	Object.assign(store, { client, ensureSchema: async () => {} });
	const ctx = { orgId: "org-a", repositoryId: "repo-a" } as Parameters<typeof store.insertSourceMap>[0];
	const map = (chars: number): ValidSourceMap => ({ release: "abc", filename: "/a.js", map: "x".repeat(chars), debugId: "", contentHash: "" });
	await store.insertSourceMap(ctx, map(1000));
	await store.insertSourceMap(ctx, map(20 * 1024 * 1024));
	assert.equal(inserts[0]!.table.endsWith(".runtime_source_maps"), true);
	assert.equal(inserts[0]!.settings.input_format_parallel_parsing, 0);
	assert.equal(inserts[0]!.settings.async_insert, 1);
	assert.equal(inserts[1]!.settings.input_format_parallel_parsing, 0);
	assert.equal(inserts[1]!.settings.async_insert, 0);
	assert.equal(inserts[1]!.mapChars, 20 * 1024 * 1024);
});
