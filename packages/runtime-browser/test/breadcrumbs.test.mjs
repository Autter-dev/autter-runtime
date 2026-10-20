import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, captureMessage, flush, initAutterBrowser, trackEvent } from "../dist/index.js";
import { addBreadcrumb, clearBreadcrumbs, enableBreadcrumbs, MAX_BREADCRUMBS } from "../dist/breadcrumbs.js";

// One browser per file: the tracker and the breadcrumb buffer are module state.
const listeners = new Map();
const sent = [];
const consoleCalls = [];
let fetchStatus = 200;

class Element {
	constructor(action) {
		this.action = action;
		this.tagName = "BUTTON";
	}
	closest() { return this; }
	getAttribute(name) { return name === "data-autter-action" ? this.action : null; }
}

class FakeXHR {
	status = 0;
	listeners = new Map();
	open(_method, _url) {}
	send() {}
	addEventListener(name, callback) { this.listeners.set(name, callback); }
	removeEventListener(name, callback) {
		if (this.listeners.get(name) === callback) this.listeners.delete(name);
	}
	emit(name) { this.listeners.get(name)?.call(this); }
}

globalThis.Element = Element;
globalThis.XMLHttpRequest = FakeXHR;
globalThis.location = { href: "https://app.example.test/", pathname: "/" };
globalThis.window = {
	fetch: async () => new Response("{}", { status: fetchStatus }),
	addEventListener(name, cb) { listeners.set(name, cb); },
	history: {
		pushState(_state, _title, url) { location.pathname = String(url).split("?")[0]; },
		replaceState(_state, _title, url) { location.pathname = String(url).split("?")[0]; },
	},
};
globalThis.document = { addEventListener(name, cb) { listeners.set(name, cb); }, visibilityState: "visible" };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	sendBeacon(_url, body) { sent.push(body); return true; },
} });
// Stand-ins for the real console, so the test can see the originals still run.
console.warn = (...args) => consoleCalls.push(["warn", ...args]);
console.error = (...args) => consoleCalls.push(["error", ...args]);

initAutterBrowser({ endpoint: "https://collector.example.test/v1/browser", service: "web", sessionTracking: false, captureTimings: false });
enableBreadcrumbs();

async function lastEvents() {
	flush();
	const payload = JSON.parse(await sent[sent.length - 1].text());
	return payload.events;
}

test("records navigations, clicks, requests (4xx included), console and custom steps, oldest first", async () => {
	window.history.pushState(null, "", "/cart?coupon=SECRET");
	window.history.replaceState(null, "", "/cart"); // same path: one navigation
	listeners.get("click")({ type: "click", target: new Element("checkout") });

	fetchStatus = 404;
	await window.fetch("/api/cart?token=abc123", { method: "post" });
	fetchStatus = 200;
	await window.fetch("https://collector.example.test/v1/browser"); // telemetry: never a breadcrumb

	const xhr = new XMLHttpRequest();
	xhr.open("PUT", "/api/order/42?session=1");
	xhr.send();
	xhr.status = 201;
	xhr.emit("loadend");

	console.warn("Low stock for", "jane@example.com", { sku: 7 });
	console.error(new TypeError("boom"));
	addBreadcrumb({
		message: "Applied coupon token=abc123",
		data: { coupon: "SAVE10", password: "hunter2", items: 3, ok: true, nested: { a: 1 }, nan: Number.NaN },
	});

	captureException(new Error("checkout failed"));
	const [event] = await lastEvents();
	const crumbs = event.breadcrumbs;
	assert.deepEqual(
		crumbs.map((c) => [c.type, c.level, c.message]),
		[
			["navigation", "info", "/cart"],
			["click", "info", "click:checkout"],
			["request", "warning", "POST /api/cart 404"],
			["request", "info", "PUT /api/order/42 201"],
			["console", "warning", 'Low stock for [redacted] {"sku":7}'],
			["console", "error", "TypeError: boom"],
			["custom", undefined, "Applied coupon token=[redacted]"],
		],
	);
	assert.deepEqual(crumbs[0].data, { from: "/", to: "/cart" });
	assert.equal(crumbs[2].data.method, "POST");
	assert.equal(crumbs[2].data.path, "/api/cart");
	assert.equal(crumbs[2].data.status, 404);
	assert.equal(typeof crumbs[2].data.durationMs, "number");
	assert.deepEqual(crumbs[6].data, { coupon: "SAVE10", password: "[redacted]", items: 3, ok: true });
	for (const crumb of crumbs) assert.ok(!Number.isNaN(Date.parse(crumb.at)), crumb.at);
	assert.ok(!JSON.stringify(crumbs).includes("abc123"));
	assert.ok(!JSON.stringify(crumbs).includes("SECRET"));
	assert.ok(!JSON.stringify(crumbs).includes("session=1"));
	// The 1.4 trail is still sent for older platforms.
	assert.equal(event.context["autter.trail"], "nav:/ > nav:/cart > click:checkout");
	// The originals still ran, with the original arguments.
	assert.deepEqual(consoleCalls.map((call) => call[0]), ["warn", "error"]);
	assert.equal(consoleCalls[0][2], "jane@example.com");
});

