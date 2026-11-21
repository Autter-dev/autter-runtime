import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { loadConfig, type IngesterConfig } from "./config.js";
import type { IngestDropRow } from "./ingest-drops.js";
import { createIngesterApp } from "./server.js";

/**
 * A key of the wrong type or shape is refused on its prefix or shape, with a
 * body that says which key to use, and never costs a validator lookup.
 */

const SERVER = "autter_rt_" + "a".repeat(32);
const PAT = "autter_pat_" + "b".repeat(32);
const STATIC_PAT = "autter_pat_static";
const EMPTY = { resourceSpans: [] };
const BROWSER = { version: 1, service: "s", environment: "e", events: [] };
const MAP = { release: "abc", files: [] };

async function start(extra: Partial<IngesterConfig> = {}) {
	const validator = { calls: 0 };
	const vserver = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			validator.calls++;
			res.writeHead(404).end();
		});
	});
	await new Promise<void>((resolve) => vserver.listen(0, "127.0.0.1", resolve));
	const config: IngesterConfig = {
		...loadConfig(),
		clickhouseUrl: "http://127.0.0.1:1",
		ingestKeys: [{ key: STATIC_PAT, orgId: "org-a", repositoryId: "repo-a" }],
		keyValidatorUrl: `http://127.0.0.1:${(vserver.address() as AddressInfo).port}/validate`,
		keyValidatorToken: null,
		sinkUrl: null,
		redisUrl: null,
		replicas: 1,
		...extra,
	};
	// A validator next to static keys is allowed here (only local dev refuses it).
	const { app, store, drops } = createIngesterApp(config);
	const stub = store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) stub[name] = async () => {};
	}
	stub.ensureSchema = async () => {};
	stub.probe = async () => ({ state: "up", checkedAt: new Date().toISOString(), latencyMs: 0 });
	stub.recentOccurrenceTraceIds = async () => [];
	stub.sourceMapsPresent = async () => [0];
	stub.ping = async () => true;
	const written: IngestDropRow[] = [];
	store.insertIngestDrops = async (rows) => void written.push(...rows);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		validator,
		written,
		drops,
		/** Send `authorization` exactly as given. */
		call: (path: string, authorization: string, body: unknown = EMPTY) =>
			fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body) }),
		url: (path: string, query: string, body: unknown = EMPTY) =>
			fetch(`${base}${path}?${query}`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) }),
		close: () =>
			new Promise<void>((resolve) => {
				void drops.stop();
				server.close(() => resolve());
				server.closeAllConnections();
				vserver.close();
			}),
	};
}

type Body = { error: string; detail: string; code: string; expected: string; got: string };

test("a personal access token is refused on every surface without a lookup", async (t) => {
	const app = await start();
	t.after(app.close);
	const cases: Array<[string, unknown, string]> = [
		["/v1/traces", EMPTY, "server"],
		["/v1/browser", BROWSER, "client"],
		["/v1/sourcemaps", MAP, "upload"],
	];
	for (const [path, body, expected] of cases) {
		const res = await app.call(path, `Bearer ${PAT}`, body);
		assert.equal(res.status, 401, path);
		const json = (await res.json()) as Body;
		assert.equal(json.error, "wrong_key_type");
		assert.equal(json.code, "wrong_key_type");
		assert.equal(json.expected, expected);
		assert.equal(json.got, "pat");
		assert.match(json.detail, /^This is a personal access token \(autter_pat_…\), for signing in the Autter CLI and MCP\./);
		assert.match(json.detail, /Settings > Keys and tokens\.$/);
		assert.ok(!json.detail.includes(PAT));
	}
	assert.equal(app.validator.calls, 0);
	// Counted as an ordinary unknown_key drop, with no key hash.
	await app.drops.flush();
	const rows = app.written.filter((row) => row.reason === "unknown_key");
	assert.ok(rows.length > 0);
	assert.ok(rows.every((row) => row.keyHash === "" && row.status === 401));
	assert.equal(app.written.filter((row) => !["unknown_key"].includes(row.reason)).length, 0);
});

test("a personal access token in ?key= also says to revoke it", async (t) => {
	const app = await start();
	t.after(app.close);
	const res = await app.url("/v1/browser", `key=${PAT}`, BROWSER);
	assert.equal(res.status, 401);
	const json = (await res.json()) as Body;
	assert.equal(json.error, "wrong_key_type");
	assert.match(json.detail, /This token has been in a URL, which proxies log: revoke it\.$/);
	assert.equal(app.validator.calls, 0);
});

