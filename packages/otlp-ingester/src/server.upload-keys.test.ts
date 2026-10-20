import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { KeyResolver } from "./auth.js";
import { defaultScopeFor, loadConfig, parseIngestKeys, type IngesterConfig } from "./config.js";
import { createIngesterApp, UPLOAD_KEY_NOT_ALLOWED, UPLOAD_KEY_ROUTES } from "./server.js";
import { ingesterVersion } from "./sdk-versions.js";

const SERVER = "autter_rt_server";
const CLIENT = "autter_rtc_client";
const UPLOAD = "autter_rtu_upload";
const ID = "0f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";
const MAP = { version: 3, sources: ["src/app.ts"], names: [], mappings: "AAAA" };

/** Routes that need no key at all (they hold no tenant data). */
const PUBLIC_ROUTES = ["GET /healthz", "GET /v1/compat"];

function config(): IngesterConfig {
	return {
		...loadConfig(),
		clickhouseUrl: "http://127.0.0.1:1",
		ingestKeys: [
			{ key: SERVER, orgId: "org-a", repositoryId: "repo-a" },
			{ key: CLIENT, orgId: "org-a", repositoryId: "repo-a", scope: "client" },
			{ key: UPLOAD, orgId: "org-a", repositoryId: "repo-a", scope: "upload" },
		],
	};
}

/** The real app with every ClickHouse call stubbed out. */
async function start() {
	const { app, store } = createIngesterApp(config());
	const stored: unknown[] = [];
	const stub = store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) stub[name] = async () => {};
	}
	stub.ensureSchema = async () => {};
	stub.recentOccurrenceTraceIds = async () => [];
	stub.ping = async () => true;
	store.insertSourceMap = async (_ctx, sourceMap) => {
		stored.push(sourceMap);
	};
	store.sourceMapsPresent = async () => [0];
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	// Every route the app registers, read from Express's router, so a route
	// added later is covered without touching this test.
	const routes: string[] = [];
	for (const layer of (app as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router.stack) {
		if (!layer.route) continue;
		for (const method of Object.keys(layer.route.methods)) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
	}
	const call = (route: string, key: string, body: unknown = {}) => {
		const [method, path] = route.split(" ") as [string, string];
		return fetch(`${base}${path}`, {
			method,
			headers: { "content-type": "application/json", authorization: `Bearer ${key}`, origin: "https://app.test" },
			body: method === "GET" ? undefined : JSON.stringify(body),
		});
	};
	return {
		routes,
		stored,
		call,
		close: () => new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		}),
	};
}

test("upload keys can upload and check source maps", async (t) => {
	const app = await start();
	t.after(app.close);
	const upload = await app.call("POST /v1/sourcemaps", UPLOAD, { release: "abc", filename: "/assets/app.js", debugId: ID, map: MAP });
	assert.equal(upload.status, 202, await upload.text());
	assert.equal(app.stored.length, 1);
	const check = await app.call("POST /v1/sourcemaps/check", UPLOAD, { release: "abc", files: [{ filename: "/assets/app.js", debugId: ID }] });
	assert.equal(check.status, 200);
	assert.deepEqual(await check.json(), { present: [0] });
});

test("upload keys get 403 upload_key_not_allowed on every other authenticated route", async (t) => {
	const app = await start();
	t.after(app.close);
	// The enumeration found the routes it should (so it can't silently find none).
	for (const route of ["POST /v1/traces", "POST /v1/metrics", "POST /v1/logs", "POST /v1/browser", "POST /v1/profiles", "POST /v1/platform-events"]) {
		assert.ok(app.routes.includes(route), `router lists ${route}`);
	}
	const uploadRoutes = UPLOAD_KEY_ROUTES.map((path) => `POST ${path}`);
	for (const route of uploadRoutes) assert.ok(app.routes.includes(route), `router lists ${route}`);
	const others = app.routes.filter((route) => !uploadRoutes.includes(route) && !PUBLIC_ROUTES.includes(route));
	assert.ok(others.length >= 6);
	for (const route of others) {
		const res = await app.call(route, UPLOAD);
		assert.equal(res.status, 403, `${route} refuses an upload key`);
		assert.deepEqual(await res.json(), UPLOAD_KEY_NOT_ALLOWED, route);
	}
	assert.equal(UPLOAD_KEY_NOT_ALLOWED.error, "upload_key_not_allowed");
	assert.match(UPLOAD_KEY_NOT_ALLOWED.detail, /^autter_rtu_ keys can only upload source maps/);
	// Public routes stay public; they are the only ones without a key check.
	for (const route of PUBLIC_ROUTES) {
		assert.ok(app.routes.includes(route), `router lists ${route}`);
		assert.equal((await app.call(route, UPLOAD)).status, 200, route);
	}
});

