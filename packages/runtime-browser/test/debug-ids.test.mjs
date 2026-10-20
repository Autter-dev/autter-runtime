import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, flush, initAutterBrowser } from "../dist/index.js";

const APP_ID = "4f3c6a1e-9b2d-4e8f-a1b2-c3d4e5f60718";
const VENDOR_ID = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const LAZY_ID = "11111111-2222-4333-8444-555555555555";

test("exceptions carry debugIds for the injected scripts in their stack, and only those", async () => {
	const sent = [];
	globalThis.location = { href: "https://app.example.test/", pathname: "/", origin: "https://app.example.test" };
	globalThis.window = { addEventListener() {}, history: {} };
	globalThis.document = { addEventListener() {}, visibilityState: "visible", scripts: [] };
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { userAgent: "test", sendBeacon(_url, body) { sent.push(body); return true; } },
	});
	// What the `autter-runtime sourcemaps inject` snippet registers: the stack
	// of an Error created at the top of each bundle (Chrome, Firefox, Safari).
	globalThis._autterDebugIds = {
		"Error\n    at https://app.example.test/assets/app-1a2b.js?v=3:1:120": APP_ID,
		"@https://cdn.example.test/vendor.js:1:88\n": VENDOR_ID,
		"global code@https://app.example.test/assets/lazy.js:1:77": LAZY_ID,
		"not a stack": "ignored",
	};

	initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false, captureNetworkFailures: false });

	const error = new Error("boom");
	error.stack = [
		"Error: boom",
		"    at checkout (https://app.example.test/assets/app-1a2b.js?v=3:1:5012)",
		"    at https://cdn.example.test/vendor.js:2:40",
		"    at https://cdn.example.test/other.js:1:1",
	].join("\n");
	captureException(error);
	captureException("no stack at all");
	flush();

	const { events } = JSON.parse(await sent[0].text());
	assert.deepEqual(events[0].debugIds, {
		"https://app.example.test/assets/app-1a2b.js": APP_ID,
		"https://cdn.example.test/vendor.js": VENDOR_ID,
	});
	assert.equal("debugIds" in events[1], false);

	// A missing or hostile registry never stops the error from being sent.
	globalThis._autterDebugIds = new Proxy({}, { ownKeys() { throw new Error("nope"); } });
	captureException(error);
	globalThis._autterDebugIds = undefined;
	captureException(error);
	flush();
	const later = JSON.parse(await sent[1].text()).events;
	assert.equal(later.length, 2);
	assert.ok(later.every((event) => event.message === "boom" && !("debugIds" in event)));
});
