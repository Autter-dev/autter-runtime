import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
	isLocalAddress,
	loadConfig,
	LOCAL_DEV_KEY,
	localDevMode,
	withLocalDevKey,
	type IngesterConfig,
	type StaticIngestKey,
} from "./config.js";
import { createIngesterApp } from "./server.js";

/**
 * The built-in local key (`autter_rt_local_dev_only`) that makes the repo's
 * `docker compose up` work without a key step. It must stay useless anywhere
 * else: only AUTTER_LOCAL_DEV=1 enables it, that flag is refused next to a
 * key validator, a listed copy is ignored without the flag, and requests
 * with it are refused from addresses that are not loopback or private.
 */

const EMPTY_TRACES = { resourceSpans: [] };

function config(extra: Partial<IngesterConfig>): IngesterConfig {
	return { ...loadConfig(), clickhouseUrl: "http://127.0.0.1:1", ingestKeys: [], ...extra };
}

async function start(cfg: IngesterConfig) {
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
	const stub = store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) stub[name] = async () => {};
	}
	stub.ensureSchema = async () => {};
	stub.probe = async () => ({ state: "up", checkedAt: new Date().toISOString(), latencyMs: 0 });
	stub.recentOccurrenceTraceIds = async () => [];
	stub.ping = async () => true;
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		errors,
		post: (key: string, headers: Record<string, string> = {}) =>
			fetch(`${base}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
				body: JSON.stringify(EMPTY_TRACES),
			}),
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

test("the local key has the server key format", () => {
	assert.match(LOCAL_DEV_KEY, /^autter_rt_/);
	assert.doesNotMatch(LOCAL_DEV_KEY, /^autter_rt[cu]_/);
});

test("AUTTER_LOCAL_DEV is off unless set, and refused next to a key validator", () => {
	assert.equal(localDevMode(undefined, null), false);
	assert.equal(localDevMode("", null), false);
	assert.equal(localDevMode("0", null), false);
	assert.equal(localDevMode("false", null), false);
	assert.equal(localDevMode("1", null), true);
	assert.equal(localDevMode("true", null), true);
	assert.equal(localDevMode("0", "https://api.autter.dev/runtime/validate-key"), false);
	assert.throws(
		() => localDevMode("1", "https://api.autter.dev/runtime/validate-key"),
		/cannot be combined with AUTTER_KEY_VALIDATOR_URL/,
	);
});

test("loadConfig refuses to start with AUTTER_LOCAL_DEV and a key validator", (t) => {
	const saved = { dev: process.env.AUTTER_LOCAL_DEV, url: process.env.AUTTER_KEY_VALIDATOR_URL };
	t.after(() => {
		for (const [name, value] of [
			["AUTTER_LOCAL_DEV", saved.dev],
			["AUTTER_KEY_VALIDATOR_URL", saved.url],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	process.env.AUTTER_LOCAL_DEV = "1";
	process.env.AUTTER_KEY_VALIDATOR_URL = "https://api.autter.dev/runtime/validate-key";
	assert.throws(() => loadConfig(), /AUTTER_LOCAL_DEV/);
	delete process.env.AUTTER_KEY_VALIDATOR_URL;
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		const cfg = loadConfig();
		assert.equal(cfg.localDev, true);
		assert.deepEqual(
			cfg.ingestKeys.filter((entry) => entry.key === LOCAL_DEV_KEY),
			[{ key: LOCAL_DEV_KEY, orgId: "local", repositoryId: "local", scope: "server" }],
		);
	} finally {
		console.warn = originalWarn;
	}
	delete process.env.AUTTER_LOCAL_DEV;
	assert.deepEqual(
		loadConfig().ingestKeys.filter((entry) => entry.key === LOCAL_DEV_KEY),
		[],
	);
});

test("a listed copy of the local key is dropped without local dev mode", () => {
	const mine: StaticIngestKey = { key: "autter_rt_mine", orgId: "o", repositoryId: "r" };
	const listed: StaticIngestKey = { key: LOCAL_DEV_KEY, orgId: "o", repositoryId: "r" };
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	try {
		assert.deepEqual(withLocalDevKey([mine, listed], false), [mine]);
	} finally {
		console.error = originalError;
	}
	assert.match(errors.join("\n"), /only an ingester started with AUTTER_LOCAL_DEV=1 accepts/);
	// Local mode keeps the user's keys and adds the built-in one once.
	assert.deepEqual(withLocalDevKey([mine, listed], true), [
		mine,
		{ key: LOCAL_DEV_KEY, orgId: "local", repositoryId: "local", scope: "server" },
	]);
});

test("loopback and private addresses are local; public ones are not", () => {
	for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "172.17.0.1", "172.31.255.1", "192.168.65.1", "::ffff:172.18.0.1", "fd00::1", "fe80::1"]) {
		assert.equal(isLocalAddress(address), true, address);
	}
	for (const address of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8", "", undefined]) {
		assert.equal(isLocalAddress(address), false, String(address));
	}
});

test("local dev mode accepts the local key from this machine", async (t) => {
	const app = await start(config({ localDev: true, ingestKeys: withLocalDevKey([], true) }));
	t.after(app.close);
	const res = await app.post(LOCAL_DEV_KEY);
	assert.equal(res.status, 200, await res.text());
	// X-Forwarded-For can't move a request off this machine, or onto it.
	const forwarded = await app.post(LOCAL_DEV_KEY, { "x-forwarded-for": "8.8.8.8" });
	assert.equal(forwarded.status, 200);
	// Any other key is still refused.
	assert.equal((await app.post("autter_rt_not_a_key")).status, 401);
});

test("without local dev mode the local key is refused, even when listed", async (t) => {
	const listed = [{ key: LOCAL_DEV_KEY, orgId: "o", repositoryId: "r", scope: "server" as const }];
	for (const cfg of [config({}), config({ ingestKeys: listed }), config({ localDev: false, ingestKeys: listed })]) {
		const app = await start(cfg);
		t.after(app.close);
		const res = await app.post(LOCAL_DEV_KEY);
		assert.equal(res.status, 401);
		assert.deepEqual(await res.json(), { error: "invalid ingest key" });
	}
});
