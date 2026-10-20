import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, flush, initAutterBrowser } from "../dist/index.js";
import { disableTracePropagation, enableTracePropagation } from "../dist/tracing.js";

// Without `enableTracePropagation()` (or after `disableTracePropagation()`)
// the tracker adds no traceparent and events carry no trace id (EI-11).

const calls = [];
const sent = [];
globalThis.window = {
	origin: "https://app.example.test",
	addEventListener() {},
	async fetch(input, init) {
		calls.push({ input, init });
		return new Response(null, { status: 503 });
	},
};
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = { href: "https://app.example.test/", pathname: "/", origin: "https://app.example.test" };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	sendBeacon(_url, body) { sent.push(body); return true; },
} });
initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false });

async function drain() {
	flush();
	const events = [];
	for (const body of sent.splice(0, sent.length)) events.push(...JSON.parse(await body.text()).events);
	return events;
}

test("no traceparent and no trace ids unless tracing is enabled", async () => {
	await window.fetch("/api/orders");
	assert.equal(calls[0].init, undefined);
	captureException(new Error("after"));
	assert.deepEqual((await drain()).map((e) => [e.type, e.traceId]), [["request_failure", undefined], ["exception", undefined]]);

	enableTracePropagation();
	await window.fetch("/api/orders");
	assert.ok(new Headers(calls[1].init.headers).get("traceparent"));
	disableTracePropagation();
	await window.fetch("/api/orders");
	assert.equal(calls[2].init, undefined);
	captureException(new Error("after disable"));
	const events = await drain();
	assert.equal(events.filter((e) => e.traceId).length, 1, "only the request sent while tracing was on");
});
