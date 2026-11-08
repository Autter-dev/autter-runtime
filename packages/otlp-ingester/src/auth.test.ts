import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
	KeyResolver,
	VALIDATOR_CACHE_TTL_MS,
	VALIDATOR_RETRY_MS,
	VALIDATOR_STALE_CAP_MS,
	type KeyResolution,
} from "./auth.js";
import { loadConfig } from "./config.js";

/**
 * How validator answers and failures are cached (1.12.0). Only a definite
 * refusal (404, 410, or a 2xx without a usable tenant) is an invalid key;
 * a 5xx, another 4xx, a timeout or a network error never caches a negative
 * answer: the last good answer is used under the stale cap, otherwise the
 * key is key_unverified (the server answers 503 with Retry-After).
 */

const KEY = `autter_rt_${"1".repeat(48)}`;
const TENANT = { orgId: "org-a", repositoryId: "repo-a", scope: "server" };

type Mode = { status: number; body?: unknown } | "reset";

/** A validator whose next answers the test sets, counting the calls it gets. */
async function validator(t: TestContext) {
	const state = { mode: { status: 200, body: TENANT } as Mode, calls: 0 };
	const server = createServer((req, res) => {
		state.calls += 1;
		req.resume();
		req.on("end", () => {
			const mode = state.mode;
			if (mode === "reset") {
				req.socket.destroy();
				return;
			}
			const body = mode.body === undefined ? "" : typeof mode.body === "string" ? mode.body : JSON.stringify(mode.body);
			res.writeHead(mode.status, { "content-type": "application/json" }).end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/runtime/validate-key` };
}

function resolver(url: string) {
	const clock = { now: 1_000_000 };
	const keys = new KeyResolver({ ...loadConfig(), ingestKeys: [], keyValidatorUrl: url }, { now: () => clock.now });
	return { keys, clock };
}

const quietly = (t: TestContext) => t.mock.method(console, "warn", () => {});

function unverified(resolution: KeyResolution): number {
	assert.equal(resolution.ctx, null);
	assert.equal(resolution.failure, "key_unverified");
	return (resolution as { retryAfterSeconds: number }).retryAfterSeconds;
}

test("outage, then recovery: a known key keeps working, and is checked again once the validator is back", async (t) => {
	quietly(t);
	const v = await validator(t);
	const { keys, clock } = resolver(v.url);

	assert.equal((await keys.resolveDetailed(KEY)).ctx?.orgId, "org-a");
	assert.equal(v.state.calls, 1);

	// The validator goes down after the fresh answer expires: the last good
	// answer is served, never a negative one.
	v.state.mode = { status: 503 };
	clock.now += VALIDATOR_CACHE_TTL_MS;
	assert.equal((await keys.resolveDetailed(KEY)).ctx?.orgId, "org-a");
	assert.equal(v.state.calls, 2);
	// Inside the retry window the validator is not asked again.
	clock.now += VALIDATOR_RETRY_MS - 1;
	assert.equal((await keys.resolveDetailed(KEY)).ctx?.orgId, "org-a");
	assert.equal(v.state.calls, 2);
	// Network errors and timeouts are treated the same way.
	v.state.mode = "reset";
	clock.now += 1;
	assert.equal((await keys.resolveDetailed(KEY)).ctx?.orgId, "org-a");
	assert.equal(v.state.calls, 3);

	// Recovery with a changed answer: the next check picks it up.
	v.state.mode = { status: 200, body: { ...TENANT, repositoryId: "repo-b" } };
	clock.now += VALIDATOR_RETRY_MS;
	assert.equal((await keys.resolveDetailed(KEY)).ctx?.repositoryId, "repo-b");
	assert.equal(v.state.calls, 4);
});

test("outage, then recovery: a key first seen during the outage is accepted once the validator is back", async (t) => {
	quietly(t);
	const v = await validator(t);
	const { keys, clock } = resolver(v.url);

	// The reported bug: a 5xx was cached as a negative answer for 60 s and
	// answered with a 401, which exporters never retry.
	v.state.mode = { status: 500 };
	assert.equal(unverified(await keys.resolveDetailed(KEY)), VALIDATOR_RETRY_MS / 1000);
	clock.now += 2_000;
	assert.equal(unverified(await keys.resolveDetailed(KEY)), (VALIDATOR_RETRY_MS - 2_000) / 1000);
	assert.equal(v.state.calls, 1);

	v.state.mode = { status: 200, body: TENANT };
	clock.now += VALIDATOR_RETRY_MS;
	assert.equal((await keys.resolveDetailed(KEY)).ctx?.orgId, "org-a");
	assert.equal(v.state.calls, 2);
});

test("stale cap: a good answer older than the cap is not used, and the key is unverified (503), not invalid", async (t) => {
	quietly(t);
	const v = await validator(t);
	const { keys, clock } = resolver(v.url);
	assert.ok(await keys.resolve(KEY));
	const answeredAt = clock.now;

	v.state.mode = { status: 502 };
	clock.now = answeredAt + VALIDATOR_STALE_CAP_MS - 1;
	assert.ok(await keys.resolve(KEY), "still under the cap");
	clock.now = answeredAt + VALIDATOR_STALE_CAP_MS;
	assert.equal(unverified(await keys.resolveDetailed(KEY)), VALIDATOR_RETRY_MS / 1000);
	// Past the cap, the validator is still asked on every retry window.
	const calls = v.state.calls;
	clock.now += VALIDATOR_RETRY_MS;
	unverified(await keys.resolveDetailed(KEY));
	assert.equal(v.state.calls, calls + 1);

	v.state.mode = { status: 200, body: TENANT };
	clock.now += VALIDATOR_RETRY_MS;
	assert.ok(await keys.resolve(KEY), "accepted again after recovery");
});

test("a definite refusal is an invalid key (401), cached for the TTL", async (t) => {
	quietly(t);
	const v = await validator(t);
	const { keys, clock } = resolver(v.url);

	v.state.mode = { status: 404, body: { error: "unknown or revoked key" } };
	assert.deepEqual(await keys.resolveDetailed(KEY), { ctx: null, failure: "unknown_key" });
	clock.now += VALIDATOR_CACHE_TTL_MS - 1;
	v.state.mode = { status: 200, body: TENANT };
	assert.deepEqual(await keys.resolveDetailed(KEY), { ctx: null, failure: "unknown_key" });
	assert.equal(v.state.calls, 1);
	// A key created since is accepted once the refusal expires.
	clock.now += 1;
	assert.ok(await keys.resolve(KEY));

	// 410, and a 2xx that names no tenant or a scope this ingester doesn't
	// know, are refusals too.
	for (const [n, mode] of [
		[2, { status: 410 }],
		[3, { status: 200, body: {} }],
		[4, { status: 200, body: { ...TENANT, scope: "read" } }],
	] as const) {
		v.state.mode = mode;
		assert.deepEqual(await keys.resolveDetailed(`autter_rt_${String(n).repeat(48)}`), { ctx: null, failure: "unknown_key" });
	}
});

test("a refusal is not reused once it expires during an outage", async (t) => {
	quietly(t);
	const v = await validator(t);
	const { keys, clock } = resolver(v.url);
	v.state.mode = { status: 404 };
	assert.equal((await keys.resolveDetailed(KEY)).failure, "unknown_key");
	v.state.mode = { status: 500 };
	clock.now += VALIDATOR_CACHE_TTL_MS;
	unverified(await keys.resolveDetailed(KEY));
});

test("validator answers that are not about the key are failures, not refusals", async (t) => {
	const warn = quietly(t);
	const v = await validator(t);
	for (const [n, mode] of [
		[1, { status: 401, body: { error: "unauthorized" } }], // wrong AUTTER_KEY_VALIDATOR_TOKEN
		[2, { status: 403 }],
		[3, { status: 429 }],
		[4, { status: 400 }],
		[5, { status: 200, body: "<html>proxy error</html>" }], // unreadable 2xx
		[6, { status: 500 }],
	] as const) {
		const { keys } = resolver(v.url);
		v.state.mode = mode;
		unverified(await keys.resolveDetailed(`autter_rt_${String(n).repeat(48)}`));
	}
	// Each resolver logged its first failure; one log line per interval each.
	const logged = warn.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.startsWith("key validator"));
	assert.equal(logged.length, 6);
	assert.match(logged[0]!, /^key validator could not answer \(HTTP 401\)/);

	// An unreachable validator.
	const { keys } = resolver("http://127.0.0.1:1/validate");
	unverified(await keys.resolveDetailed(KEY));
});

test("static keys and a missing validator are unaffected", async () => {
	const keys = new KeyResolver({ ...loadConfig(), ingestKeys: [{ key: KEY, orgId: "o", repositoryId: "r" }], keyValidatorUrl: null });
	assert.equal((await keys.resolve(KEY))?.orgId, "o");
	assert.deepEqual(await keys.resolveDetailed("other"), { ctx: null, failure: "unknown_key" });
});
