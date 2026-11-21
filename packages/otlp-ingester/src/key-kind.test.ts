// The ingester's copy of runtime-core's key-kind.ts, against the shared vectors.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyKey, keyProblemMessage, maskKey, wrongKeyMessage } from "./key-kind.js";

const vectors = JSON.parse(readFileSync(new URL("../../../test-vectors/key-kinds.json", import.meta.url), "utf8"));

test("classifyKey matches the vectors", () => {
	for (const c of vectors.classify) {
		const got = classifyKey(c.raw);
		assert.equal(got.kind, c.kind, c.name);
		assert.equal(got.key, c.key, c.name);
		assert.equal(got.problem, c.problem, c.name);
	}
});

test("wrongKeyMessage, keyProblemMessage and maskKey match the vectors", () => {
	for (const v of vectors.wrongKeyMessage) assert.equal(wrongKeyMessage(v.expected, v.got), v.message, `${v.expected}/${v.got}`);
	for (const [problem, message] of Object.entries(vectors.problemMessage)) assert.equal(keyProblemMessage(problem as never), message);
	for (const v of vectors.mask) assert.equal(maskKey(v.key), v.masked);
});
