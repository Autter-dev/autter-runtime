import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, flush, initAutterBrowser } from "../dist/index.js";
import { enableTracing, LINK_WINDOW_MS } from "../dist/tracing.js";

// W3C trace context (EI-11, `@autter/runtime-browser/tracing`): which
// requests get a traceparent, and which events carry the trace id.

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-00$/;
const OWN = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const OWN_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const calls = [];
const statuses = new Map();
const sent = [];
let beacon = true;

class FakeXHR {
	status = 0;
	readyState = 0;
	headers = [];
	listeners = [];
	open(_method, url) {
		this.url = url;
		this.readyState = 1;
	}
	send() {}
	setRequestHeader(name, value) {
		this.headers.push([name, value]);
	}
	getResponseHeader() {
		return null;
	}
	addEventListener(name, callback) {
		this.listeners.push([name, callback]);
	}
	removeEventListener(name, callback) {
		this.listeners = this.listeners.filter(([n, c]) => n !== name || c !== callback);
	}
	emit(name) {
		for (const [n, callback] of [...this.listeners]) if (n === name) callback();
	}
	/** The browser's order at the end of a request. */
	finish(status, between) {
		this.status = status;
		this.readyState = 4;
		this.emit("readystatechange");
		between?.();
		this.emit("load");
		this.emit("loadend");
	}
	traceparent() {
		const found = this.headers.filter(([name]) => name.toLowerCase() === "traceparent");
		return found.length ? found.map(([, value]) => value).join(", ") : null;
	}
}

