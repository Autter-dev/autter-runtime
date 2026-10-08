import { test } from "node:test";
import assert from "node:assert/strict";
import { captureMessage, flush, initAutterBrowser } from "../dist/index.js";

test("beforeSend failures preserve application requests and later delivery", async () => {
	const response = new Response("unavailable", { status: 503 });
	const networkError = new Error("original network failure");
	const hookError = new Error("beforeSend failure");
	const sent = [];
	let rejectRequest = false;
	let hookMode = "throw";
	globalThis.window = {
		fetch: async () => {
			if (rejectRequest) throw networkError;
			return response;
		},
		addEventListener() {},
	};
	globalThis.document = { addEventListener() {}, visibilityState: "visible" };
	globalThis.location = { href: "https://app.example.test/", pathname: "/" };
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			sendBeacon(_url, body) { sent.push(body); return true; },
		},
	});
	initAutterBrowser({
		endpoint: "/api/autter-runtime",
		service: "web",
		sessionTracking: false,
		captureActions: false,
		captureTimings: false,
		beforeSend(event) {
			if (hookMode === "throw") throw hookError;
			if (hookMode === "drop") return null;
			return { ...event, message: "mapped message" };
		},
	});

	assert.equal(await window.fetch("/checkout"), response);
	rejectRequest = true;
	await assert.rejects(window.fetch("/offline"), (error) => error === networkError);
	assert.doesNotThrow(() => captureMessage("failed hook"));
	flush();
	assert.equal(sent.length, 0);

	hookMode = "drop";
	captureMessage("dropped message");
	flush();
	assert.equal(sent.length, 0);

	hookMode = "map";
	captureMessage("healthy message");
	flush();
	assert.equal(sent.length, 1);
	const payload = JSON.parse(await sent[0].text());
	assert.equal(payload.events.length, 1);
	assert.equal(payload.events[0].message, "mapped message");
});
