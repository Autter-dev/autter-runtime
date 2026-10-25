import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BurstLimiter,
	CAUGHT_BURST,
	caughtErrorAttributes,
	degradedAttributes,
	formatLogArguments,
	handledErrorKind,
	loggedErrorSources,
	requestOutcome,
} from "../dist/index.js";

test("loggedErrorSources: default on, false off, object turns single sources off", () => {
	assert.deepEqual(loggedErrorSources(undefined), {
		console: true, pino: true, winston: true, bunyan: true, runtimeLogger: true,
	});
	assert.deepEqual(loggedErrorSources(true), loggedErrorSources(undefined));
	assert.deepEqual(loggedErrorSources(false), {
		console: false, pino: false, winston: false, bunyan: false, runtimeLogger: false,
	});
	const partial = loggedErrorSources({ console: false });
	assert.equal(partial.console, false);
	assert.equal(partial.pino, true, "unnamed sources stay on");
});

test("handledErrorKind groups by error type and throw site", () => {
	const a = new Error("boom");
	a.stack = "Error: boom\n    at reserve (/app/checkout.js:12:5)\n    at handler (/app/server.js:1:1)";
	const b = new Error("boom too");
	// A different throw site (first frame), same reporting path below it.
	b.stack = "Error: boom too\n    at charge (/app/billing.js:40:9)\n    at handler (/app/server.js:1:1)";
	const c = new TypeError("boom");
	c.stack = "TypeError: boom\n    at reserve (/app/checkout.js:12:5)";
	const ka = handledErrorKind(a);
	assert.equal(ka.type, "Error");
	assert.equal(handledErrorKind(a).key, ka.key, "same error, same kind");
	assert.notEqual(handledErrorKind(b).key, ka.key, "a different throw site is a different kind");
	assert.notEqual(handledErrorKind(c).key, ka.key, "a different type is a different kind");
	assert.equal(handledErrorKind("not an error").type, "Error");
});

test("formatLogArguments joins the line and skips the reported error", () => {
	const err = new Error("db down");
	assert.equal(formatLogArguments(["lookup failed for", "u1", err], err), "lookup failed for u1");
	assert.equal(formatLogArguments([{ a: 1 }, 2], undefined), '{"a":1} 2');
	assert.ok(formatLogArguments(["x".repeat(5000)], undefined).length <= 1000, "capped at 1000 chars");
});

test("caughtErrorAttributes mark a caught error; the dropped count rides when > 0", () => {
	const base = caughtErrorAttributes("console", "lookup failed");
	assert.equal(base["autter.handled"], true);
	assert.equal(base["autter.handling"], "caught");
	assert.equal(base["autter.log.source"], "console");
	assert.equal(base["autter.log.message"], "lookup failed");
	assert.ok(!("autter.caught.dropped" in base), "no count when none dropped");
	assert.equal(caughtErrorAttributes("pino", undefined, 7)["autter.caught.dropped"], 7);
});

test("degradedAttributes mark a deliberate fallback at warning (reason kept)", () => {
	const attrs = degradedAttributes("pricing service down, using cached prices");
	assert.equal(attrs["autter.handled"], true);
	assert.equal(attrs["autter.handling"], "deliberate");
	assert.equal(attrs["autter.degraded.reason"], "pricing service down, using cached prices");
	assert.equal(degradedAttributes(undefined)["autter.degraded.reason"], "degraded", "empty reason has a default");
});

test("requestOutcome: a deliberate fallback is degraded, below a failure or explicit outcome", () => {
	assert.equal(requestOutcome({ degraded: true, status: 200 }), "degraded");
	assert.equal(requestOutcome({ degraded: true, status: 500 }), "failed", "a 5xx still fails");
	assert.equal(requestOutcome({ degraded: true, thrown: true }), "failed", "a thrown error still fails");
	assert.equal(requestOutcome({ degraded: true, explicit: "succeeded" }), "succeeded", "explicit wins");
	assert.equal(requestOutcome({ status: 200 }), "succeeded");
});

test("BurstLimiter: burst through, then one per refill; the dropped count rides the next pass", () => {
	let now = 0;
	const limiter = new BurstLimiter(CAUGHT_BURST, 10_000, 1000);
	// First CAUGHT_BURST of a kind pass, each carrying no backlog.
	for (let i = 0; i < CAUGHT_BURST; i++) assert.equal(limiter.take("k", "Error", now), 0, `pass ${i}`);
	// The next five are left out (-1) and counted.
	for (let i = 0; i < 5; i++) assert.equal(limiter.take("k", "Error", now), -1);
	// After one refill window a token is back; the pass carries the 5 dropped.
	now += 10_000;
	assert.equal(limiter.take("k", "Error", now), 5);
	// A different kind has its own budget.
	assert.equal(limiter.take("other", "Error", now), 0);
});

test("BurstLimiter.drain reports counts no sent record carried; nextDrainAt schedules them", () => {
	let now = 0;
	const limiter = new BurstLimiter(1, 10_000, 1000);
	assert.equal(limiter.take("k", "TypeError", now), 0); // uses the one token
	assert.equal(limiter.take("k", "TypeError", now), -1); // dropped, counted
	// Nothing to drain yet: the kind has no token, so its count can still ride a later pass.
	assert.deepEqual(limiter.drain(now, false), []);
	assert.ok(limiter.nextDrainAt() > now, "a drain is scheduled for when the token returns");
	// Once a token is back, the uncarried count drains on its own.
	now += 10_000;
	const tails = limiter.drain(now, false);
	assert.deepEqual(tails, [{ key: "k", type: "TypeError", dropped: 1 }]);
	assert.deepEqual(limiter.drain(now, false), [], "counts reset after draining");
});
