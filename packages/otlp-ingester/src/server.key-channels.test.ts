import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { KeyResolver, redactKeyFromUrl } from "./auth.js";
import { loadConfig, type IngesterConfig, type StaticIngestKey } from "./config.js";
import { createIngesterApp, KEY_IN_URL } from "./server.js";

/**
 * Where a key may travel and which origins a client key accepts:
 * - `?key=` takes publishable client keys only (sendBeacon cannot set
 *   headers); a server or upload key there is refused with 401 key_in_url
 *   and the request is never processed, because URLs end up in logs.
 * - A client key accepts only the exact origins it lists; none listed
 *   means no browser origin at all.
 */

const SERVER = "autter_rt_server";
const UPLOAD = "autter_rtu_upload";
const CLIENT = "autter_rtc_listed";
const CLIENT_NO_ORIGINS = "autter_rtc_none";
/** Self-hosted static keys need no Autter prefix: their scope decides. */
const PLAIN_SERVER = "plain-server";
const PLAIN_CLIENT = "plain-client";
const ORIGIN = "https://app.test";

const BROWSER_BODY = {
	version: 1,
	service: "web",
	environment: "production",
	events: [{ type: "session_start", timestamp: new Date().toISOString() }],
};

function config(ingestKeys: StaticIngestKey[], extra: Partial<IngesterConfig> = {}): IngesterConfig {
	return { ...loadConfig(), clickhouseUrl: "http://127.0.0.1:1", ingestKeys, ...extra };
}

const KEYS: StaticIngestKey[] = [
	{ key: SERVER, orgId: "org-a", repositoryId: "repo-a" },
	{ key: UPLOAD, orgId: "org-a", repositoryId: "repo-a", scope: "upload" },
	{ key: CLIENT, orgId: "org-a", repositoryId: "repo-a", scope: "client", allowedOrigins: [ORIGIN, "http://localhost:3000"] },
	{ key: CLIENT_NO_ORIGINS, orgId: "org-a", repositoryId: "repo-a", scope: "client" },
	{ key: PLAIN_SERVER, orgId: "org-a", repositoryId: "repo-a", scope: "server" },
	{ key: PLAIN_CLIENT, orgId: "org-a", repositoryId: "repo-a", scope: "client", allowedOrigins: [ORIGIN] },
];

/** The real app with ClickHouse stubbed: `stored` lists every insert call. */
async function start(cfg: IngesterConfig = config(KEYS)) {
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	let built;
	try {
		built = createIngesterApp(cfg);
	} finally {
		console.error = originalError;
	}
	const { app, store } = built;
	const stored: string[] = [];
	const stub = store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) stub[name] = async () => void stored.push(name);
	}
	stub.ensureSchema = async () => {};
	stub.recentOccurrenceTraceIds = async () => [];
	stub.ping = async () => true;
	// Runs after every route: what a request logger mounted late would see.
	const seenUrls: string[] = [];
	app.use((req, res) => {
		seenUrls.push(req.url, req.originalUrl);
		res.status(404).end();
	});
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		base,
		stored,
		errors,
		seenUrls,
		/** A sendBeacon-style post: key in the URL, text/plain, the page's Origin. */
		beacon: (key: string, origin: string | null = ORIGIN) =>
			fetch(`${base}/v1/browser?key=${encodeURIComponent(key)}`, {
				method: "POST",
				headers: { "content-type": "text/plain", ...(origin ? { origin } : {}) },
				body: JSON.stringify(BROWSER_BODY),
			}),
		/** A header-authenticated post. */
		post: (path: string, key: string, body: unknown, origin: string | null = null) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(origin ? { origin } : {}) },
				body: JSON.stringify(body),
			}),
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

test("a server key in ?key= gets 401 key_in_url and nothing is stored", async (t) => {
	const app = await start();
	t.after(app.close);
	for (const origin of [ORIGIN, null]) {
		const res = await app.beacon(SERVER, origin);
		assert.equal(res.status, 401);
		assert.deepEqual(await res.json(), KEY_IN_URL);
	}
	// Every authenticated route, not only /v1/browser.
	for (const path of ["/v1/traces", "/v1/logs", "/v1/metrics", "/v1/sourcemaps"]) {
		const res = await fetch(`${app.base}${path}?key=${SERVER}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(res.status, 401, path);
		assert.equal(((await res.json()) as { error: string }).error, "key_in_url", path);
	}
	assert.deepEqual(app.stored.filter((name) => name !== "insertIngestDrops"), []);
	assert.match(KEY_IN_URL.detail, /Authorization: Bearer header/);
	assert.match(KEY_IN_URL.detail, /rotate it/);
});

test("an upload key in ?key= is refused the same way", async (t) => {
	const app = await start();
	t.after(app.close);
	const res = await fetch(`${app.base}/v1/sourcemaps/check?key=${UPLOAD}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ release: "abc", files: [] }),
	});
	assert.equal(res.status, 401);
	assert.deepEqual(await res.json(), KEY_IN_URL);
});

test("a server-scope key without an Autter prefix is refused in ?key= on its resolved scope", async (t) => {
	const app = await start();
	t.after(app.close);
	const res = await app.beacon(PLAIN_SERVER);
	assert.equal(res.status, 401);
	assert.deepEqual(await res.json(), KEY_IN_URL);
	// The same key in a header is fine.
	assert.equal((await app.post("/v1/browser", PLAIN_SERVER, BROWSER_BODY)).status, 202);
	// A prefix-less client key may use the URL.
	assert.equal((await app.beacon(PLAIN_CLIENT)).status, 202);
});

