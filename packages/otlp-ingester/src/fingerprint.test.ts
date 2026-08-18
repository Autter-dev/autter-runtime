import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintOccurrence, occurrenceIdFor } from "./fingerprint.js";
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
