import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, captureMessage, captureOutcome, flush, initAutterBrowser, trackEvent } from "../dist/index.js";
import { createFilter, errorScriptUrl, withFilters } from "../dist/filters.js";

/** `@autter/runtime-browser/filters` (EI-38): sampleRate, ignoreErrors, denyUrls. */

const exception = (message, extra = {}) => ({ type: "exception", timestamp: "2026-10-21T10:00:00.000Z", message, severity: "error", ...extra });

test("the script an error came from: its file, else the innermost frame with a URL", () => {
	assert.equal(errorScriptUrl({ filename: "https://cdn.test/app.js" }), "https://cdn.test/app.js");
	assert.equal(
		errorScriptUrl({ stack: "TypeError: see https://docs.test/x\n    at run (chrome-extension://abcdef/content.js:10:5)\n    at https://app.test/main.js:1:2" }),
		"chrome-extension://abcdef/content.js",
		"the message line is not a frame",
	);
	assert.equal(errorScriptUrl({ stack: "Error: x\n    at https://app.test/main.js:1:2" }), "https://app.test/main.js");
	assert.equal(errorScriptUrl({ stack: "handler@https://www.googletagmanager.com/gtm.js:3:9\n@https://app.test/main.js:1:1" }), "https://www.googletagmanager.com/gtm.js");
	assert.equal(errorScriptUrl({ stack: "Error: no frames" }), undefined);
	assert.equal(errorScriptUrl({}), undefined);
});

test("ignoreErrors matches type or message; denyUrls the error's script", () => {
	const filter = createFilter({
		ignoreErrors: ["ResizeObserver loop", /^AbortError$/, /^ChunkLoadError: Loading chunk \d+/g],
		denyUrls: [/^chrome-extension:/, "googletagmanager.com"],
	});
	assert.equal(filter(exception("ResizeObserver loop limit exceeded")), null);
	assert.equal(filter(exception("aborted", { errorType: "AbortError" })), null);
	assert.equal(filter(exception("Loading chunk 7 failed.", { errorType: "ChunkLoadError" })), null);
	assert.equal(filter(exception("Loading chunk 7 failed.", { errorType: "ChunkLoadError" })), null, "a /g pattern matches every time");
	assert.equal(filter(exception("x", { stack: "Error: x\n    at y (chrome-extension://abc/c.js:1:1)" })), null);
	assert.equal(filter(exception("x", { filename: "https://www.googletagmanager.com/gtm.js" })), null);
	assert.equal(filter({ type: "unhandled_rejection", timestamp: "t", message: "ResizeObserver loop", severity: "warning" }), null, "warnings too");
	const kept = exception("x is not a function", { errorType: "TypeError", stack: "TypeError: x\n    at app (https://app.test/main.js:1:1)" });
	assert.equal(filter(kept), kept);
	// Usage events are never filtered.
	const usage = { type: "track_event", timestamp: "t", message: "", name: "ResizeObserver loop" };
	assert.equal(filter(usage), usage);
});

test("sampleRate samples errors only, never fatal, usage or timings", () => {
	const filter = createFilter({ sampleRate: 0 });
	assert.equal(filter(exception("sampled out")), null);
	assert.equal(filter({ type: "request_failure", timestamp: "t", message: "Request returned 503" }), null);
	assert.equal(filter({ type: "outcome", timestamp: "t", message: "failed", severity: "error" }), null);
	for (const kept of [
		exception("fatal", { severity: "fatal" }),
		{ type: "message", timestamp: "t", message: "a warning", severity: "warning" },
		{ type: "unhandled_rejection", timestamp: "t", message: "plain value", severity: "warning" },
		{ type: "session_start", timestamp: "t", message: "" },
		{ type: "timing", timestamp: "t", message: "", name: "browser.longtask" },
	]) {
		assert.equal(filter(kept), kept, kept.type);
	}
	const half = createFilter({ sampleRate: 0.5 });
	let sent = 0;
	for (let i = 0; i < 2000; i++) if (half(exception(`e${i}`))) sent += 1;
	assert.ok(sent > 850 && sent < 1150, `sent ${sent} of 2000 at 0.5`);
	const all = createFilter({ sampleRate: 1 });
	for (let i = 0; i < 100; i++) assert.ok(all(exception("e")));
});

test("withFilters installs them as beforeSend, ahead of your own hook, end to end", async () => {
	const sent = [];
	globalThis.window = { fetch: async () => new Response("{}"), addEventListener() {} };
	globalThis.document = { addEventListener() {}, visibilityState: "visible" };
	globalThis.location = { href: "https://app.test/", pathname: "/" };
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { sendBeacon(_url, body) { sent.push(body); return true; } },
	});
	const seenByOwnHook = [];
	const options = withFilters({
		endpoint: "/api/autter-runtime",
		service: "web",
		sessionTracking: false,
		captureActions: false,
		captureTimings: false,
		captureNetworkFailures: false,
		sampleRate: 0,
		ignoreErrors: ["ResizeObserver"],
		beforeSend(event) {
			seenByOwnHook.push(event.message);
			return event;
		},
	});
	assert.equal("sampleRate" in options, false, "filter options are not passed to the tracker");
	initAutterBrowser(options);
	captureException(new Error("ResizeObserver loop"));
	captureException(new Error("sampled out"));
	captureOutcome("checkout.pay", "declined");
	captureMessage("still a warning", "warning");
	captureMessage("fatal is kept", "fatal");
	trackEvent("signup");
	flush();
	const events = (await Promise.all(sent.map((body) => body.text()))).flatMap((text) => JSON.parse(text).events);
	assert.deepEqual(events.map((e) => e.message || e.name), ["still a warning", "fatal is kept", "signup"]);
	assert.deepEqual(seenByOwnHook, ["still a warning", "fatal is kept", ""]);
});
