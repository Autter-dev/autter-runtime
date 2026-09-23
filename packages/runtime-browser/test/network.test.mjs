import { test } from "node:test";
import assert from "node:assert/strict";
import { flush, initAutterBrowser } from "../dist/index.js";

class FakeXHR {
	status = 0;
	listeners = new Map();
	open(_method, _url) {}
	send() {}
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

test("XHR 5xx and network errors are captured; 4xx is ignored", async () => {
	const sent = [];
	globalThis.window = { fetch: async () => ({ status: 200 }), addEventListener() {} };
	globalThis.document = { addEventListener() {}, visibilityState: "visible" };
	globalThis.location = { href: "https://app.example.test/", pathname: "/" };
	globalThis.XMLHttpRequest = FakeXHR;
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
		sendBeacon(_url, body) { sent.push(body); return true; },
	} });
	initAutterBrowser({ endpoint: "https://collector.example.test/v1/browser", service: "web", sessionTracking: false, captureTimings: false });

	const serverError = new XMLHttpRequest();
	serverError.open("GET", "/checkout?token=secret");
	serverError.send();
	serverError.status = 503;
	serverError.emit("loadend");

	const notFound = new XMLHttpRequest();
	notFound.open("GET", "/missing");
	notFound.send();
	notFound.status = 404;
	notFound.emit("loadend");

	const networkError = new XMLHttpRequest();
	networkError.open("GET", "/offline");
	networkError.send();
	networkError.emit("error");

	flush();
	assert.equal(sent.length, 1);
	const payload = JSON.parse(await sent[0].text());
	assert.deepEqual(payload.events.map((event) => [event.type, event.name, event.errorType]), [
		["request_failure", "/checkout", "HttpRequestError"],
		["request_failure", "/offline", "NetworkError"],
	]);
});
