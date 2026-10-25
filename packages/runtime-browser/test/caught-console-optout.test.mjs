// RF-04 (browser): captureLoggedErrors: false leaves console.error untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flush, initAutterBrowser } from "../dist/index.js";

const sent = [];
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible", scripts: [] };
globalThis.location = { href: "https://app.example.test/", pathname: "/", origin: "https://app.example.test" };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	sendBeacon(_url, body) { sent.push(body); return true; },
} });
console.error = () => {}; // quiet; init must leave it exactly this
const original = console.error;
initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false, captureNetworkFailures: false, captureLoggedErrors: false });

test("console.error is not patched and nothing is captured from it", async () => {
	assert.equal(console.error, original, "console.error left as it was");
	console.error("quiet", new Error("not captured"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	flush();
	assert.ok(!sent.some((b) => /not captured/.test(String(b))), "no capture queued");
});
