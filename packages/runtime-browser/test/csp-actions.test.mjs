import { test } from "node:test";
import assert from "node:assert/strict";
import { flush, initAutterBrowser } from "../dist/index.js";

test("CSP blocks include a safe recent action without DOM text or URLs", async () => {
	const listeners = new Map();
	const sent = [];
	class Element {
		tagName = "BUTTON";
		closest() { return this; }
		getAttribute(name) { return name === "data-autter-action" ? "send-email" : null; }
	}
	globalThis.Element = Element;
	globalThis.window = { fetch: async () => ({ status: 200 }), addEventListener(name, cb) { listeners.set(name, cb); } };
	globalThis.document = { addEventListener(name, cb) { listeners.set(name, cb); }, visibilityState: "visible" };
	globalThis.location = { href: "https://app.example.test/email?token=secret", pathname: "/email" };
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
		sendBeacon(_url, body) { sent.push(body); return true; },
	} });
	initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false, captureNetworkFailures: false });
	listeners.get("click")({ type: "click", target: new Element() });
	listeners.get("securitypolicyviolation")({
		disposition: "enforce", effectiveDirective: "script-src-elem",
		blockedURI: "https://cdn.example.test/private.js?token=secret",
	});
	flush();
	assert.equal(sent.length, 1);
	const { events } = JSON.parse(await sent[0].text());
	assert.equal(events[0].type, "csp_violation");
	assert.equal(events[0].context["autter.action"], "click:send-email");
	assert.equal(events[0].context.cspBlockedOrigin, "https://cdn.example.test");
	assert.ok(!JSON.stringify(events).includes("token=secret"));
});
