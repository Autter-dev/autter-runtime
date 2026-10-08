import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, captureMessage, flush, initAutterBrowser, scrubText } from "../dist/index.js";

test("JWT scrubbing stays linear on long dash-joined runs", () => {
	const started = Date.now();
	scrubText("eyJ-".repeat(16384));
	assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
});

test("custom patterns ignore g/y, cut-off secrets are masked whole, hostile context never throws", async () => {
	const sent = [];
	globalThis.location = { href: "https://app.example.test/", pathname: "/", origin: "https://app.example.test" };
	globalThis.window = { fetch: async () => ({ status: 200 }), addEventListener() {} };
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
		redact: { keys: /internal/g, values: [/ORD-\d{5}/] },
	});

	captureMessage("orders ORD-12345 and ORD-67890", "warning", { internal_a: "x", internal_b: "y", internal_c: "z" });
	captureMessage(`${"x".repeat(3979)} postgres://admin:hunter2pw@db`);
	const hostile = {};
	Object.defineProperty(hostile, "boom", { enumerable: true, get() { throw new Error("getter"); } });
	assert.doesNotThrow(() => captureException(new Error("still reported"), { nested: hostile }));
	flush();

	const { events } = JSON.parse(await sent[0].text());
	assert.equal(events[0].message, "orders [redacted] and [redacted]");
	for (const key of ["internal_a", "internal_b", "internal_c"]) assert.equal(events[0].context[key], "[redacted]", key);
	assert.ok(!events[1].message.includes("hunt"), "partial password leaked at the cut");
	assert.ok(events[1].message.length <= 4000);
	assert.equal(events[2].message, "still reported");
});
