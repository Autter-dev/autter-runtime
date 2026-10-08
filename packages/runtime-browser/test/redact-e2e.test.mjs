import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, captureMessage, flush, initAutterBrowser, setContext } from "../dist/index.js";

test("messages, stacks and nested context are scrubbed before the beacon is sent", async () => {
	const listeners = new Map();
	const sent = [];
	globalThis.location = { href: "https://app.example.test/", pathname: "/", origin: "https://app.example.test" };
	globalThis.window = { fetch: async () => ({ status: 200 }), addEventListener(name, cb) { listeners.set(name, cb); } };
	globalThis.document = { addEventListener() {}, visibilityState: "visible", scripts: [] };
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { userAgent: "", sendBeacon(_url, body) { sent.push(body); return true; } },
	});

	initAutterBrowser({
		endpoint: "/api/autter-runtime",
		service: "web",
		sessionTracking: false,
		captureTimings: false,
		captureNetworkFailures: false,
		captureActions: false,
		// Customer-supplied patterns extend the built-ins.
		redact: { keys: /^internal_ref$/, values: [/ORD-\d{5}/g] },
	});
	setContext({ checkout: { cardNumber: "4111111111111111", step: "pay" } });

	const err = new Error("POST /login failed: {\"password\":\"hunter2\"} for jane@example.com");
	err.stack = `${err.name}: ${err.message}\n    at submit (https://app.example.test/app.js:1:1)`;
	captureException(err, {
		internal_ref: "abc",
		request: { headers: { authorization: "Bearer abcdefghijklmnop123" }, url: "/cb?access_token=tok123456" },
	});
	captureMessage("payment for ORD-12345 used token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpM");
	listeners.get("unhandledrejection")({ reason: new Error("redis://:cachepw@cache:6379 down") });
	flush();

	const body = await sent[0].text();
	for (const secret of ["hunter2", "jane@example.com", "4111111111111111", "abcdefghijklmnop123",
		"tok123456", "ORD-12345", "eyJhbGciOiJIUzI1NiJ9", "cachepw"]) {
		assert.ok(!body.includes(secret), `leaked: ${secret}`);
	}
	const { events } = JSON.parse(body);
	assert.equal(events[0].message, 'POST /login failed: {"password":"[redacted]"} for [redacted]');
	assert.match(events[0].stack, /at submit \(https:\/\/app\.example\.test\/app\.js:1:1\)/);
	assert.equal(events[0].context.internal_ref, "[redacted]");
	assert.equal(events[0].context.checkout.step, "pay");
	assert.equal(events[0].context.request.url, "/cb?access_token=[redacted]");
	assert.equal(events[2].message, "redis://[redacted]@cache:6379 down");
});
