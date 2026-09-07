import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fingerprintOccurrence,
	normalizeStackFrames,
	occurrenceIdFor,
} from "./fingerprint.js";
import { STACK_FIXTURES } from "./stack-fixtures.js";
import type { RuntimeOccurrenceInput } from "./types.js";

function input(
	overrides: Partial<RuntimeOccurrenceInput> = {},
): RuntimeOccurrenceInput {
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

test("occurrenceIdFor is a pure function of the signal", () => {
	const scope = { orgId: "org", repositoryId: "repo" };
	const a = occurrenceIdFor(scope, input(), "fp", 0);
	// Same signal (an exporter retry of the same batch) → same id.
	assert.equal(a, occurrenceIdFor(scope, input(), "fp", 0));
	assert.match(a, /^[0-9a-f]{32}$/);
});

test("occurrenceIdFor separates distinct signals", () => {
	const scope = { orgId: "org", repositoryId: "repo" };
	const a = occurrenceIdFor(scope, input(), "fp", 0);
	// Different batch position (identical twin events in one batch).
	assert.notEqual(a, occurrenceIdFor(scope, input(), "fp", 1));
	// Different millisecond.
	assert.notEqual(
		a,
		occurrenceIdFor(
			scope,
			input({ occurredAt: new Date("2026-01-01T00:00:00.001Z") }),
			"fp",
			0,
		),
	);
	// Different trace.
	assert.notEqual(
		a,
		occurrenceIdFor(scope, input({ traceId: "trace-2" }), "fp", 0),
	);
	// Different tenant.
	assert.notEqual(
		a,
		occurrenceIdFor({ orgId: "org2", repositoryId: "repo" }, input(), "fp", 0),
	);
});

test("fingerprint groups per-value message variants into one issue", () => {
	const a = fingerprintOccurrence(input({ message: "user 42 not found" }));
	const b = fingerprintOccurrence(input({ message: "user 7 not found" }));
	assert.equal(a, b);
	const c = fingerprintOccurrence(input({ errorType: "RangeError" }));
	assert.notEqual(a, c);
});

// ── Cross-language stack-frame fingerprinting ───────────────────────────────
//
// Every officially-supported runtime must: (1) yield the expected normalised
// top frames, (2) group the same defect consistently even when line numbers /
// offsets drift across re-deploys, and (3) keep two DIFFERENT defects that
// happen to share an error message in separate issues — the regression this
// pipeline exists to prevent (Go and Rust frames used to be discarded, so
// unrelated backend panics collapsed onto the message alone).

const LANGUAGES = Object.keys(STACK_FIXTURES);

for (const language of LANGUAGES) {
	const fixture = STACK_FIXTURES[language]!;

	test(`normalizeStackFrames extracts golden frames for ${language}`, () => {
		assert.deepEqual(
			normalizeStackFrames(fixture.primary),
			fixture.primaryFrames,
		);
		// A supported stack must never be discarded — that is what collapses
		// distinct defects into one issue.
		assert.ok(fixture.primaryFrames.length > 0);
	});

	test(`fingerprint is stable across repeated ingestion for ${language}`, () => {
		const first = fingerprintOccurrence(input({ stack: fixture.primary }));
		const second = fingerprintOccurrence(input({ stack: fixture.primary }));
		assert.equal(first, second);
	});

	test(`fingerprint survives line-number drift across re-deploys for ${language}`, () => {
		const before = fingerprintOccurrence(input({ stack: fixture.primary }));
		const after = fingerprintOccurrence(input({ stack: fixture.redeploy }));
		assert.equal(before, after);
	});

	test(`different defects with the same message stay separate for ${language}`, () => {
		// Identical everything EXCEPT the stack (same error message, type, route).
		const primary = fingerprintOccurrence(input({ stack: fixture.primary }));
		const sibling = fingerprintOccurrence(input({ stack: fixture.sibling }));
		assert.notEqual(primary, sibling);
	});
}

test("stacks from different languages never collide", () => {
	const fingerprints = LANGUAGES.map((language) =>
		fingerprintOccurrence(input({ stack: STACK_FIXTURES[language]!.primary })),
	);
	assert.equal(new Set(fingerprints).size, fingerprints.length);
});

test("an unparseable but structured stack still separates distinct defects", () => {
	// Ruby is not a first-class runtime here, but its frames are clearly
	// structured — the fallback must still keep unrelated errors apart instead
	// of dropping every frame.
	const rubyA = [
		"/app/orders/service.rb:88:in `process'",
		"/app/web/handler.rb:42:in `handle'",
	].join("\n");
	const rubyB = [
		"/app/payments/service.rb:212:in `charge'",
		"/app/web/handler.rb:42:in `handle'",
	].join("\n");
	assert.ok(normalizeStackFrames(rubyA).length > 0);
	assert.notEqual(
		fingerprintOccurrence(input({ stack: rubyA })),
		fingerprintOccurrence(input({ stack: rubyB })),
	);
});

test("a stackless message never fabricates frames", () => {
	assert.deepEqual(normalizeStackFrames("just a bare message, no frames"), []);
	assert.deepEqual(normalizeStackFrames(null), []);
});
