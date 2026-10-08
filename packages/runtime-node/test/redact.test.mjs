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
test("bounds top-level attributes safely", () => {
        const attributes = {};

        for (let i = 0; i < 1005; i += 1) {
                attributes["key_" + i] = "value";
        }

        const out = redactAttributes(attributes);

        assert.ok(Object.keys(out).length <= 1001);
        assert.equal(out.__redaction_truncated__, MASK);
        assert.equal(out.key_0, "value");
        assert.equal(out.key_999, "value");
        assert.equal(out.key_1000, undefined);
});
test("handles circular references without leaking sensitive values", () => {
        const context = {};
        const nested = { password: "SECRET", safe: "ok" };

        context.self = context;
        context.nested = nested;

        const out = redactAttributes({ context });

        assert.equal(out.context.nested.password, MASK);
        assert.equal(out.context.nested.safe, "ok");
        assert.equal(out.context.self, MASK);
});

// ---------------------------------------------------------------------------
// Shared vectors (test-vectors/redaction.json) — the same cases run against
// the browser SDK, the ingester, and the Python adapter, so every layer
// agrees on what a secret looks like.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { redactText, sanitizeBrowserPayload } from "../dist/index.js";

const vectors = JSON.parse(
	readFileSync(new URL("../../../test-vectors/redaction.json", import.meta.url), "utf8"),
);
const join = (value) => (Array.isArray(value) ? value.join("") : value);

for (const vector of vectors.text) {
	if (vector.skip?.includes("node")) continue;
	test(`redactText vector: ${vector.name}`, () => {
		assert.equal(redactText(join(vector.input)), join(vector.expect));
	});
}

test("sensitive keys are masked case-insensitively at any depth", () => {
	for (const key of vectors.keys.sensitive) {
		const out = redactAttributes({ outer: { inner: [{ [key]: "raw-value" }] } });
		assert.equal(out.outer.inner[0][key], MASK, key);
	}
	for (const key of vectors.keys.safe) {
		const out = redactAttributes({ outer: { [key]: "kept" } });
		assert.equal(out.outer[key], "kept", key);
	}
});

test("secrets inside nested string values are scrubbed, not just keys", () => {
	const out = redactAttributes({
		job: { args: ["--db", "postgres://u:pw123@db/x"], note: "Cookie: a=b" },
	});
	assert.deepEqual(out.job.args, ["--db", `postgres://${MASK}@db/x`]);
	assert.equal(out.job.note, `Cookie: ${MASK}`);
});

test("stringified stack traces are scanned line by line", () => {
	const err = new Error("auth failed: Authorization: Bearer abcdefghijklmnop123456");
	const out = redactText(err.stack);
	assert.ok(!out.includes("abcdefghijklmnop123456"));
	assert.match(out, /^Error: auth failed: Authorization: \[redacted\]\n\s+at /);
});

test("custom value patterns apply to every match even without the g flag", () => {
	const out = redactText("CUST-1 and CUST-2", {
		additionalValuePatterns: [/CUST-\d/],
	});
	assert.equal(out, `${MASK} and ${MASK}`);
});

test("custom key patterns extend the built-in list", () => {
	const out = redactAttributes({ tenant_ref: "t-1", other: "x" }, {
		additionalKeyPatterns: [/tenant_ref/],
	});
	assert.deepEqual(out, { tenant_ref: MASK, other: "x" });
});

test("the browser relay scrubs message, stack, name and nested context", () => {
	const payload = sanitizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "production",
		events: [{
			type: "exception",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: "fetch failed for https://api.test/x?token=abc123secret",
			stack: "Error: x\n    at f (https://app.test/a.js:1:1) jane@example.com",
			name: "/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpM",
			context: { form: { password: "p@ss", plan: "pro" }, note: "sk-abcdefghijklmnopqrstuvwxyz" },
		}],
	});
	const [event] = payload.events;
	assert.equal(event.message, `fetch failed for https://api.test/x?token=${MASK}`);
	assert.ok(!event.stack.includes("jane@example.com"));
	assert.equal(event.name, `/verify/${MASK}`);
	assert.deepEqual(event.context, { form: { password: MASK, plan: "pro" }, note: MASK });
});

test("JWT pattern stays linear on long dash-joined runs", async () => {
	const { redactText } = await import("../dist/index.js");
	const started = Date.now();
	redactText("eyJ-".repeat(16384));
	assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
});

test("custom key and value patterns ignore g/y flags", () => {
	const keys = redactAttributes(
		{ internal_a: "x", internal_b: "y", internal_c: "z" },
		{ additionalKeyPatterns: [/internal/g] },
	);
	assert.deepEqual(keys, { internal_a: MASK, internal_b: MASK, internal_c: MASK });
	const values = redactAttributes({ note: "id CUST-123 and CUST-456" }, { additionalValuePatterns: [/CUST-\d+/y] });
	assert.equal(values.note, `id ${MASK} and ${MASK}`);
});
