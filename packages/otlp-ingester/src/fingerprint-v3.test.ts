import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fingerprintOccurrence, occurrenceFingerprint } from "./fingerprint.js";
import {
	frameTokenFile,
	frameTokenFunction,
	framesV3Fingerprint,
	occurrenceIdentity,
} from "./fingerprint-v3.js";
import { STACK_FIXTURES } from "./stack-fixtures.js";
import { parseStackFrames } from "./stack-frames.js";
import type { RuntimeOccurrenceInput, StackFrame } from "./types.js";

/**
 * frames-v3 (contract §2). The vectors are shared with the platform mirror
 * (EI-19, runtime-frames-fingerprint.ts) and cross-checked at merge.
 */
const vectors = JSON.parse(
	readFileSync(new URL("./fingerprint-v3-vectors.json", import.meta.url), "utf8"),
) as Array<{
	name: string;
	input: { service: string; errorType: string; message: string; frames: StackFrame[] };
	fingerprint: string;
	parts: string[];
}>;

function input(overrides: Partial<RuntimeOccurrenceInput> = {}): RuntimeOccurrenceInput {
	return {
		source: "server",
		severity: "error",
		service: "svc",
		environment: "prod",
		release: null,
		errorType: "TypeError",
		message: "user 42 not found",
		stack: null,
		route: "/users/42",
		method: "GET",
		statusCode: 404,
		traceId: "trace-1",
		sessionId: null,
		attributes: null,
		occurredAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

function v3(overrides: Partial<RuntimeOccurrenceInput> = {}): string {
	const occurrence = input(overrides);
	const identity = occurrenceIdentity(occurrence, parseStackFrames(occurrence.stack));
	const candidate = identity.candidates.find((c) => c.scheme === "frames-v3");
	assert.ok(candidate, "uncoded occurrences carry a frames-v3 candidate");
	return candidate.fingerprint;
}

test("frames-v3 vectors: at least 25 cases", () => {
	assert.ok(vectors.length >= 25, `${vectors.length} vectors`);
});

for (const vector of vectors) {
	test(`frames-v3 vector: ${vector.name}`, () => {
		const result = framesV3Fingerprint(vector.input);
		assert.match(result.fingerprint, /^[0-9a-f]{32}$/);
		assert.equal(result.fingerprint, vector.fingerprint);
		assert.deepEqual(result.record, { scheme: "frames-v3", parts: vector.parts });
	});
}

test("token rules: prefixes, short unresolved names, anonymous and file runs", () => {
	const fn = (name: string | null, resolved = false) => frameTokenFunction({ function: name, resolved });
	assert.equal(fn("async new Widget"), "Widget");
	assert.equal(fn("Object.Module.x1"), "Module.x1");
	assert.equal(fn("Module.load"), "load");
	assert.equal(fn("Xe"), "");
	assert.equal(fn("Xe", true), "Xe");
	assert.equal(fn("<anonymous>"), "");
	assert.equal(fn("Object.<anonymous>"), "");
	assert.equal(fn("anonymous"), "");
	assert.equal(fn(null), "");
	const file = (filename: string | null, module: string | null = null) => frameTokenFile({ filename, module });
	assert.equal(file("https://a.example.com/assets/index-5f3a9c1e.js?v=1#x"), "index-*.js");
	assert.equal(file("C:\\src\\App\\OrderService.cs"), "orderservice.cs");
	assert.equal(file("/static/js/2.a1b2c3d4.chunk.js"), "2.*.chunk.js");
	assert.equal(file("/x/CHECKOUTS.js"), "*.js");
	assert.equal(file("/x/Checkouts.js"), "checkouts.js");
	assert.equal(file(null, "com.acme.Billing"), "com.acme.billing");
	assert.equal(file(null, null), "");
});

// ── Stability (the regressions frames-v3 exists to fix) ─────────────────────

for (const [language, fixture] of Object.entries(STACK_FIXTURES)) {
	test(`frames-v3 survives a redeploy (line/offset drift) for ${language}`, () => {
		assert.equal(v3({ stack: fixture.primary }), v3({ stack: fixture.redeploy }));
	});

	test(`frames-v3 keeps different defects with the same message apart for ${language}`, () => {
		assert.notEqual(v3({ stack: fixture.primary }), v3({ stack: fixture.sibling }));
	});
}

test("frames-v3 survives a browser redeploy: new chunk hash, offsets and origin", () => {
	const before = [
		"TypeError: Cannot read properties of undefined (reading 'total')",
		"    at Xe (https://app.example.com/assets/index-5f3a9c1e.js:1:23456)",
		"    at HTMLButtonElement.onClick (https://app.example.com/assets/index-5f3a9c1e.js:1:9876)",
	].join("\n");
	const after = [
		"TypeError: Cannot read properties of undefined (reading 'total')",
		"    at Qt (https://my-branch.preview.example.dev/assets/index-0b9d7e21.js:1:30111)",
		"    at HTMLButtonElement.onClick (https://my-branch.preview.example.dev/assets/index-0b9d7e21.js:1:10002)",
	].join("\n");
	const browser = { source: "browser" as const, route: "/checkout" };
	assert.equal(v3({ ...browser, stack: before }), v3({ ...browser, stack: after }));
	// The legacy scheme splits on exactly this (origin + chunk hash in the hash).
	assert.notEqual(
		fingerprintOccurrence(input({ ...browser, stack: before })),
		fingerprintOccurrence(input({ ...browser, stack: after })),
	);
});

test("frames-v3 ignores the route: one component failing on two pages is one issue", () => {
	const stack = STACK_FIXTURES.node!.primary;
	assert.equal(v3({ stack, route: "/orders/42" }), v3({ stack, route: "/invoices/7" }));
	assert.notEqual(
		fingerprintOccurrence(input({ stack, route: "/orders/42" })),
		fingerprintOccurrence(input({ stack, route: "/invoices/7" })),
	);
});

test("frames-v3 ignores the source: a browser and a server report of one bug match", () => {
	const stack = STACK_FIXTURES.node!.primary;
	assert.equal(v3({ stack, source: "browser" }), v3({ stack, source: "server" }));
	assert.notEqual(
		fingerprintOccurrence(input({ stack, source: "browser" })),
		fingerprintOccurrence(input({ stack, source: "server" })),
	);
});

test("frames-v3 ignores the release and the message when frames exist", () => {
	const stack = STACK_FIXTURES.go!.primary;
	assert.equal(
		v3({ stack, release: "a1", message: "order 1 failed: timeout" }),
		v3({ stack, release: "b2", message: "a completely different message" }),
	);
});

test("python: frames-v3 groups by the crash site, not the framework entry frames", () => {
	const shared = [
		"Traceback (most recent call last):",
		'  File "/usr/local/lib/python3.12/site-packages/django/core/handlers/base.py", line 197, in _get_response',
		'  File "/app/web/views.py", line 12, in dispatch',
	];
	const a = [...shared, '  File "/app/orders/service.py", line 51, in place', "ValueError: bad"].join("\n");
	const b = [...shared, '  File "/app/billing/invoice.py", line 9, in render', "ValueError: bad"].join("\n");
	assert.notEqual(v3({ stack: a }), v3({ stack: b }));
	const identity = occurrenceIdentity(input({ stack: a }), parseStackFrames(a));
	assert.deepEqual(identity.record?.parts, ["TypeError", "place@service.py", "dispatch@views.py"]);
});

// ── Candidate list (contract §1/§4) ────────────────────────────────────────

test("uncoded occurrences carry [frames-v3, message-v1]; the legacy identity is unchanged", () => {
	const occurrence = input({ stack: STACK_FIXTURES.java!.primary });
	const identity = occurrenceIdentity(occurrence, parseStackFrames(occurrence.stack));
	assert.deepEqual(identity.legacy, occurrenceFingerprint(occurrence));
	assert.deepEqual(
		identity.candidates.map((c) => c.scheme),
		["frames-v3", "message-v1"],
	);
	assert.equal(identity.candidates.at(-1)!.fingerprint, fingerprintOccurrence(occurrence));
	for (const candidate of identity.candidates) assert.match(candidate.fingerprint, /^[0-9a-f]{32}$/);
	assert.equal(identity.record?.scheme, "frames-v3");
});

test("coded occurrences carry [code-v1] only: the explicit scheme is the legacy one", () => {
	const occurrence = input({ errorCode: "billing.declined", service: "payments-api" });
	const identity = occurrenceIdentity(occurrence, []);
	assert.deepEqual(identity.candidates, [
		{ scheme: "code-v1", fingerprint: "1692d304df5e4edbd3a0bbac5d7658bb" },
	]);
	assert.equal(identity.legacy.scheme, "code-v1");
	assert.equal(identity.record, null);
});

test("a stackless error hashes its normalised message under frames-v3", () => {
	assert.equal(v3({ message: "user 42 not found" }), v3({ message: "user 7 not found" }));
	assert.notEqual(v3({ message: "user 42 not found" }), v3({ message: "cart 42 is empty" }));
});
