import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	redactAttributes,
	RuntimeError,
	defineRuntimeErrors,
	isRuntimeErrorLike,
	errorAttributes,
	errorInternal,
	toClientError,
	responseStatusOf,
	isValidErrorCode,
	codeFingerprint,
	parseCarrier,
	createCarrier,
	resolveRequestId,
	normalizeRoutePath,
	compileIgnore,
	requestOutcome,
	createInlineLogState,
	appendInlineLog,
	addAiUsage,
	parseUserAgent,
	toOtlpLogRecord,
	boundContext,
	mergeContext,
} from "../dist/index.js";

test("code fingerprints match the shared code-v1 test vectors", async () => {
	const vectors = JSON.parse(
		readFileSync(new URL("../fixtures/code-fingerprints.json", import.meta.url)),
	);
	for (const { service, code, fingerprint } of vectors)
		assert.equal(await codeFingerprint(service, code), fingerprint);
	assert.equal(await codeFingerprint("svc", "Bad Code"), null);
});

test("code validation follows CODE_PATTERN and the 80-char limit", () => {
	for (const ok of ["billing", "billing.declined", "a.b.c.d", "github.app_permission_missing"])
		assert.ok(isValidErrorCode(ok), ok);
	for (const bad of ["Billing.x", "1abc", "a.b.c.d.e", "billing-declined", "a.", `a${"x".repeat(80)}`, "ECONNREFUSED"])
		assert.ok(!isValidErrorCode(bad), bad);
});

test("catalogs build typed, namespaced RuntimeErrors", () => {
	const billing = defineRuntimeErrors("billing", {
		declined: {
			status: 402,
			message: "Payment declined",
			expected: true,
			why: "The card issuer rejected the charge",
			fix: "Ask for another card",
			link: "https://docs.example.com/payments#declined",
		},
		limit: ({ plan }) => ({ status: 429, message: `Plan ${plan} limit reached`, fix: "Upgrade" }),
	});
	const declined = billing.declined({ internal: { cardBin: "424242" } });
	assert.ok(declined instanceof RuntimeError);
	assert.equal(declined.code, "billing.declined");
	assert.equal(billing.declined.code, "billing.declined");
	assert.equal(declined.status, 402);
	assert.equal(declined.expected, true);
	const limit = billing.limit({ plan: "free" });
	assert.equal(limit.code, "billing.limit");
	assert.equal(limit.message, "Plan free limit reached");
	assert.match(limit.stack, /core\.test\.mjs/);
	// internal is not enumerable, never serialised
	assert.equal(JSON.stringify(declined).includes("424242"), false);
	assert.deepEqual(errorInternal(declined), { cardBin: "424242" });
});

test("invalid codes are dropped with a one-time warning", () => {
	const warnings = [];
	const original = console.warn;
	console.warn = (message) => warnings.push(message);
	try {
		const a = new RuntimeError({ code: "Order 1234 failed", message: "x" });
		new RuntimeError({ code: "Order 1234 failed", message: "y" });
		assert.equal(a.code, undefined);
		assert.equal(warnings.length, 1);
		assert.deepEqual(errorAttributes(a), {});
	} finally {
		console.warn = original;
	}
});

test("duck typing reads code/why/fix/link/status/expected from any error", () => {
	class AppError extends Error {
		constructor() {
			super("Session expired");
			this.code = "auth.session_expired";
			this.why = "Token older than 24h";
			this.statusCode = 401;
			this.expected = true;
		}
	}
	const err = new AppError();
	assert.ok(isRuntimeErrorLike(err));
	assert.ok(!isRuntimeErrorLike(new Error("plain")));
	assert.deepEqual(errorAttributes(err), {
		"autter.error.code": "auth.session_expired",
		"autter.error.why": "Token older than 24h",
		"autter.error.status": 401,
		"autter.error.expected": true,
	});
	// foreign codes are ignored, not warned
	const sys = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
	assert.equal(errorAttributes(sys)["autter.error.code"], undefined);
});

