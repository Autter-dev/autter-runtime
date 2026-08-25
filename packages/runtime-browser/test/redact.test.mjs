import { test } from "node:test";
import assert from "node:assert/strict";
import { redactContext } from "../dist/index.js";

const MASK = "[redacted]";

test("masks values under sensitive-looking keys", () => {
	const out = redactContext({
		"user.email": "jane@example.com",
		authToken: "raw-token",
		cookieConsent: "granted",
		card_number: "4111111111111111",
	});
	for (const value of Object.values(out)) assert.equal(value, MASK);
});

test("does not over-match innocent keys (discard_count, author_id)", () => {
	const out = redactContext({
		discard_count: 3,
		author_id: "u_8f2k1",
		card_brand: "visa",
	});
	assert.deepEqual(out, { discard_count: 3, author_id: "u_8f2k1", card_brand: "visa" });
});

test("scrubs email-shaped strings inside ordinary string values", () => {
	const out = redactContext({ note: "contact jane.doe@example.co.uk today" });
	assert.equal(out.note, `contact ${MASK} today`);
});

test("non-string primitives pass through untouched", () => {
	const out = redactContext({ retries: 3, healthy: true, ratio: 0.5 });
	assert.deepEqual(out, { retries: 3, healthy: true, ratio: 0.5 });
});

test("returns a new object — caller's context is never mutated", () => {
	const original = { email: "a@b.com", n: 1 };
	const snapshot = structuredClone(original);
	redactContext(original);
	assert.deepEqual(original, snapshot);
});
