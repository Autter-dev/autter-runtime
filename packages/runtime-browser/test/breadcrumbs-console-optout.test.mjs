import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, flush, initAutterBrowser } from "../dist/index.js";
import { addBreadcrumb, enableBreadcrumbs } from "../dist/breadcrumbs.js";

test("console capture is opt-out; requests and custom steps still record", async () => {
	const sent = [];
	globalThis.window = { fetch: async () => new Response("", { status: 401 }), addEventListener() {} };
	globalThis.document = { addEventListener() {}, visibilityState: "visible" };
	globalThis.location = { href: "https://app.example.test/", pathname: "/" };
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
		sendBeacon(_url, body) { sent.push(body); return true; },
	} });
	const warn = () => {};
	console.warn = warn;
	enableBreadcrumbs({ console: false }); // before init works too
	initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false });
	assert.equal(console.warn, warn, "console left untouched");
	console.warn("not recorded");
	await window.fetch("/api/me");
	addBreadcrumb({ type: "log", level: "info", message: "signed out" });
	captureException(new Error("x"));
	flush();
	const [event] = JSON.parse(await sent[0].text()).events;
	assert.deepEqual(event.breadcrumbs.map((c) => [c.type, c.message]), [
		["request", "GET /api/me 401"],
		["log", "signed out"],
	]);
});
