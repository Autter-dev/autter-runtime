import assert from "node:assert/strict";
import { test } from "node:test";
import { createErrorFilter, effectiveSampleRate, isIgnoredError } from "../dist/index.js";

test("ignoreErrors: strings match type or message, RegExps also `type: message`", () => {
	const patterns = ["ResizeObserver loop", /^AbortError$/, /ECONNRESET/g, /^TimeoutError: upstream/];
	assert.equal(isIgnoredError(patterns, "Error", "ResizeObserver loop limit exceeded"), true);
	assert.equal(isIgnoredError(patterns, "AbortError", "The user aborted a request."), true);
	assert.equal(isIgnoredError(patterns, "Error", "read ECONNRESET"), true);
	// A global RegExp is tested on a copy, so lastIndex never skips a match.
	assert.equal(isIgnoredError(patterns, "Error", "read ECONNRESET"), true);
	assert.equal(isIgnoredError(patterns, "TimeoutError", "upstream took 30s"), true);
	assert.equal(isIgnoredError(patterns, "TypeError", "x is not a function"), false);
	assert.equal(isIgnoredError(["resizeobserver"], "Error", "ResizeObserver loop"), false, "strings are case-sensitive");
	assert.equal(isIgnoredError([""], "Error", "anything"), false, "an empty string matches nothing");
	assert.equal(isIgnoredError(undefined, "Error", "x"), false);
	assert.equal(isIgnoredError([42, null], "Error", "x"), false, "non-patterns are skipped");
});

test("sampleRate samples errors only; fatal, crashes, warnings and info always pass", () => {
	let next = 0.9;
	const filter = createErrorFilter({ sampleRate: 0.25 }, () => next);
	assert.equal(filter({ type: "Error", message: "x" }), false, "0.9 >= 0.25: sampled out");
	next = 0.1;
	assert.equal(filter({ type: "Error", message: "x" }), true);
	next = 0.9;
	assert.equal(filter({ type: "Error", message: "x", severity: "fatal" }), true);
	assert.equal(filter({ type: "Error", message: "x", crash: true }), true);
	assert.equal(filter({ type: "Message", message: "x", severity: "warning" }), true);
	assert.equal(filter({ type: "Message", message: "x", severity: "info" }), true);
	// sampleRate 0 drops every sampleable error, never a crash.
	const none = createErrorFilter({ sampleRate: 0 });
	assert.equal(none({ type: "Error", message: "x" }), false);
	assert.equal(none({ type: "Error", message: "x", crash: true }), true);
});

test("ignoreErrors applies to crashes too; bad rates report everything", () => {
	const filter = createErrorFilter({ ignoreErrors: ["Known shutdown race"], sampleRate: 1 });
	assert.equal(filter({ type: "Error", message: "Known shutdown race in pool", crash: true }), false);
	assert.equal(filter({ type: "Error", message: "other" }), true);
	for (const rate of [1, 1.5, -0.1, Number.NaN, "0.5", undefined]) {
		assert.equal(effectiveSampleRate(rate), null, String(rate));
		assert.equal(createErrorFilter({ sampleRate: rate })({ type: "Error", message: "x" }), true, String(rate));
	}
});
