import { test } from "node:test";
import assert from "node:assert/strict";
import { redactAttributes } from "../dist/index.js";

const MASK = "[redacted]";

test("masks email-looking substrings inside any string value", () => {
	const out = redactAttributes({
		note: "ping jane.doe+ops@example.co.uk today",
	});
	assert.equal(out.note, `ping ${MASK} today`);
});

test("can disable value-level email scrubbing", () => {
	const out = redactAttributes(
		{ note: "mail me at a@b.io" },
		{ scrubEmailValues: false },
	);
	assert.equal(out.note, "mail me at a@b.io");
});

test("masks whole value when the attribute KEY looks sensitive", () => {
	const out = redactAttributes({
		"user.password": "hunter2",
		authToken: "raw-token-value",
		"x-api-key": "sk-abc",
		cookieHeader: "session=xyz",
		credit_card_number: "4111111111111111",
	});
	for (const value of Object.values(out)) assert.equal(value, MASK);
});

test("does not over-match innocent keys (discard, author_id, card_brand)", () => {
	const out = redactAttributes({
		discard_count: 3,
		author_id: "u_8f2k1",
		card_brand: "visa",
		passwordResetAt: "2026-01-01",
	});
	assert.deepEqual(out, {
		discard_count: 3,
		author_id: "u_8f2k1",
		card_brand: "visa",
		// passwordResetAt still matches /pass(word)/ — conservative by design.
		passwordResetAt: MASK,
	});
});

// Fake tokens for regex testing, assembled from fragments so secret
// scanners (GitHub push protection) don't mistake them for real credentials.
const FAKE_SLACK = ["xox", "b-123456789012-abcdefghijklmnopqrstuv"].join("");
const FAKE_GITHUB = ["ghp_", "abcdefghijklmnopqrstuvwxyz1234567890"].join("");

test("scrubs token shapes: JWT, OpenAI, GitHub, AWS, Slack, bearer", () => {
	const out = redactAttributes({
		jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c tail",
		openai: "key sk-abcdefghijklmnopqrstuvwxyz123456 end",
		github: `${FAKE_GITHUB} end`,
		aws: "AKIAIOSFODNN7EXAMPLE end",
		slack: `${FAKE_SLACK} end`,
		authz: "Bearer abcdefghijklmnopqrstuvwxyz1234567890",
	});
	assert.equal(out.jwt, `${MASK} tail`);
	assert.equal(out.openai, `key ${MASK} end`);
	assert.equal(out.github, `${MASK} end`);
	assert.equal(out.aws, `${MASK} end`);
	assert.equal(out.slack, `${MASK} end`);
	assert.equal(out.authz, MASK);
});

test("strips basic-auth credentials from URLs but keeps host", () => {
	const out = redactAttributes({
		db: "postgres://admin:s3cret@db.internal:5432/app",
	});
	assert.equal(out.db, `postgres://${MASK}@db.internal:5432/app`);
});

test("handles attribute arrays element-wise", () => {
	const out = redactAttributes({
		recipients: ["alice@example.com", "ok"],
		attempts: [1, 2],
	});
	assert.deepEqual(out.recipients, [MASK, "ok"]);
	assert.deepEqual(out.attempts, [1, 2]);
});

test("drops undefined values, keeps numbers and booleans", () => {
	const out = redactAttributes({ retries: 3, healthy: true, gone: undefined });
	assert.deepEqual(out, { retries: 3, healthy: true });
});

test("walks nested objects defensively", () => {
	const out = redactAttributes({
		context: { inner: { password: "x", safe: "y@z.com" } },
	});
	assert.equal(out.context.inner.password, MASK);
	assert.equal(out.context.inner.safe, MASK);
});

test("supports extra key/value patterns and a custom mask", () => {
	const out = redactAttributes(
		{
			employee_id: "E-123",
			account_ref: "ACC-99",
		},
		{
			additionalKeyPatterns: ["employee_id"],
			additionalValuePatterns: [/^ACC-\d+$/],
			mask: "***",
		},
	);
	assert.equal(out.employee_id, "***");
	assert.equal(out.account_ref, "***");
});

test("never mutates the caller's attributes object", () => {
	const original = { email: "a@b.com", n: 1 };
	const snapshot = structuredClone(original);
	redactAttributes(original);
	assert.deepEqual(original, snapshot);
});

test("empty/nullish input yields an empty object", () => {
	assert.deepEqual(redactAttributes(), {});
	assert.deepEqual(redactAttributes(null), {});
});

test("keeps only supported GenAI/usage token-count attributes", () => {
const out = redactAttributes({
"gen_ai.usage.input_tokens": 512,
"gen_ai.usage.output_tokens": 128,
prompt_tokens: 512,
completion_tokens: 128,
total_tokens: 640,
token_count: 42,
max_tokens: 1000,
"secret.input_tokens": 999,
});

assert.deepEqual(out, {
"gen_ai.usage.input_tokens": 512,
"gen_ai.usage.output_tokens": 128,
prompt_tokens: 512,
completion_tokens: 128,
total_tokens: 640,
token_count: 42,
max_tokens: MASK,
"secret.input_tokens": MASK,
});
});


test("still masks secret token keys ending in 'token'", () => {
const out = redactAttributes({
token: "raw",
access_token: "raw",
refresh_token: "raw",
authToken: "raw",
token_value: "raw",
tokenString: "raw",
token_id: "raw",
id_token_hint: "raw",
});
for (const value of Object.values(out)) assert.equal(value, MASK);
});
