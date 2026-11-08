import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { KeyResolver, type KeyResolverOptions } from "./auth.js";
import { loadConfig } from "./config.js";

/**
 * Key lookups against a real HTTP validator that counts its calls: the
 * abuses reported against 1.11.0 (a validator POST per junk key, none of
 * them deduplicated, junk keys evicting known-good ones).
 */

const GOOD = `autter_rt_${"1".repeat(48)}`;
const OTHER_GOOD = `autter_rt_${"2".repeat(48)}`;

interface Validator {
	url: string;
	calls: string[];
	/** Delay before answering, so concurrent lookups overlap. */
	delayMs: number;
	revoked: Set<string>;
	server: Server;
}

async function validator(): Promise<Validator> {
	const state = { calls: [] as string[], delayMs: 20, revoked: new Set<string>() };
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const { key } = JSON.parse(raw) as { key: string };
			state.calls.push(key);
			setTimeout(() => {
				if ((key === GOOD || key === OTHER_GOOD) && !state.revoked.has(key)) {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ orgId: "org", repositoryId: key === GOOD ? "repo" : "repo-2", scope: "server" }));
					return;
				}
				res.writeHead(404).end();
			}, state.delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return Object.assign(state, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/validate`, server });
}

function resolver(v: Validator, options: KeyResolverOptions = {}) {
	return new KeyResolver({ ...loadConfig(), ingestKeys: [], keyValidatorUrl: v.url }, options);
}

test("50 concurrent lookups of one unknown key make one validator call", async (t) => {
	const v = await validator();
	t.after(() => v.server.close());
	const keys = resolver(v);
	const junk = `autter_rt_${"f".repeat(48)}`;
	const results = await Promise.all(Array.from({ length: 50 }, () => keys.resolveDetailed(junk)));
	assert.equal(v.calls.length, 1);
	assert.ok(results.every((r) => r.ctx === null && r.failure === "unknown_key"));
	// And it is cached (negatively): the next 50 cost nothing.
	await Promise.all(Array.from({ length: 50 }, () => keys.resolveDetailed(junk)));
	assert.equal(v.calls.length, 1);
});

test("50 concurrent lookups of one good key make one validator call", async (t) => {
	const v = await validator();
	t.after(() => v.server.close());
	const keys = resolver(v);
	const results = await Promise.all(Array.from({ length: 50 }, () => keys.resolve(GOOD)));
	assert.equal(v.calls.length, 1);
	assert.ok(results.every((ctx) => ctx?.repositoryId === "repo"));
});

test("junk keys never evict a known-good key (separate negative cache)", async (t) => {
	const v = await validator();
	v.delayMs = 0;
	t.after(() => v.server.close());
	// Tiny caches so the flood is far bigger than both.
	const keys = resolver(v, { knownKeys: 2, unknownKeys: 5 });
	assert.ok(await keys.resolve(GOOD));
	for (let i = 0; i < 200; i++) await keys.resolve(`autter_rt_junk${String(i).padStart(44, "0")}`);
	const before = v.calls.length;
	assert.equal((await keys.resolve(GOOD))?.repositoryId, "repo");
	assert.equal(v.calls.length, before, "GOOD answered from cache after 200 junk keys");
	assert.equal(keys.peek(GOOD)?.repositoryId, "repo");
});

test("the gate is asked only for keys in neither cache; refusal makes no call", async (t) => {
	const v = await validator();
	t.after(() => v.server.close());
	let now = 0;
	const keys = resolver(v, { now: () => now });
	let asked = 0;
	const closed = () => {
		asked++;
		return false;
	};
	const limited = await keys.resolveDetailed(`autter_rt_${"e".repeat(48)}`, closed);
	assert.deepEqual(limited, { ctx: null, failure: "lookup_limited" });
	assert.equal(v.calls.length, 0);

	// A known key that expired is refreshed without asking the gate.
	await keys.resolve(GOOD);
	now += 120_000;
	asked = 0;
	assert.equal((await keys.resolveDetailed(GOOD, closed)).ctx?.repositoryId, "repo");
	assert.equal(asked, 0);
	assert.equal(v.calls.length, 2);

	// Concurrent requests for one new key spend the budget once.
	asked = 0;
	const open = () => {
		asked++;
		return true;
	};
	await Promise.all(Array.from({ length: 20 }, () => keys.resolveDetailed(OTHER_GOOD, open)));
	assert.equal(asked, 1);
	assert.equal(v.calls.length, 3);
});

test("keys that can't be keys never reach the validator", async (t) => {
	const v = await validator();
	t.after(() => v.server.close());
	const keys = resolver(v);
	for (const key of ["x".repeat(513), "has space", "tab\there", "ümlaut"]) {
		assert.equal((await keys.resolveDetailed(key)).failure, "unknown_key");
	}
	assert.equal(v.calls.length, 0);
});

test("a revoked key leaves the known cache: an outage can't bring it back", async (t) => {
	const v = await validator();
	t.after(() => v.server.close());
	let now = 0;
	const keys = resolver(v, { now: () => now });
	assert.ok(await keys.resolve(GOOD));
	v.revoked.add(GOOD);
	now += 120_000;
	assert.equal(await keys.resolve(GOOD), null);
	assert.equal(keys.peek(GOOD), null);
	// Validator down: the stale answer is the refusal, not the old tenant.
	v.server.close();
	now += 120_000;
	assert.equal(await keys.resolve(GOOD), null);
});
