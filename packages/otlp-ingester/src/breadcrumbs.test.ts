import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attributesWithBreadcrumbs,
	breadcrumbsField,
	MAX_BREADCRUMBS,
	parseBreadcrumbs,
} from "./breadcrumbs.js";
import { browserPayloadSchema, normalizeBrowserPayload } from "./normalize-browser.js";
import { normalizeTraces } from "./normalize-otlp.js";
import { sinkOccurrence } from "./sink.js";
import type { RuntimeOccurrence } from "./types.js";

const AT = "2026-10-20T10:00:00.000Z";

test("keeps the newest 30 valid breadcrumbs, oldest first", () => {
	const raw = Array.from({ length: 45 }, (_, i) => ({ type: "log", at: AT, message: `step ${i}` }));
	const out = parseBreadcrumbs(raw)!;
	assert.equal(MAX_BREADCRUMBS, 30);
	assert.equal(out.length, 30);
	assert.equal(out[0]!.message, "step 15");
	assert.equal(out[29]!.message, "step 44");
});

test("whitelists fields, normalises type/level/at, drops malformed entries one by one", () => {
	const out = parseBreadcrumbs([
		{ type: "request", at: AT, level: "warn", message: "GET /api 404", data: { status: 404 }, extra: "dropped" },
		{ type: "teleport", at: Date.parse(AT), level: "LOUD", message: "unknown type" },
		{ type: "click", at: "not a date", message: "no time" },
		"not an object",
		null,
		{ type: "log", at: AT },
		{ type: "console", at: AT, level: "fatal", message: 42 },
	])!;
	assert.deepEqual(out, [
		{ type: "request", at: AT, level: "warning", message: "GET /api 404", data: { status: 404 } },
		{ type: "custom", at: AT, message: "unknown type" },
		{ type: "console", at: AT, level: "error", message: "42" },
	]);
});

test("scrubs messages and data, masks sensitive keys, strips URL queries, bounds sizes", () => {
	const [crumb] = parseBreadcrumbs([
		{
			type: "custom",
			at: AT,
			message: `charge jane@example.com with sk_live_${"a".repeat(24)} via https://api.example.test/pay?token=abc#x ${"z".repeat(900)}`,
			data: {
				password: "hunter2",
				url: "https://api.example.test/pay?token=abc",
				note: "Bearer abcdefghijklmnop",
				big: "y".repeat(500),
				nested: { a: 1 },
				nan: Number.NaN,
				ok: true,
				none: null,
				__proto__: "x",
				...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i])),
			},
		},
	])!;
	assert.ok(crumb);
	assert.ok(!crumb.message.includes("jane@example.com"));
	assert.ok(!crumb.message.includes("sk_live_"));
	assert.ok(!crumb.message.includes("token=abc"));
	assert.equal(crumb.message.length, 500);
	const data = crumb.data!;
	assert.equal(data.password, "[redacted]");
	assert.equal(data.url, "https://api.example.test/pay");
	assert.equal(data.note, "[redacted]");
	assert.equal((data.big as string).length, 200);
	assert.equal(data.ok, true);
	assert.equal(data.none, null);
	assert.ok(!("nested" in data) && !("nan" in data));
	assert.equal(Object.keys(data).length, 10);
});

test("accepts the server SDK's JSON string, rejects junk and oversized lists", () => {
	const json = JSON.stringify([{ type: "log", at: AT, level: "info", message: "loaded cart" }]);
	assert.deepEqual(parseBreadcrumbs(json), [{ type: "log", at: AT, level: "info", message: "loaded cart" }]);
	assert.equal(parseBreadcrumbs("{not json"), undefined);
	assert.equal(parseBreadcrumbs("[]"), undefined);
	assert.equal(parseBreadcrumbs({ type: "log" }), undefined);
	assert.equal(parseBreadcrumbs(`[${"1,".repeat(200_000)}1]`), undefined);
	// 30 maximal breadcrumbs: the stored JSON stays within 16 KB, newest kept.
	const huge = Array.from({ length: 30 }, (_, i) => ({
		type: "custom",
		at: AT,
		message: `${i} ${"m".repeat(600)}`,
		data: Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`k${k}`, "v".repeat(300)])),
	}));
	const bounded = parseBreadcrumbs(huge)!;
	assert.ok(JSON.stringify(bounded).length <= 16 * 1024);
	assert.ok(bounded.at(-1)!.message.startsWith("29 "));
	assert.deepEqual(breadcrumbsField(undefined, json), { breadcrumbs: parseBreadcrumbs(json) });
	assert.deepEqual(breadcrumbsField("junk"), {});
});

