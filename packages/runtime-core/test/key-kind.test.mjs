// Key-kind classification and wrong-key copy, against test-vectors/key-kinds.json
// (the ingester's own copy runs the same vectors).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyKey, keyProblemMessage, maskKey, wrongKeyMessage } from "../dist/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../../test-vectors/key-kinds.json", import.meta.url), "utf8"));

for (const c of vectors.classify) {
	test(`classifyKey: ${c.name}`, () => {
		const got = classifyKey(c.raw);
		assert.equal(got.kind, c.kind);
		assert.equal(got.key, c.key);
		assert.equal(got.problem, c.problem);
	});
}

test("wrongKeyMessage matches the vectors", () => {
	for (const v of vectors.wrongKeyMessage) assert.equal(wrongKeyMessage(v.expected, v.got), v.message, `${v.expected}/${v.got}`);
});

test("keyProblemMessage matches the vectors", () => {
	for (const [problem, message] of Object.entries(vectors.problemMessage)) assert.equal(keyProblemMessage(problem), message);
});

test("maskKey shows a prefix and four characters at most", () => {
	for (const v of vectors.mask) assert.equal(maskKey(v.key), v.masked);
});

test("autter_rtc_ is not mistaken for autter_rt_", () => {
	assert.equal(classifyKey("autter_rtc_x").kind, "client");
	assert.equal(classifyKey("autter_rt_x").kind, "server");
});
