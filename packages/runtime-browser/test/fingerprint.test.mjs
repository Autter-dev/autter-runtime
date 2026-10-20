import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, captureMessage, flush, initAutterBrowser } from "../dist/index.js";

const sent = [];
globalThis.window = { fetch: async () => new Response("{}"), addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = { href: "https://app.example.test/", pathname: "/checkout" };
Object.defineProperty(globalThis, "navigator", {
	configurable: true,
	value: { sendBeacon(_url, body) { sent.push(body); return true; } },
});
initAutterBrowser({
	endpoint: "/api/autter-runtime",
	service: "web",
	sessionTracking: false,
	captureActions: false,
	captureTimings: false,
	captureNetworkFailures: false,
	beforeSend(event) {
		if (event.message === "chunk failed") event.fingerprint = "chunk-load";
		return event;
	},
});

async function drain() {
	flush();
	const events = [];
	for (const body of sent.splice(0, sent.length)) events.push(...JSON.parse(await body.text()).events);
	return events;
}

test("captureException sends `fingerprint` as its own field, not as context", async () => {
	captureException(new Error("card timeout 1"), { fingerprint: ["checkout", "card-timeout"], step: "pay" });
	captureException(new Error("plain"), { fingerprint: "one-value" });
	captureException(new Error("no override"), { step: "pay" });
	captureException(new Error("no context"));
	const [listed, single, none, bare] = await drain();
	assert.deepEqual(listed.fingerprint, ["checkout", "card-timeout"]);
	assert.equal(listed.context.step, "pay");
	assert.equal("fingerprint" in listed.context, false);
	assert.equal(single.fingerprint, "one-value");
	assert.equal(none.fingerprint, undefined);
	assert.equal(none.context.step, "pay");
	assert.equal(bare.fingerprint, undefined);
});

test("beforeSend may set event.fingerprint on any event", async () => {
	captureMessage("chunk failed", "error");
	captureException(new Error("chunk failed"));
	const events = await drain();
	assert.deepEqual(events.map((event) => event.fingerprint), ["chunk-load", "chunk-load"]);
});
