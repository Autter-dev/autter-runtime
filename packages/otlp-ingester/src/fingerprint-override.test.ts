import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	fingerprintOverrideOf,
	manualFingerprint,
	parseFingerprintOverride,
} from "./fingerprint-override.js";
import { normalizeLogs } from "./logs.js";
import { browserPayloadSchema, normalizeBrowserPayload } from "./normalize-browser.js";
import { normalizeTraces } from "./normalize-otlp.js";

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

test("manualFingerprint follows the manual-v1 spec byte for byte", () => {
	// Shared vectors: sha256("manual-v1\0" + service + "\0" + values.join("\u0001"))[:32].
	assert.equal(manualFingerprint({ service: "web", fingerprintOverride: ["chunk-load"] }), "26c6c2e4050d368f56e84b0353dfc5a3");
	assert.equal(
		manualFingerprint({ service: "payments-api", fingerprintOverride: ["checkout", "card-timeout"] }),
		"7c4af6d4300ba423e4ab30dbc812e3cd",
	);
	const expected = createHash("sha256").update("manual-v1\u0000svc\u0000a\u0001b").digest("hex").slice(0, 32);
	assert.equal(manualFingerprint({ service: "svc", fingerprintOverride: ["a", "b"] }), expected);
	assert.match(expected, /^[0-9a-f]{32}$/);
});

test("manualFingerprint is null without an override", () => {
	assert.equal(manualFingerprint({ service: "web" }), null);
	assert.equal(manualFingerprint({ service: "web", fingerprintOverride: [] }), null);
	assert.equal(manualFingerprint({ service: "web", fingerprintOverride: [""] }), null);
});

test("manualFingerprint bounds the values: 10 strings, 200 chars each", () => {
	const eleven = Array.from({ length: 11 }, (_, i) => `v${i}`);
	assert.equal(
		manualFingerprint({ service: "web", fingerprintOverride: eleven }),
		manualFingerprint({ service: "web", fingerprintOverride: eleven.slice(0, 10) }),
	);
	assert.equal(
		manualFingerprint({ service: "web", fingerprintOverride: ["a".repeat(300)] }),
		"0b1e98f2be406903a469f1060110d3b5", // the 200-char value
	);
	// Order matters and the service is part of the identity.
	assert.notEqual(
		manualFingerprint({ service: "web", fingerprintOverride: ["a", "b"] }),
		manualFingerprint({ service: "web", fingerprintOverride: ["b", "a"] }),
	);
	assert.notEqual(
		manualFingerprint({ service: "web", fingerprintOverride: ["a"] }),
		manualFingerprint({ service: "api", fingerprintOverride: ["a"] }),
	);
	// One value with a space is not two values.
	assert.notEqual(
		manualFingerprint({ service: "web", fingerprintOverride: ["a b"] }),
		manualFingerprint({ service: "web", fingerprintOverride: ["a", "b"] }),
	);
});

test("parseFingerprintOverride reads strings, JSON arrays and arrays, scrubbed and bounded", () => {
	assert.deepEqual(parseFingerprintOverride("checkout"), ["checkout"]);
	assert.deepEqual(parseFingerprintOverride('["checkout","card-timeout"]'), ["checkout", "card-timeout"]);
	assert.deepEqual(parseFingerprintOverride(["checkout", 42, "", "x"]), ["checkout", "x"]);
	assert.deepEqual(parseFingerprintOverride("[not json"), ["[not json"]);
	assert.deepEqual(parseFingerprintOverride("user ada@example.com"), ["user [redacted]"]);
	assert.equal(parseFingerprintOverride(""), undefined);
	assert.equal(parseFingerprintOverride("[]"), undefined);
	assert.equal(parseFingerprintOverride(42), undefined);
	assert.equal(parseFingerprintOverride(undefined), undefined);
	assert.equal(parseFingerprintOverride(Array.from({ length: 30 }, () => "v"))!.length, 10);
	assert.equal(parseFingerprintOverride("b".repeat(5000))![0]!.length, 200);
	assert.deepEqual(fingerprintOverrideOf(undefined), {});
	assert.deepEqual(fingerprintOverrideOf("x"), { fingerprintOverride: ["x"] });
});

test("browser events carry `fingerprint`; a malformed one is dropped without rejecting the beacon", () => {
	const now = new Date().toISOString();
	const parsed = browserPayloadSchema.safeParse({
		version: 1,
		service: "web",
		environment: "production",
		events: [
			{ type: "exception", timestamp: now, message: "Loading chunk 12 failed", errorType: "ChunkLoadError", fingerprint: "chunk-load" },
			{ type: "exception", timestamp: now, message: "boom", fingerprint: ["checkout", "card-timeout"] },
			{ type: "exception", timestamp: now, message: "bad", fingerprint: { nope: true } },
			{ type: "exception", timestamp: now, message: "none" },
		],
	});
	assert.ok(parsed.success);
	const { occurrences } = normalizeBrowserPayload(parsed.data);
	assert.deepEqual(
		occurrences.map((o) => o.fingerprintOverride),
		[["chunk-load"], ["checkout", "card-timeout"], undefined, undefined],
	);
	assert.equal("fingerprintOverride" in occurrences[3]!, false, "absent, not undefined");
	assert.equal(
		manualFingerprint(occurrences[0]!),
		manualFingerprint({ service: "web", fingerprintOverride: ["chunk-load"] }),
	);
});

test("OTLP exception events read autter.fingerprint, falling back to the span", () => {
	const { occurrences } = normalizeTraces({
		resourceSpans: [
			{
				resource: { attributes: [str("service.name", "payments-api")] },
				scopeSpans: [
					{
						spans: [
							{
								traceId: "a".repeat(32),
								spanId: "b".repeat(16),
								name: "POST /pay",
								attributes: [str("autter.fingerprint", '["span-level"]')],
								status: { code: 2 },
								events: [
									{ name: "exception", attributes: [str("exception.type", "Error"), str("exception.message", "one"), str("autter.fingerprint", '["checkout","card-timeout"]')] },
									{ name: "exception", attributes: [str("exception.type", "Error"), str("exception.message", "two")] },
								],
							},
							{
								traceId: "c".repeat(32),
								spanId: "d".repeat(16),
								name: "job",
								status: { code: 2 },
								events: [{ name: "exception", attributes: [str("exception.type", "Error"), str("exception.message", "three")] }],
							},
						],
					},
				],
			},
		],
	});
	assert.deepEqual(
		occurrences.map((o) => o.fingerprintOverride),
		[["checkout", "card-timeout"], ["span-level"], undefined],
	);
	assert.equal(manualFingerprint(occurrences[0]!), "7c4af6d4300ba423e4ab30dbc812e3cd");
});

test("promoted error logs (edge, logger-only) read autter.fingerprint", () => {
	const record = (attributes: ReturnType<typeof str>[]) => ({
		timeUnixNano: "1760000000000000000",
		severityNumber: 17,
		body: { stringValue: "failed" },
		attributes: [str("autter.capture.mode", "log"), str("exception.type", "Error"), str("exception.message", "failed"), ...attributes],
	});
	const rows = normalizeLogs({
		resourceLogs: [
			{
				resource: { attributes: [str("service.name", "edge-api")] },
				scopeLogs: [{ logRecords: [record([str("autter.fingerprint", '["chunk-load"]')]), record([])] }],
			},
		],
	});
	assert.deepEqual(rows.map((r) => r.occurrence?.fingerprintOverride), [["chunk-load"], undefined]);
});