test("cause chains become exception.cause.N.* (max 5)", () => {
	let cause = Object.assign(new Error("root"), { code: "ECONNRESET" });
	for (let i = 0; i < 7; i++) cause = new Error(`level ${i}`, { cause });
	const err = new RuntimeError({ code: "inventory.reservation_timeout", message: "timeout", cause });
	const attrs = errorAttributes(err);
	assert.equal(attrs["exception.cause.1.message"], "level 6");
	assert.equal(attrs["exception.cause.5.message"], "level 2");
	assert.equal(attrs["exception.cause.6.message"], undefined);
	const short = errorAttributes(new RuntimeError({ message: "x", cause: Object.assign(new TypeError("t"), { code: "E1" }) }));
	assert.equal(short["exception.cause.1.type"], "TypeError");
	assert.equal(short["exception.cause.1.code"], "E1");
});

test("toClientError never leaks internal or plain 5xx messages", () => {
	const err = new RuntimeError({
		code: "billing.limit",
		message: "Plan limit reached",
		status: 429,
		fix: "Upgrade",
		internal: { secret: "s3cr3t" },
		cause: new Error("db password=hunter2"),
	});
	const body = toClientError(err, "req-12345678");
	assert.deepEqual(body, {
		error: { message: "Plan limit reached", code: "billing.limit", fix: "Upgrade", requestId: "req-12345678" },
	});
	assert.equal(JSON.stringify(body).includes("s3cr3t"), false);
	assert.equal(JSON.stringify(body).includes("hunter2"), false);
	assert.deepEqual(toClientError(new Error("SELECT * FROM users failed")), {
		error: { message: "Internal Server Error" },
	});
	assert.equal(responseStatusOf(err), 429);
	assert.equal(responseStatusOf(new Error("x")), 500);
});

test("carriers round-trip and reject malformed input", () => {
	const carrier = createCarrier({
		op: "6f1c2b9e-1111-4222-8333-944455556666",
		req: "req-abcdef12",
		traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
	});
	assert.deepEqual(parseCarrier(JSON.stringify(carrier)), carrier);
	assert.equal(parseCarrier({ v: 2, op: "x" }), null);
	assert.equal(parseCarrier("not json"), null);
	assert.deepEqual(parseCarrier({ v: 1, op: "op-1", req: "bad id!", traceparent: "junk" }), { v: 1, op: "op-1" });
});

test("request helpers: ids, route normalisation, ignore globs, outcomes", () => {
	assert.equal(resolveRequestId("abc12345"), "abc12345");
	assert.match(resolveRequestId("short"), /^[0-9a-f-]{36}$/);
	assert.match(resolveRequestId("has spaces in it"), /^[0-9a-f-]{36}$/);
	assert.equal(normalizeRoutePath("/orders/812/items/6f1c2b9e-1111-4222-8333-944455556666?x=1"), "/orders/:id/items/:id");
	const ignored = compileIgnore(["/healthz", "/metrics/*", "/static/**"]);
	assert.ok(ignored("/healthz"));
	assert.ok(ignored("/healthz?probe=1"));
	assert.ok(ignored("/metrics/node"));
	assert.ok(!ignored("/metrics/node/extra"));
	assert.ok(ignored("/static/a/b/c.js"));
	assert.ok(!ignored("/api"));
	assert.equal(requestOutcome({ status: 200 }), "succeeded");
	assert.equal(requestOutcome({ status: 503 }), "failed");
	assert.equal(requestOutcome({ thrown: true, status: 200 }), "failed");
	assert.equal(requestOutcome({ aborted: true, status: 200 }), "cancelled");
	assert.equal(requestOutcome({ error: { expected: true }, thrown: true, status: 402 }), "degraded");
	assert.equal(requestOutcome({ explicit: "degraded", status: 500 }), "degraded");
});