test("a validator-answered server key in ?key= is refused; a client one is accepted", async (t) => {
	const validator = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const { key } = JSON.parse(raw) as { key: string };
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(
				key === "cloud-client"
					? { orgId: "o", repositoryId: "r", scope: "client", allowedOrigins: [ORIGIN] }
					: { orgId: "o", repositoryId: "r", scope: "server" },
			));
		});
	});
	validator.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => validator.once("listening", resolve));
	t.after(() => new Promise<void>((resolve) => validator.close(() => resolve())));
	const app = await start(config([], { keyValidatorUrl: `http://127.0.0.1:${(validator.address() as AddressInfo).port}/` }));
	t.after(app.close);
	const server = await app.beacon("cloud-server");
	assert.equal(server.status, 401);
	assert.equal(((await server.json()) as { error: string }).error, "key_in_url");
	assert.equal((await app.beacon("cloud-client")).status, 202);
});

test("server keys in headers keep working, including on /v1/browser", async (t) => {
	const app = await start();
	t.after(app.close);
	assert.equal((await app.post("/v1/browser", SERVER, BROWSER_BODY)).status, 202);
	const xKey = await fetch(`${app.base}/v1/browser`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-autter-key": SERVER },
		body: JSON.stringify(BROWSER_BODY),
	});
	assert.equal(xKey.status, 202);
	assert.equal((await app.post("/v1/traces", SERVER, { resourceSpans: [] })).status, 200);
	// Accepted browser events do reach the store (so "nothing stored" above means something).
	assert.ok(app.stored.some((name) => name !== "insertIngestDrops"), app.stored.join(", "));
});

test("a client key accepts only the exact origins it lists", async (t) => {
	const app = await start();
	t.after(app.close);
	assert.equal((await app.beacon(CLIENT, ORIGIN)).status, 202);
	assert.equal((await app.beacon(CLIENT, "http://localhost:3000")).status, 202);
	// In a header (a same-origin relay forwarding the browser's Origin) too.
	assert.equal((await app.post("/v1/browser", CLIENT, BROWSER_BODY, ORIGIN)).status, 202);

	for (const origin of ["https://evil.test", "https://app.test.evil.test", "http://app.test", "null"]) {
		const res = await app.beacon(CLIENT, origin);
		assert.equal(res.status, 403, origin);
		const body = (await res.json()) as { error: string; detail: string };
		assert.equal(body.error, "origin not allowed for this key");
		assert.match(body.detail, /is not in this client key's allowed origins/);
	}
	const noOrigin = await app.beacon(CLIENT, null);
	assert.equal(noOrigin.status, 403);
	assert.match(((await noOrigin.json()) as { detail: string }).detail, /need an Origin header/);
});

test("a client key with no allowed origins accepts no origin at all", async (t) => {
	const app = await start();
	t.after(app.close);
	for (const origin of [ORIGIN, "http://localhost:3000", null]) {
		const viaUrl = await app.beacon(CLIENT_NO_ORIGINS, origin);
		assert.equal(viaUrl.status, 403, `?key= from ${origin}`);
		const body = (await viaUrl.json()) as { error: string; detail: string };
		assert.equal(body.error, "origin not allowed for this key");
		assert.match(body.detail, /has no allowed origins, so it accepts no browser origin/);
		const viaHeader = await app.post("/v1/browser", CLIENT_NO_ORIGINS, BROWSER_BODY, origin);
		assert.equal(viaHeader.status, 403, `header from ${origin}`);
	}
	assert.deepEqual(app.stored.filter((name) => name !== "insertIngestDrops"), []);
	// The operator hears about it at boot.
	assert.ok(app.errors.some((line) => /client key for repository repo-a has no allowedOrigins/.test(line)), app.errors.join("\n"));
});

test("a validator answer for a client key without allowedOrigins allows no origin", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ orgId: "o", repositoryId: "r", scope: "client" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
	try {
		const resolver = new KeyResolver(config([], { keyValidatorUrl: "http://validator.test/" }));
		const ctx = await resolver.resolve("autter_rtc_cloud");
		assert.equal(ctx?.scope, "client");
		assert.deepEqual(ctx?.allowedOrigins, []);
	} finally {
		globalThis.fetch = original;
	}
});

test("the key is masked in the request URL the rest of the app sees", async (t) => {
	const app = await start();
	t.after(app.close);
	await fetch(`${app.base}/not-a-route?a=1&key=${SERVER}&b=2`);
	assert.ok(app.seenUrls.length >= 2);
	for (const url of app.seenUrls) {
		assert.ok(!url.includes(SERVER), url);
		assert.match(url, /\?a=1&key=\[redacted\]&b=2$/);
	}
});

test("redactKeyFromUrl masks every key parameter and nothing else", () => {
	assert.equal(redactKeyFromUrl("/v1/browser"), "/v1/browser");
	assert.equal(redactKeyFromUrl("/v1/browser?keys=1&monkey=2"), "/v1/browser?keys=1&monkey=2");
	assert.equal(redactKeyFromUrl("/v1/browser?key=autter_rt_x"), "/v1/browser?key=[redacted]");
	assert.equal(redactKeyFromUrl("/v1/browser?a=1&key=x&key=y#frag"), "/v1/browser?a=1&key=[redacted]&key=[redacted]#frag");
	assert.equal(redactKeyFromUrl("/v1/browser?%6Bey=secret"), "/v1/browser?%6Bey=[redacted]");
	assert.equal(redactKeyFromUrl("/v1/browser?key"), "/v1/browser?key");
	assert.equal(redactKeyFromUrl("/v1/browser?%E0%A4%A=1&key=s"), "/v1/browser?%E0%A4%A=1&key=[redacted]");
});
