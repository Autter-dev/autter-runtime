// RF-04 (browser): console.error with a real Error becomes an exception event,
// marked as a caught error with the log line as context. On by default; plain
// console.error lines and non-Error arguments are untouched, and an Error
// already sent via captureException (an error boundary) is not sent twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, flush, initAutterBrowser } from "../dist/index.js";

const sent = [];
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible", scripts: [] };
globalThis.location = { href: "https://app.example.test/checkout", pathname: "/checkout", origin: "https://app.example.test" };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	sendBeacon(_url, body) { sent.push(body); return true; },
} });
// Quiet the real console.error the hook wraps (keeps test output clean).
console.error = () => {};
initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false, captureNetworkFailures: false });

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
async function drain() {
	flush();
	const batch = sent.splice(0, sent.length);
	const events = [];
	for (const body of batch) events.push(...JSON.parse(await body.text()).events);
	return events;
}

test("console.error(Error) is a caught exception carrying the log line; a plain line is untouched", async () => {
	console.error("plain diagnostic line, no error");
	console.error("lookup failed for", "u1", new Error("db down"));
	await macrotask();
	const events = await drain();
	const caught = events.find((e) => e.type === "exception" && e.message === "db down");
	assert.ok(caught, "the Error was captured");
	assert.equal(caught.severity, "error");
	assert.equal(caught.context["autter.log.message"], "lookup failed for u1 db down");
	assert.ok(!events.some((e) => /plain diagnostic/.test(e.message ?? "")), "a line with no Error is untouched");
});

test("an Error sent by captureException and then console.error is sent once", async () => {
	const err = new Error("boundary error");
	captureException(err); // e.g. an error boundary already reported it
	console.error(err); // React also logs it
	await macrotask();
	const events = await drain();
	assert.equal(events.filter((e) => e.message === "boundary error").length, 1, "reported once");
});