test("inline logs are bounded at 50 and track the highest level", () => {
	const state = createInlineLogState(Date.now());
	appendInlineLog(state, "info", "hello person@example.com", { token: "abc" });
	assert.equal(state.logs[0].message.includes("person@example.com"), false);
	assert.equal(state.logs[0].attrs.token, "[redacted]");
	appendInlineLog(state, "warning", "careful");
	for (let i = 0; i < 60; i++) appendInlineLog(state, "debug", `m${i}`);
	assert.equal(state.logs.length, 50);
	assert.equal(state.logsTruncated, true);
	assert.equal(state.level, "warning");
});

test("AI rollup accumulates usage and distinct models", () => {
	let ai = addAiUsage(undefined, { model: "gpt-5-mini", inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
	ai = addAiUsage(ai, { model: "gpt-5-mini", inputTokens: 1, cacheReadTokens: 4, costUsd: 0.002 });
	ai = addAiUsage(ai, { model: "claude-sonnet-4" });
	assert.deepEqual(ai, {
		calls: 3,
		input_tokens: 11,
		output_tokens: 5,
		cache_read_tokens: 4,
		cost_usd: 0.003,
		models: ["gpt-5-mini", "claude-sonnet-4"],
	});
});

test("user agents map coarsely", () => {
	const chrome = parseUserAgent(
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	);
	assert.deepEqual(chrome, { browser: "Chrome 120", os: "Windows", device: "desktop", bot: false });
	assert.equal(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1").device, "mobile");
	assert.equal(parseUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)").device, "bot");
	assert.equal(parseUserAgent("").device, "unknown");
});

test("context bounding redacts, strips reserved keys and orders logs last", () => {
	const merged = mergeContext({}, {
		"autter.operation.id": "spoof",
		"autter.request.id": "spoof",
		"autter.error.code": "spoof.code",
		password: "hunter2",
		cart: { items: 2 },
	});
	assert.deepEqual(merged, { password: "[redacted]", cart: { items: 2 } });
	const bounded = boundContext({ user: 1, "autter.operation.logs": [], "autter.event.type": "operation", "exception.type": "E" });
	assert.deepEqual(Object.keys(bounded), ["autter.event.type", "exception.type", "user", "autter.operation.logs"]);
	const record = toOtlpLogRecord({ time: 1, level: "warning", message: "m", attributes: { a: 1 } });
	assert.deepEqual(record, {
		timeUnixNano: "1000000",
		severityNumber: 13,
		severityText: "WARNING",
		body: { stringValue: "m" },
		attributes: [{ key: "a", value: { doubleValue: 1 } }],
	});
});

test("value redaction is linear on adversarial strings (no ReDoS)", async () => {
	const { makeRedactor, boundContext } = await import("../dist/index.js");
	const redact = makeRedactor(true);
	const inputs = [
		"a".repeat(262_144),
		"a.".repeat(131_072),
		"xoxb-".repeat(52_000),
		"eyJ".repeat(87_000),
		"xa+".repeat(87_000),
		"http://".repeat(37_000),
	];
	for (const value of inputs) {
		const started = performance.now();
		redact({ value });
		boundContext({ value }, redact);
		assert.ok(performance.now() - started < 1000, `redaction too slow for ${value.slice(0, 8)}…`);
	}
	// Behaviour is unchanged for real secrets.
	const out = redact({
		mail: "contact jane.doe+x@example.co.uk now",
		db: "postgres://user:pw@host/db",
		slack: "token xoxb-1234567890-abcdef",
	});
	assert.equal(out.mail, "contact [redacted] now");
	assert.equal(out.db, "postgres://[redacted]@host/db");
	assert.equal(out.slack, "token [redacted]");
	assert.equal(boundContext({ url: "see https://a.com/x?token=1#f and http://b.com?y" }, redact).url, "see https://a.com/x and http://b.com");
});

test("token usage counts are not masked as secrets", () => {
	const out = redactAttributes({
		cache_creation_tokens: 3,
		cache_read_input_tokens: 2,
		reasoning_tokens: 9,
		api_token: "abc",
	});
	assert.equal(out.cache_creation_tokens, 3);
	assert.equal(out.cache_read_input_tokens, 2);
	assert.equal(out.reasoning_tokens, 9);
	assert.equal(out.api_token, "[redacted]");
});