test("server keys keep every route; client keys stay refused on the source map routes", async (t) => {
	const app = await start();
	t.after(app.close);
	for (const route of app.routes.filter((r) => !PUBLIC_ROUTES.includes(r))) {
		const res = await app.call(route, SERVER);
		assert.ok(res.status !== 401 && res.status !== 403, `${route} accepts a server key (got ${res.status})`);
	}
	assert.equal((await app.call("POST /v1/sourcemaps", SERVER, { release: "abc", filename: "/a.js", map: MAP })).status, 202);
	for (const path of UPLOAD_KEY_ROUTES) {
		const res = await app.call(`POST ${path}`, CLIENT, { release: "abc", files: [] });
		assert.equal(res.status, 403, path);
		assert.match(((await res.json()) as { error: string }).error, /client keys cannot upload source maps/);
	}
	assert.equal((await app.call("POST /v1/traces", CLIENT, { resourceSpans: [] })).status, 403);
	assert.equal((await app.call("POST /v1/browser", CLIENT, { version: 1, service: "s", environment: "e", events: [] })).status, 202);
	assert.equal((await app.call("POST /v1/sourcemaps", "autter_rtu_unknown", { release: "abc", filename: "/a.js", map: MAP })).status, 401);
});

test("static keys: scope upload, inferred from the autter_rtu_ prefix, and unknown scopes dropped", () => {
	const errors: string[] = [];
	const original = console.error;
	console.error = (line: string) => errors.push(line);
	let keys;
	try {
		keys = parseIngestKeys(JSON.stringify([
			{ key: "autter_rt_a", orgId: "o", repositoryId: "r" },
			{ key: "autter_rtu_b", orgId: "o", repositoryId: "r" },
			{ key: "ci-key", orgId: "o", repositoryId: "r", scope: "upload" },
			{ key: "autter_rtu_c", orgId: "o", repositoryId: "r", scope: "server" },
			{ key: "autter_rtc_d", orgId: "o", repositoryId: "r", scope: "client", allowedOrigins: ["https://a.test"] },
			{ key: "typo", orgId: "o", repositoryId: "r", scope: "uploads" },
			{ key: "no-tenant" },
		]));
	} finally {
		console.error = original;
	}
	assert.deepEqual(keys.map((k) => [k.key, k.scope]), [
		["autter_rt_a", "server"],
		["autter_rtu_b", "upload"],
		["ci-key", "upload"],
		// An explicit scope wins over the prefix.
		["autter_rtu_c", "server"],
		["autter_rtc_d", "client"],
	]);
	assert.deepEqual(keys[4]!.allowedOrigins, ["https://a.test"]);
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /AUTTER_INGEST_KEYS\[5\] has scope "uploads"; expected one of server, client, upload/);
	assert.equal(defaultScopeFor("autter_rtu_x"), "upload");
	assert.equal(defaultScopeFor("autter_rtc_x"), "server");
	assert.deepEqual(parseIngestKeys("not json"), []);
});

test("KeyResolver: static entries built in code, and validator answers with an upload scope", async (t) => {
	const resolver = new KeyResolver({
		...config(),
		ingestKeys: [
			{ key: "autter_rtu_static", orgId: "o", repositoryId: "r" },
			{ key: "bad", orgId: "o", repositoryId: "r", scope: "admin" as never },
		],
	});
	assert.equal((await resolver.resolve("autter_rtu_static"))?.scope, "upload");
	assert.equal(await resolver.resolve("bad"), null);

	const seen: IncomingHttpHeaders[] = [];
	const answers: Record<string, unknown> = {
		autter_rtu_cloud: { orgId: "o", repositoryId: "r", scope: "upload" },
		autter_rtu_noscope: { orgId: "o", repositoryId: "r" },
		autter_rt_cloud: { orgId: "o", repositoryId: "r", scope: "server" },
		future: { orgId: "o", repositoryId: "r", scope: "read" },
	};
	const validator = createServer((req, res) => {
		seen.push(req.headers);
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const answer = answers[(JSON.parse(body) as { key: string }).key];
			res.writeHead(answer ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(answer ?? {}));
		});
	});
	validator.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => validator.once("listening", resolve));
	t.after(() => new Promise<void>((resolve) => validator.close(() => resolve())));
	const cloud = new KeyResolver({
		...config(),
		ingestKeys: [],
		keyValidatorUrl: `http://127.0.0.1:${(validator.address() as AddressInfo).port}/runtime/validate-key`,
		keyValidatorToken: "secret",
	});
	assert.equal((await cloud.resolve("autter_rtu_cloud"))?.scope, "upload");
	assert.equal((await cloud.resolve("autter_rtu_noscope"))?.scope, "upload");
	assert.equal((await cloud.resolve("autter_rt_cloud"))?.scope, "server");
	// A scope this ingester doesn't enforce is refused, not treated as server.
	assert.equal(await cloud.resolve("future"), null);
	// The validator learns which ingester asks, so it can tell whether upload
	// scopes are enforced (1.7.0+).
	assert.equal(seen[0]!["x-autter-ingester-version"], ingesterVersion());
	assert.equal(seen[0]!.authorization, "Bearer secret");
});
