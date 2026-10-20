import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintEventAttributes, fingerprintValues, redactText, splitFingerprint } from "../dist/index.js";

test("fingerprint values: strings only, empty dropped, at most 10, each scrubbed then cut to 200", () => {
	assert.deepEqual(fingerprintValues("a"), ["a"]);
	assert.deepEqual(fingerprintValues(["a", "", 3, null, "b"]), ["a", "b"]);
	assert.equal(fingerprintValues(""), undefined);
	assert.equal(fingerprintValues([]), undefined);
	assert.equal(fingerprintValues(undefined), undefined);
	assert.equal(fingerprintValues(Array.from({ length: 15 }, (_, i) => `v${i}`)).length, 10);
	assert.equal(fingerprintValues("x".repeat(900))[0].length, 200);
	assert.deepEqual(fingerprintValues(["ada@example.com"], redactText), ["[redacted]"]);
});

test("the event attribute is always a JSON array, so a single value never reads as a list", () => {
	assert.deepEqual(fingerprintEventAttributes("chunk-load"), { "autter.fingerprint": '["chunk-load"]' });
	assert.deepEqual(fingerprintEventAttributes('["a","b"]'), { "autter.fingerprint": '["[\\"a\\",\\"b\\"]"]' });
	assert.deepEqual(fingerprintEventAttributes(["a", "b"]), { "autter.fingerprint": '["a","b"]' });
	assert.deepEqual(fingerprintEventAttributes(undefined), {});
});

test("splitFingerprint takes `fingerprint` out and leaves the rest untouched", () => {
	const input = { fingerprint: ["a"], step: "pay" };
	const split = splitFingerprint(input);
	assert.deepEqual(split, { attributes: { step: "pay" }, fingerprint: ["a"] });
	assert.deepEqual(input, { fingerprint: ["a"], step: "pay" }, "input is not mutated");
	const plain = { step: "pay" };
	assert.equal(splitFingerprint(plain).attributes, plain);
	assert.deepEqual(splitFingerprint(undefined), { attributes: undefined, fingerprint: undefined });
});
