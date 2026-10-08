import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redactContext, scrubText } from "../dist/index.js";

// Shared parity vectors — same file the Node SDK, ingester and Python
// adapter test against. `skip: ["browser"]` marks server-only shapes the
// size-capped browser bundle deliberately leaves to the relay/ingester.
const vectors = JSON.parse(
	readFileSync(new URL("../../../test-vectors/redaction.json", import.meta.url), "utf8"),
);
const join = (value) => (Array.isArray(value) ? value.join("") : value);
const MASK = "[redacted]";

for (const vector of vectors.text) {
	if (vector.skip?.includes("browser")) continue;
	test(`scrubText vector: ${vector.name}`, () => {
		assert.equal(scrubText(join(vector.input)), join(vector.expect));
	});
}

test("sensitive context keys are masked at any depth; safe keys survive", () => {
	for (const key of vectors.keys.sensitive) {
		const out = redactContext({ outer: { list: [{ [key]: "raw" }] } });
		assert.equal(out.outer.list[0][key], MASK, key);
	}
	for (const key of vectors.keys.safe) {
		assert.equal(redactContext({ outer: { [key]: "kept" } }).outer[key], "kept", key);
	}
});

test("nested string values are scrubbed for secrets, not only emails", () => {
	const out = redactContext({
		request: { url: "/api?token=abc123xyz&page=1", meta: ["Bearer abcdefghijklmnop12"] },
	});
	assert.equal(out.request.url, `/api?token=${MASK}&page=1`);
	assert.deepEqual(out.request.meta, [MASK]);
});