test("browser events: a malformed breadcrumbs field never rejects the beacon", () => {
	const payload = browserPayloadSchema.parse({
		version: 1,
		service: "web",
		environment: "production",
		events: [
			{ type: "exception", timestamp: AT, message: "a", breadcrumbs: "nope" },
			{ type: "exception", timestamp: AT, message: "b", breadcrumbs: [{ type: "click", at: AT, message: "click:pay" }] },
		],
	});
	const { occurrences } = normalizeBrowserPayload(payload);
	assert.equal(occurrences[0]!.breadcrumbs, undefined);
	assert.deepEqual(occurrences[1]!.breadcrumbs, [{ type: "click", at: AT, message: "click:pay" }]);
});

test("OTLP: autter.breadcrumbs on the exception event becomes the field, not an attribute", () => {
	const nanos = `${Date.parse(AT)}000000`;
	const crumbs = JSON.stringify([{ type: "log", at: AT, level: "info", message: "user=jane@example.com loaded" }]);
	const { occurrences, spans } = normalizeTraces({
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
				scopeSpans: [
					{
						spans: [
							{
								traceId: "a".repeat(32),
								spanId: "b".repeat(16),
								name: "GET /cart",
								startTimeUnixNano: nanos,
								endTimeUnixNano: nanos,
								status: { code: 2 },
								attributes: [{ key: "autter.breadcrumbs", value: { stringValue: "[]" } }],
								events: [
									{
										name: "exception",
										timeUnixNano: nanos,
										attributes: [
											{ key: "exception.type", value: { stringValue: "Error" } },
											{ key: "exception.message", value: { stringValue: "boom" } },
											{ key: "autter.breadcrumbs", value: { stringValue: crumbs } },
										],
									},
								],
							},
						],
					},
				],
			},
		],
	});
	assert.deepEqual(occurrences[0]!.breadcrumbs, [{ type: "log", at: AT, level: "info", message: "user=[redacted] loaded" }]);
	assert.ok(!("autter.breadcrumbs" in (occurrences[0]!.attributes ?? {})));
	assert.ok(!("autter.breadcrumbs" in (spans[0]!.attributes ?? {})));
});

test("sink passes breadcrumbs through only when present; storage keeps them in attributes", () => {
	const base = {
		occurrenceId: "o1",
		fingerprint: "f".repeat(32),
		fingerprintScheme: "message-v1",
		source: "browser",
		severity: "error",
		service: "web",
		environment: "production",
		release: null,
		errorType: "Error",
		message: "boom",
		stack: null,
		route: null,
		method: null,
		statusCode: null,
		traceId: null,
		sessionId: null,
		attributes: { context: { a: 1 } },
		occurredAt: new Date(AT),
		routeNormalized: "",
		messageNormalized: "boom",
		topFrames: [],
		firstFrame: "",
	} as unknown as RuntimeOccurrence;
	assert.ok(!("breadcrumbs" in sinkOccurrence(base)));
	const crumbs = [{ type: "click" as const, at: AT, message: "click:pay" }];
	assert.deepEqual(sinkOccurrence({ ...base, breadcrumbs: crumbs }).breadcrumbs, crumbs);
	assert.deepEqual(attributesWithBreadcrumbs(base.attributes, crumbs), {
		context: { a: 1 },
		"autter.breadcrumbs": crumbs,
	});
	assert.deepEqual(attributesWithBreadcrumbs(base.attributes, undefined), { context: { a: 1 } });
	assert.deepEqual(attributesWithBreadcrumbs(null, []), {});
});
