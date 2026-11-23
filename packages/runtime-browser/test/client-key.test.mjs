import { test } from "node:test";
import assert from "node:assert/strict";
import { flush, initAutterBrowser, trackEvent } from "../dist/index.js";

// A secret key or personal access token in clientKey would go into ?key=
// (CDN and proxy logs). The SDK refuses it: console.error, nothing is sent.

const sent = [];
const errors = [];
globalThis.window = { fetch: async () => new Response("{}"), addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = { href: "https://app.example.test/", pathname: "/" };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { sendBeacon(url) { sent.push(url); return true; } } });
globalThis.fetch = async (url) => {
	sent.push(String(url));
	return new Response(null, { status: 202 });
};
console.error = (...args) => errors.push(args.join(" "));

test("a server key in clientKey is refused: console.error, nothing sent", async () => {
	initAutterBrowser({
		endpoint: "https://collector.example.test/v1/browser",
		clientKey: "autter_rt_supersecretsupersecret",
		service: "web",
		captureTimings: false,
		captureErrors: false,
	});
	trackEvent("x");
	flush();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, []);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /clientKey is a runtime server key \(autter_rt_…\), not a client key\./);
	assert.match(errors[0], /Settings > Keys and tokens\./);
	assert.ok(!errors[0].includes("supersecret"));
});

test("a missing endpoint or service, or a release or environment that is too long, is refused: console.error, no patches, nothing sent", async () => {
	const appFetch = window.fetch;
	const cases = [
		[{ clientKey: "autter_rtc_public", service: "web" }, /needs endpoint/],
		[{ endpoint: "https://collector.example.test/v1/browser", clientKey: "autter_rtc_public" }, /needs service \(your app's name, 1 to 200 characters\)/],
		[{ endpoint: "/api/autter-runtime", service: "x".repeat(201) }, /needs service/],
		[{ endpoint: "/api/autter-runtime", service: "web", release: "r".repeat(201) }, /needs release \(at most 200 characters\)/],
		[{ endpoint: "/api/autter-runtime", service: "web", environment: "e".repeat(101) }, /needs environment/],
	];
	for (const [options, message] of cases) {
		errors.length = 0;
		assert.doesNotThrow(() => initAutterBrowser({ ...options, captureTimings: false }));
		assert.equal(errors.length, 1);
		assert.match(errors[0], message);
		assert.match(errors[0], /Nothing is sent\.$/);
		// Not started: calls are no-ops and nothing is patched.
		assert.doesNotThrow(() => trackEvent("ignored"));
		flush();
		assert.equal(window.fetch, appFetch);
	}
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, []);
	errors.length = 1;
});

test("a client key is still accepted after a refused init", async () => {
	initAutterBrowser({
		endpoint: "https://collector.example.test/v1/browser",
		clientKey: "autter_rtc_public",
		service: "web",
		sessionTracking: false,
		captureTimings: false,
		captureErrors: false,
	});
	trackEvent("y");
	flush();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sent.length, 1);
	assert.match(sent[0], /key=autter_rtc_public$/);
	assert.equal(errors.length, 1);
});
