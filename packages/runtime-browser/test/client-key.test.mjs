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
