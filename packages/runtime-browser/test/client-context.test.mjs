import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flush, initAutterBrowser } from "../dist/index.js";

test("errors carry browser, OS, route trail, and page scripts without a raw user agent", async () => {
	const listeners = new Map();
	const sent = [];
	class Element {
		tagName = "BUTTON";
		closest() { return this; }
		getAttribute(name) { return name === "data-autter-action" ? "checkout" : null; }
	}
	const location = {
		href: "https://app.example.test/cart?token=secret",
		pathname: "/cart",
		origin: "https://app.example.test",
	};
	globalThis.Element = Element;
	globalThis.location = location;
	globalThis.window = {
		fetch: async () => ({ status: 200 }),
		addEventListener(name, cb) { listeners.set(name, cb); },
		history: {
			pushState(_state, _title, url) {
				location.pathname = String(url).split("?")[0];
			},
			replaceState() {},
		},
	};
	globalThis.document = {
		addEventListener(name, cb) { listeners.set(name, cb); },
		visibilityState: "visible",
		scripts: [
			{ src: "https://app.example.test/assets/app.js?token=secret" },
			{ src: "https://cdn.example.test/widget.js?token=secret" },
			{ src: "chrome-extension://abcdefghijklmnop/injected.js?token=secret" },
		],
	};
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			sendBeacon(_url, body) { sent.push(body); return true; },
		},
	});

	initAutterBrowser({
		endpoint: "/api/autter-runtime",
		service: "web",
		sessionTracking: false,
		captureTimings: false,
		captureNetworkFailures: false,
	});

	listeners.get("click")({ type: "click", target: new Element() });
	window.history.pushState({}, "", "/checkout?token=secret");
	listeners.get("error")({
		message: "Script error.",
		filename: "",
		lineno: 0,
		colno: 0,
		target: window,
	});
	listeners.get("error")({
		message: "",
		filename: "",
		target: { tagName: "SCRIPT", src: "https://cdn.example.test/widget.js?token=secret" },
	});
	listeners.get("securitypolicyviolation")({
		disposition: "enforce",
		effectiveDirective: "script-src-elem",
		blockedURI: "https://cdn.example.test/widget.js?token=secret",
		sourceFile: "",
		originalPolicy: "script-src 'self' 'nonce-supersecretnonce'",
	});
	listeners.get("error")({
		message: "later failure",
		filename: "https://app.example.test/assets/app.js",
		lineno: 1,
		colno: 1,
		target: window,
	});
	flush();

	assert.equal(sent.length, 1);
	const body = await sent[0].text();
	assert.ok(!body.includes("token=secret"));
	assert.ok(!body.includes("Macintosh"));
	assert.ok(!body.includes("supersecretnonce"));
	assert.ok(!body.includes("AppleWebKit"));
	const { events, sdk } = JSON.parse(body);
	// The SDK version rides along for the ingester's compatibility records.
	assert.equal(sdk, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
	const scriptError = events.find((event) => event.message === "Script error.");
	assert.equal(scriptError.context["autter.browser"], "Chrome 131");
	assert.equal(scriptError.context["autter.os"], "macOS");
	assert.equal(scriptError.context["autter.crossOriginScript"], true);
	assert.equal(scriptError.context["autter.trail"], "nav:/cart > click:checkout > nav:/checkout");
	assert.equal(
		scriptError.context["autter.scripts"],
		"/assets/app.js | https://cdn.example.test/widget.js | chrome-extension://abcdefghijklmnop",
	);
	const loadError = events.find((event) => event.errorType === "ScriptLoadError");
	assert.equal(loadError.filename, "https://cdn.example.test/widget.js");
	const csp = events.find((event) => event.type === "csp_violation");
	assert.equal(csp.filename, "https://cdn.example.test/widget.js");
	assert.equal(csp.context.cspBlockedOrigin, "https://cdn.example.test");
	assert.match(csp.context.cspPolicyHash, /^[0-9a-f]+$/);
	const later = events.find((event) => event.message === "later failure");
	assert.equal(later.context.cspPolicyHash, csp.context.cspPolicyHash);
});