test("quoted, doubled Bearer, NAME= and masked keys are malformed_key, without a lookup", async (t) => {
	const app = await start();
	t.after(app.close);
	const cases: Array<[string, string, RegExp]> = [
		[`Bearer "${SERVER}"`, "quoted", /wrapped in quotes/],
		[`Bearer Bearer ${SERVER}`, "bearer", /starts with "Bearer "/],
		[`Bearer AUTTER_RUNTIME_KEY=${SERVER}`, "assignment", /variable name \(NAME=\)/],
		["Bearer autter_rt_AbCd...wXyZ", "masked", /shortened key shown in the dashboard list/],
	];
	for (const [authorization, , detail] of cases) {
		const res = await app.call("/v1/traces", authorization);
		assert.equal(res.status, 401, authorization);
		const json = (await res.json()) as Body;
		assert.equal(json.error, "invalid ingest key");
		assert.equal(json.code, "malformed_key");
		assert.equal(json.expected, "server");
		assert.match(json.detail, detail);
		assert.ok(!json.detail.includes(SERVER));
	}
	assert.equal(app.validator.calls, 0);
});

test("an unknown key of a good shape still reaches the validator and gets the plain body", async (t) => {
	const app = await start();
	t.after(app.close);
	const res = await app.call("/v1/traces", `Bearer ${SERVER}`);
	assert.equal(res.status, 401);
	assert.deepEqual(await res.json(), { error: "invalid ingest key" });
	assert.equal(app.validator.calls, 1);
	// And one with an unknown prefix.
	const other = await app.call("/v1/traces", "Bearer some_other_token_123");
	assert.deepEqual(await other.json(), { error: "invalid ingest key" });
	assert.equal(app.validator.calls, 2);
});

test("a static key that looks like a personal access token keeps working", async (t) => {
	const app = await start();
	t.after(app.close);
	const res = await app.call("/v1/traces", `Bearer ${STATIC_PAT}`);
	assert.equal(res.status, 200, await res.text());
	assert.equal(app.validator.calls, 0);
});

test("the existing wrong-route refusals carry detail, code, expected and got", async (t) => {
	const app = await start({
		ingestKeys: [
			{ key: SERVER, orgId: "o", repositoryId: "r" },
			{ key: "autter_rtc_" + "c".repeat(32), orgId: "o", repositoryId: "r", scope: "client", allowedOrigins: ["https://app.test"] },
			{ key: "autter_rtu_" + "u".repeat(32), orgId: "o", repositoryId: "r", scope: "upload" },
		],
	});
	t.after(app.close);
	const client = "autter_rtc_" + "c".repeat(32);
	const upload = "autter_rtu_" + "u".repeat(32);
	let res = await app.call("/v1/traces", `Bearer ${client}`);
	let json = (await res.json()) as Body;
	assert.equal(res.status, 403);
	assert.equal(json.error, "client keys cannot send OTLP — use a server key");
	assert.deepEqual([json.code, json.expected, json.got], ["wrong_key_type", "server", "client"]);
	assert.match(json.detail, /^This is a runtime client key \(autter_rtc_…\), for browser errors\. Backend telemetry needs/);
	res = await app.call("/v1/sourcemaps", `Bearer ${client}`, MAP);
	json = (await res.json()) as Body;
	assert.equal(res.status, 403);
	assert.match(json.error, /client keys cannot upload source maps/);
	assert.deepEqual([json.code, json.expected, json.got], ["wrong_key_type", "upload", "client"]);
	res = await app.call("/v1/traces", `Bearer ${upload}`);
	json = (await res.json()) as Body;
	assert.equal(res.status, 403);
	assert.equal(json.error, "upload_key_not_allowed");
	assert.deepEqual([json.code, json.expected, json.got], ["wrong_key_type", "server", "upload"]);
	res = await app.url("/v1/browser", `key=${SERVER}`, BROWSER);
	json = (await res.json()) as Body;
	assert.equal(res.status, 401);
	assert.equal(json.error, "key_in_url");
	assert.deepEqual([json.code, json.expected, json.got], ["key_in_url", "client", "server"]);
	assert.match(json.detail, /A server key is secret: never put it in browser code, and rotate this one\./);
	assert.match(json.detail, /Authorization: Bearer header/);
	assert.match(json.detail, /rotate it/);
	assert.ok(!json.detail.includes(SERVER));
});
