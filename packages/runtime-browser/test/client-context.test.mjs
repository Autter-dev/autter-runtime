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
	const { events, sdk, environment } = JSON.parse(body);
	// No environment given on a public host: production.
	assert.equal(environment, "production");
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

test("with no environment option, a page on a local host reports development; an explicit one wins", async () => {
	const cases = [
		["localhost", undefined, "development"],
		["127.0.0.1", undefined, "development"],
		["[::1]", undefined, "development"],
		["shop.local", undefined, "development"],
		["app.localhost", undefined, "development"],
		["localhost.example.com", undefined, "production"],
		["localhost", "staging", "staging"],
	];
	for (const [hostname, environment, expected] of cases) {
		const sent = [];
		globalThis.location = { href: `http://${hostname}/`, pathname: "/", hostname, origin: `http://${hostname}` };
		globalThis.window = { fetch: async () => ({ status: 200 }), addEventListener() {} };
		globalThis.document = { addEventListener() {}, visibilityState: "visible" };
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { sendBeacon(_url, body) { sent.push(body); return true; } } });
		// A fresh copy of the module per case (initAutterBrowser runs once per
		// page). dist/index.js re-exports a shared chunk that holds the state,
		// so import that chunk itself under a new URL.
		const chunk = /from "\.\/(chunk-[\w-]+\.js)"/.exec(readFileSync(new URL("../dist/index.js", import.meta.url), "utf8"))[1];
		const sdk = await import(`../dist/${chunk}?host=${hostname}&env=${environment}`);
		sdk.initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", environment, captureTimings: false, captureNetworkFailures: false, captureActions: false });
		sdk.flush();
		assert.equal(sent.length, 1, hostname);
		assert.equal(JSON.parse(await sent[0].text()).environment, expected, hostname);
	}
});
