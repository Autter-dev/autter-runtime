import { test } from "node:test";
import assert from "node:assert/strict";
import { autterErrorFromResponse, captureException, flush, initAutterBrowser } from "../dist/index.js";

class FakeXHR {
	status = 0;
	headers = {};
	listeners = new Map();
	open(_method, _url) {}
	send() {}
	getResponseHeader(name) {
		return this.headers[name] ?? null;
	}
	addEventListener(name, callback) {
		this.listeners.set(name, callback);
	}
	removeEventListener(name, callback) {
		if (this.listeners.get(name) === callback) this.listeners.delete(name);
	}
	emit(name) {
		this.listeners.get(name)?.();
	}
}

const sent = [];
let nextResponse;
globalThis.window = { fetch: async () => nextResponse, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = { href: "https://app.example.test/", pathname: "/checkout" };
globalThis.XMLHttpRequest = FakeXHR;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	sendBeacon(_url, body) { sent.push(body); return true; },
} });
initAutterBrowser({ endpoint: "https://collector.example.test/v1/browser", service: "web", sessionTracking: false, captureTimings: false });

async function drain() {
	flush();
	const batch = sent.splice(0, sent.length);
	const events = [];
	for (const body of batch) events.push(...JSON.parse(await body.text()).events);
	return events;
}

test("captureException duck-types declared fields from any error", async () => {
	const coded = Object.assign(new Error("Payment declined"), {
		code: "billing.declined",
		why: "The issuer rejected the charge",
		fix: "Ask for another card",
		link: "https://docs.example.com/payments#declined",
		expected: true,
		requestId: "req_abcdefgh12",
	});
	captureException(coded, { step: "pay" });
	// Node-style codes and unsafe links are not declared codes.
	captureException(Object.assign(new Error("socket"), { code: "ECONNRESET", link: "javascript:alert(1)", expected: "yes" }));
	captureException({ code: "plain.object_error" });
	const [first, second, third] = await drain();
	assert.equal(first.context["autter.error.code"], "billing.declined");
	assert.equal(first.context["autter.error.why"], "The issuer rejected the charge");
	assert.equal(first.context["autter.error.fix"], "Ask for another card");
	assert.equal(first.context["autter.error.link"], "https://docs.example.com/payments#declined");
	assert.equal(first.context["autter.error.expected"], true);
	assert.equal(first.context["autter.request.id"], "req_abcdefgh12");
	assert.equal(first.context.step, "pay");
	for (const key of ["autter.error.code", "autter.error.link", "autter.error.expected"]) {
		assert.equal(second.context?.[key], undefined, key);
	}
	assert.equal(third.context["autter.error.code"], "plain.object_error");
});

test("autterErrorFromResponse reads the JSON error body and falls back to status text", async () => {
	const body = { error: { message: "Plan free limit reached", code: "billing.limit", why: "Quota used", fix: "Upgrade", link: "https://docs.example.com/limits", requestId: "req_0000000001" } };
	const response = new Response(JSON.stringify(body), { status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json" } });
	const error = await autterErrorFromResponse(response);
	assert.ok(error instanceof Error);
	assert.equal(error.message, "Plan free limit reached");
	assert.equal(error.code, "billing.limit");
	assert.equal(error.why, "Quota used");
	assert.equal(error.fix, "Upgrade");
	assert.equal(error.link, "https://docs.example.com/limits");
	assert.equal(error.requestId, "req_0000000001");
	assert.equal(error.status, 429);
	// The caller can still read the original body.
	assert.deepEqual(await response.json(), body);

	const html = await autterErrorFromResponse(new Response("<html>oops</html>", { status: 502, statusText: "Bad Gateway", headers: { "x-request-id": "req_fromheader1" } }));
	assert.equal(html.message, "Bad Gateway");
	assert.equal(html.code, undefined);
	assert.equal(html.requestId, "req_fromheader1");

	const bare = await autterErrorFromResponse(new Response(null, { status: 500 }));
	assert.equal(bare.message, "Request failed with status 500");

	captureException(error);
	const [event] = await drain();
	assert.equal(event.errorType, "HttpResponseError");
	assert.equal(event.context["autter.error.code"], "billing.limit");
	assert.equal(event.context["autter.request.id"], "req_0000000001");
});

test("failed fetch and XHR responses carry x-request-id as autter.request.id", async () => {
	nextResponse = new Response("down", { status: 503, headers: { "x-request-id": "0f6c1d2e-aaaa-bbbb-cccc-000000000001" } });
	await window.fetch("/api/orders?id=1");
	nextResponse = new Response("down", { status: 500, headers: { "x-request-id": "bad id with spaces" } });
	await window.fetch("/api/other");

	const xhr = new XMLHttpRequest();
	xhr.open("POST", "/api/pay");
	xhr.send();
	xhr.status = 502;
	xhr.headers["x-request-id"] = "req_xhr0000001";
	xhr.emit("loadend");

	const events = await drain();
	assert.deepEqual(events.map((event) => [event.type, event.name, event.context?.["autter.request.id"]]), [
		["request_failure", "/api/orders", "0f6c1d2e-aaaa-bbbb-cccc-000000000001"],
		["request_failure", "/api/other", undefined],
		["request_failure", "/api/pay", "req_xhr0000001"],
	]);
});

test("throwing metadata getters never stop the original error being reported", async () => {
	const hostile = new Error("boom");
	Object.defineProperty(hostile, "code", { get() { throw new Error("getter exploded"); } });
	const proxied = new Proxy(new Error("proxied"), {
		get(target, key) {
			if (key === "why") throw new Error("trap");
			return Reflect.get(target, key);
		},
	});
	captureException(hostile);
	captureException(proxied);
	const events = await drain();
	assert.deepEqual(events.map((e) => e.message), ["boom", "proxied"]);
});

test("email scrubbing stays fast on long adversarial context values", async () => {
	const started = performance.now();
	captureException(new Error("long"), { note: "a".repeat(1_000_000), dots: "a.".repeat(500_000) });
	assert.ok(performance.now() - started < 1000, "scrub must be bounded");
	await drain();
});
