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

test("redacts sensitive keys beyond the nested traversal depth", () => {
        const out = redactAttributes({
                context: {
                        level1: {
                                level2: {
                                        level3: {
                                                level4: {
                                                        password: "SECRET",
                                                },
                                        },
                                },
                        },
                },
        });

        assert.equal(
                out.context.level1.level2.level3.level4.password,
                MASK,
        );
});

test("bounds extremely deep object traversal safely", () => {
        let value = { password: "SECRET" };

        for (let i = 0; i < 200; i += 1) {
                value = { nested: value };
        }

        assert.doesNotThrow(() => redactAttributes({ context: value }));
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

test("masks invalid values for supported GenAI usage keys", () => {
        const out = redactAttributes({
                "gen_ai.usage.input_tokens": "512",
                "gen_ai.usage.output_tokens": -1,
                token_count: Number.NaN,
        });

        assert.equal(out["gen_ai.usage.input_tokens"], MASK);
        assert.equal(out["gen_ai.usage.output_tokens"], MASK);
        assert.equal(out.token_count, MASK);
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
test("does not throw when a revoked array proxy is encountered", () => {
        const target = [];
        const { proxy, revoke } = Proxy.revocable(target, {});
        revoke();

        assert.doesNotThrow(() => redactAttributes({ context: proxy }));
});

test("does not throw when a revoked root proxy is encountered", () => {
        const target = {};
        const { proxy, revoke } = Proxy.revocable(target, {});
        revoke();

        assert.doesNotThrow(() => redactAttributes(proxy));
});
test("does not throw when top-level attribute enumeration fails", () => {
        const hostile = new Proxy(
                {},
                {
                        ownKeys() {
                                throw new Error("ownKeys failed");
                        },
                },
        );

        assert.doesNotThrow(() => redactAttributes(hostile));
});
test("does not throw when an array element getter fails", () => {
        const hostile = [];
        Object.defineProperty(hostile, 0, {
                enumerable: true,
                get() {
                        throw new Error("array getter failed");
                },
        });

        assert.doesNotThrow(() => redactAttributes({ context: hostile }));
});
test("does not throw when an attribute getter fails", () => {
        const hostile = {};
        Object.defineProperty(hostile, "secret", {
                enumerable: true,
                get() {
                        throw new Error("getter failed");
                },
        });

        assert.doesNotThrow(() => redactAttributes({ context: hostile }));
});
test("handles circular references without leaking sensitive values", () => {
        const context = {};
        const nested = { password: "SECRET", safe: "ok" };

        context.self = context;
        context.nested = nested;

        const out = redactAttributes({ context });

        assert.equal(out.context.nested.password, MASK);
        assert.equal(out.context.nested.safe, "ok");
        assert.equal(out.context.self, out.context);
});