globalThis.window = {
	origin: "https://app.example.test",
	addEventListener() {},
	async fetch(input, init) {
		const url = input instanceof Request ? input.url : String(input);
		calls.push({ url, input, init });
		const status = statuses.get(new URL(url, "https://app.example.test/").pathname) ?? 200;
		if (status === 0) throw new TypeError("Failed to fetch");
		return new Response(null, { status });
	},
};
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = { href: "https://app.example.test/checkout", pathname: "/checkout", origin: "https://app.example.test" };
globalThis.XMLHttpRequest = FakeXHR;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	sendBeacon(_url, body) {
		if (!beacon) return false;
		sent.push(body);
		return true;
	},
} });
initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false });
enableTracing({ tracePropagationTargets: ["https://api.example.test/", /^https:\/\/[a-z]+\.internal\.example\.test\//] });

/** The traceparent the last fetch was sent with (null when none). */
function lastTraceparent() {
	const { input, init } = calls[calls.length - 1];
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	return headers.get("traceparent");
}

async function drain() {
	flush();
	const batch = sent.splice(0, sent.length);
	const events = [];
	for (const body of batch) events.push(...JSON.parse(await body.text()).events);
	return events;
}

function xhr(url, beforeSend) {
	const request = new XMLHttpRequest();
	request.open("GET", url);
	beforeSend?.(request);
	request.send();
	return request;
}

test("same-origin fetches get a valid unsampled traceparent", async () => {
	await window.fetch("/api/orders?page=2");
	const relative = lastTraceparent();
	assert.match(relative, TRACEPARENT);
	await window.fetch("https://app.example.test/api/orders", { method: "POST", headers: { "content-type": "application/json" } });
	assert.match(lastTraceparent(), TRACEPARENT);
	assert.notEqual(lastTraceparent(), relative, "every request gets its own trace");
	// The app's own headers are kept.
	assert.equal(new Headers(calls[calls.length - 1].init.headers).get("content-type"), "application/json");
	const [, traceId, spanId] = TRACEPARENT.exec(lastTraceparent());
	assert.notEqual(traceId, "0".repeat(32));
	assert.notEqual(spanId, "0".repeat(16));
});

test("cross-origin fetches get none unless a target allows them", async () => {
	await window.fetch("https://cdn.thirdparty.test/lib.json");
	assert.equal(lastTraceparent(), null);
	assert.equal(calls[calls.length - 1].init, undefined, "the init is passed through untouched");
	// Look-alike hosts are not the same origin.
	await window.fetch("https://app.example.test.evil.test/api");
	assert.equal(lastTraceparent(), null);
	// String targets match as URL prefixes, not substrings.
	await window.fetch("https://cdn.thirdparty.test/?next=https://api.example.test/");
	assert.equal(lastTraceparent(), null);
	await window.fetch("https://api.example.test/v1/orders");
	assert.match(lastTraceparent(), TRACEPARENT);
	await window.fetch("https://billing.internal.example.test/charge");
	assert.match(lastTraceparent(), TRACEPARENT);
});

test("an existing traceparent is never overwritten, and its trace id is used", async () => {
	statuses.set("/api/own", 503);
	await window.fetch("/api/own", { headers: { TraceParent: OWN } });
	assert.equal(lastTraceparent(), OWN);
	await window.fetch(new Request("https://app.example.test/api/own", { headers: { traceparent: OWN, "x-app": "1" } }));
	assert.equal(lastTraceparent(), OWN);
	const events = await drain();
	assert.deepEqual(events.map((e) => e.traceId), [OWN_TRACE, OWN_TRACE]);
});

test("a Request input keeps its headers when a traceparent is added", async () => {
	await window.fetch(new Request("https://app.example.test/api/items", { headers: { "x-app": "1" } }));
	const { init } = calls[calls.length - 1];
	const headers = new Headers(init.headers);
	assert.equal(headers.get("x-app"), "1");
	assert.match(headers.get("traceparent"), TRACEPARENT);
});

test("request_failure events carry the trace id their fetch was sent with", async () => {
	statuses.set("/api/fail", 502);
	statuses.set("/api/offline", 0);
	await window.fetch("/api/fail");
	const failedTrace = TRACEPARENT.exec(lastTraceparent())[1];
	await window.fetch("/api/offline").catch(() => {});
	const offlineTrace = TRACEPARENT.exec(lastTraceparent())[1];
	statuses.set("/boom", 500);
	await window.fetch("https://cdn.thirdparty.test/boom");
	const events = await drain();
	assert.deepEqual(
		events.map((e) => [e.type, e.name, e.traceId]),
		[
			["request_failure", "/api/fail", failedTrace],
			["request_failure", "/api/offline", offlineTrace],
			// Untraced cross-origin request: no trace id.
			["request_failure", "/boom", undefined],
		],
	);
});

test("XHR: same-origin and target requests get a traceparent; an app's own is kept", async () => {
	const same = xhr("/api/legacy");
	assert.match(same.traceparent(), TRACEPARENT);
	const target = xhr("https://api.example.test/v1/x");
	assert.match(target.traceparent(), TRACEPARENT);
	const third = xhr("https://cdn.thirdparty.test/x");
	assert.equal(third.traceparent(), null);
	const relay = xhr("/api/autter-runtime");
	assert.equal(relay.traceparent(), null, "the telemetry endpoint never gets one");
	// Set by the app before send: sent once, never combined with ours.
	const own = xhr("/api/legacy", (request) => request.setRequestHeader("traceparent", OWN));
	assert.equal(own.traceparent(), OWN);
	own.finish(500);
	same.finish(503);
	third.finish(502);
	const events = await drain();
	assert.deepEqual(events.map((e) => [e.name, e.traceId]), [
		["/api/legacy", OWN_TRACE],
		["/api/legacy", TRACEPARENT.exec(same.traceparent())[1]],
		["/x", undefined],
	]);
});

test("an exception thrown from an XHR load handler (axios) links to that request", async () => {
	const request = xhr("/api/cart");
	const trace = TRACEPARENT.exec(request.traceparent())[1];
	// readystatechange(4) runs before load/loadend handlers.
	request.finish(500, () => captureException(new Error("cart failed")));
	const events = await drain();
	const exception = events.find((e) => e.type === "exception");
	assert.equal(exception.traceId, trace);
});

test("an exception takes the trace of the request that settled in the previous 5 s", async (t) => {
	statuses.set("/api/checkout", 500);
	await window.fetch("/api/checkout");
	const trace = TRACEPARENT.exec(lastTraceparent())[1];
	captureException(new TypeError("Cannot read properties of undefined"));
	// A successful fetch links too: its server request may explain the bad data.
	await window.fetch("/api/cart");
	const okTrace = TRACEPARENT.exec(lastTraceparent())[1];
	captureException(new Error("cart total missing"));
	let events = await drain();
	assert.deepEqual(events.filter((e) => e.type === "exception").map((e) => e.traceId), [trace, okTrace]);

	// Older than the window: no link.
	await window.fetch("/api/cart");
	const realNow = Date.now;
	t.after(() => { Date.now = realNow; });
	const later = realNow() + LINK_WINDOW_MS + 1;
	Date.now = () => later;
	captureException(new Error("much later"));
	Date.now = realNow;
	// The last request to settle was untraced (cross-origin): no link to an older one.
	await window.fetch("/api/cart");
	await window.fetch("https://cdn.thirdparty.test/lib.json");
	captureException(new Error("after third-party"));
	events = await drain();
	assert.deepEqual(events.map((e) => [e.message, e.traceId]), [
		["much later", undefined],
		["after third-party", undefined],
	]);
});

test("the telemetry endpoint (same-origin relay) never gets a traceparent", async () => {
	// In a browser the SDK's own fallback fetch is the wrapped window.fetch.
	globalThis.fetch = (input, init) => window.fetch(input, init);
	beacon = false;
	captureException(new Error("deliver me"));
	flush();
	beacon = true;
	const relay = calls.filter((call) => call.url === "/api/autter-runtime");
	assert.equal(relay.length, 1);
	assert.equal(new Headers(relay[0].init.headers).get("traceparent"), null);
});