test("request failures carry breadcrumbs ending with the failing request; usage events carry none", async () => {
	fetchStatus = 503;
	await window.fetch("/api/pay");
	fetchStatus = 200;
	trackEvent("opened_cart");
	const events = await lastEvents();
	const failure = events.find((e) => e.type === "request_failure");
	assert.equal(failure.breadcrumbs.at(-1).message, "GET /api/pay 503");
	assert.equal(failure.breadcrumbs.at(-1).level, "error");
	assert.equal(events.find((e) => e.type === "track_event").breadcrumbs, undefined);

	const offline = new XMLHttpRequest();
	offline.open("GET", "/api/offline");
	offline.send();
	offline.emit("error");
	offline.emit("loadend");
	const [networkFailure] = await lastEvents();
	assert.equal(networkFailure.breadcrumbs.at(-1).message, "GET /api/offline failed");
});

test("keeps only the last 30", async () => {
	clearBreadcrumbs();
	for (let i = 0; i < 45; i++) addBreadcrumb({ message: `step ${i}`, level: "debug" });
	captureMessage("after many steps", "error");
	const [event] = await lastEvents();
	assert.equal(MAX_BREADCRUMBS, 30);
	assert.equal(event.breadcrumbs.length, 30);
	assert.equal(event.breadcrumbs[0].message, "step 15");
	assert.equal(event.breadcrumbs[29].message, "step 44");
});

test("bounds message, data and bytes so a batch stays under the beacon limit", async () => {
	clearBreadcrumbs();
	const data = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, "v".repeat(400)]));
	for (let i = 0; i < 30; i++) addBreadcrumb({ type: "bogus", message: `${i} ${"x".repeat(900)}`, level: "loud", data });
	captureException(new Error("big"));
	const [first] = await lastEvents();
	const crumb = first.breadcrumbs.at(-1);
	assert.equal(crumb.type, "custom");
	assert.equal(crumb.level, undefined);
	assert.equal(crumb.message.length, 500);
	assert.equal(Object.keys(crumb.data).length, 10);
	assert.equal(crumb.data.k0.length, 200);
	assert.ok(JSON.stringify(first.breadcrumbs).length <= 8 * 1024, "per-event budget");
	assert.ok(first.breadcrumbs.length < 30, "the newest that fit");
	assert.ok(first.breadcrumbs.at(-1).message.startsWith("29 "));

	// Errors storming within 5 s share a 24 KB budget: later ones go without.
	for (let i = 0; i < 4; i++) captureException(new Error(`storm ${i}`));
	const storm = await lastEvents();
	assert.equal(storm.length, 4);
	assert.ok(storm[0].breadcrumbs.length > 0);
	assert.equal(storm[3].breadcrumbs, undefined);
	assert.ok(JSON.stringify(storm).length < 60 * 1024);
});

test("a console call made while recording is not recorded again (no recursion)", async () => {
	clearBreadcrumbs();
	consoleCalls.length = 0;
	addBreadcrumb({ message: "with a noisy getter", data: { get noisy() { console.warn("from a getter"); return 1; } } });
	assert.deepEqual(consoleCalls, [["warn", "from a getter"]]);
	captureMessage("check", "error");
	const [event] = await lastEvents();
	assert.deepEqual(event.breadcrumbs.map((c) => c.message), ["with a noisy getter"]);
	// Bad input never throws.
	assert.doesNotThrow(() => addBreadcrumb(null));
	assert.doesNotThrow(() => addBreadcrumb({ message: { toString() { throw new Error("nope"); } } }));
});
