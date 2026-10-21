import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { deriveFields } from "./fingerprint.js";
import {
	applySuppression,
	globMatch,
	matchingRule,
	parseSuppressionRule,
	parseSuppressionRules,
	sampleUnit,
} from "./suppression.js";
import type { RuntimeOccurrence } from "./types.js";

/** Suppression rules set by the user (EI-38): drop or sample at ingest. */

let serial = 0;
function occurrence(overrides: Partial<RuntimeOccurrence> = {}): RuntimeOccurrence {
	serial += 1;
	const input = {
		source: "browser" as const,
		severity: "error" as const,
		service: "web",
		environment: "production",
		release: "v42",
		errorType: "Error",
		message: "ResizeObserver loop completed with undelivered notifications.",
		stack: null,
		route: "/checkout",
		method: null,
		statusCode: null,
		traceId: null,
		sessionId: null,
		attributes: null,
		occurredAt: new Date(),
		...overrides,
	};
	return {
		...input,
		// Content-derived like occurrenceIdFor: a hex digest.
		occurrenceId: createHash("sha256").update(String(serial)).digest("hex").slice(0, 32),
		fingerprint: "f".repeat(32),
		fingerprintScheme: "message-v1",
		...deriveFields(input),
		...overrides,
	} as RuntimeOccurrence;
}

const rule = (filters: unknown[], action: "drop" | "sample" = "drop", sampleRate?: number) => ({
	id: `rule-${Math.random()}`,
	filters,
	action,
	...(sampleRate !== undefined ? { sampleRate } : {}),
});

test("globs match whole values, star by star, without backtracking", () => {
	assert.equal(globMatch("resizeobserver loop*", "resizeobserver loop limit exceeded"), true);
	assert.equal(globMatch("*loop*", "resizeobserver loop limit exceeded"), true);
	assert.equal(globMatch("*exceeded", "resizeobserver loop limit exceeded"), true);
	assert.equal(globMatch("resize*limit", "resizeobserver loop limit exceeded"), false, "anchored at the end");
	assert.equal(globMatch("loop*", "resizeobserver loop"), false, "anchored at the start");
	assert.equal(globMatch("a*a", "a"), false);
	assert.equal(globMatch("a*", "a"), true);
	assert.equal(globMatch("*", ""), true);
	assert.equal(globMatch("exact", "exact"), true);
	assert.equal(globMatch("exact", "exactly"), false);
	// A pathological pattern finishes at once (no regex, no backtracking).
	const text = "a".repeat(4000);
	const started = performance.now();
	assert.equal(globMatch("*a*a*a*a*a*a*a*a*a*a*b", text), false);
	assert.ok(performance.now() - started < 50);
});

test("rules parse strictly: a rule with any invalid part is left out on its own", () => {
	const valid = rule([{ key: "errorType", op: "equals", value: "AbortError" }]);
	const rules = parseSuppressionRules([
		valid,
		rule([{ key: "errorType", op: "regex", value: "x" }]), // unknown operator
		rule([{ key: "userAgent", op: "equals", value: "x" }]), // unknown key
		rule([{ key: "message", op: "contains", value: "" }]), // empty value
		rule([{ key: "message", op: "contains", value: "x".repeat(501) }]), // oversized
		rule([]), // no filters
		rule([{ key: "message", op: "contains", value: "x" }], "sample", 1), // rate must be < 1
		rule([{ key: "message", op: "contains", value: "x" }], "sample", 0),
		rule([{ key: "message", op: "contains", value: "x" }], "sample"), // no rate
		{ ...valid, action: "delete" },
		{ ...valid, id: "" },
		"not a rule",
		null,
		rule([{ key: "message", op: "contains", value: "Y" }], "sample", 0.25),
	]);
	assert.deepEqual(rules.map((r) => r.action), ["drop", "sample"]);
	assert.equal(rules[0]!.filters[0]!.value, "aborterror", "values are lower-cased once");
	assert.equal(rules[1]!.sampleRate, 0.25);
	assert.deepEqual(parseSuppressionRules(undefined), []);
	assert.deepEqual(parseSuppressionRules({ rules: [] }), []);
	assert.deepEqual(parseSuppressionRules([{ get id() { throw new Error("boom"); } }, valid]).length, 1, "a throwing getter skips its rule only");
	assert.equal(parseSuppressionRule({ ...valid, filters: "errorType" }), null);
});

test("all filters of a rule must match; the first matching rule decides; comparisons ignore case", () => {
	const rules = parseSuppressionRules([
		rule([{ key: "service", op: "equals", value: "web" }, { key: "environment", op: "equals", value: "staging" }]),
		rule([{ key: "message", op: "matches", value: "resizeobserver loop*" }], "sample", 0.5),
		rule([{ key: "message", op: "contains", value: "RESIZEOBSERVER" }]),
	]);
	assert.equal(matchingRule(rules, occurrence())?.action, "sample", "the drop rule above needs staging too");
	assert.equal(matchingRule(rules, occurrence({ environment: "Staging" }))?.action, "drop");
	assert.equal(matchingRule(rules, occurrence({ message: "Network down" })), null);
	for (const [key, op, value, fields] of [
		["errorType", "equals", "chunkloaderror", { errorType: "ChunkLoadError" }],
		["route", "starts_with", "/admin", { route: "/admin/users" }],
		["release", "equals", "v41", { release: "v41" }],
		["source", "equals", "server", { source: "server" }],
		["service", "matches", "worker-*", { service: "worker-emails" }],
	] as const) {
		const only = parseSuppressionRules([rule([{ key, op, value }])]);
		assert.ok(matchingRule(only, occurrence(fields as Partial<RuntimeOccurrence>)), `${key} ${op} ${value}`);
		assert.equal(matchingRule(only, occurrence()), null, `${key} ${op} ${value} must not match the default`);
	}
	// A missing route or release is the empty string.
	const noRoute = parseSuppressionRules([rule([{ key: "route", op: "starts_with", value: "/" }])]);
	assert.equal(matchingRule(noRoute, occurrence({ route: null })), null);
});

test("drop leaves matching occurrences out and counts them", () => {
	const rules = parseSuppressionRules([rule([{ key: "errorType", op: "equals", value: "AbortError" }])]);
	const keep = occurrence();
	const result = applySuppression([occurrence({ errorType: "AbortError" }), keep, occurrence({ errorType: "AbortError", severity: "fatal" })], rules);
	assert.deepEqual(result.kept, [keep]);
	assert.equal(result.suppressed, 2, "an explicit drop also drops fatal");
	assert.deepEqual(applySuppression([keep], []), { kept: [keep], suppressed: 0 });
	assert.deepEqual(applySuppression([keep], undefined), { kept: [keep], suppressed: 0 });
});

test("sample keeps its rate of matches, by occurrence id, and never samples out fatal", () => {
	const rules = parseSuppressionRules([rule([{ key: "message", op: "contains", value: "resizeobserver" }], "sample", 0.1)]);
	const batch = Array.from({ length: 10_000 }, () => occurrence());
	const first = applySuppression(batch, rules);
	assert.ok(first.kept.length > 850 && first.kept.length < 1_150, `kept ${first.kept.length} of 10,000 at 10%`);
	assert.equal(first.kept.length + first.suppressed, 10_000);
	// Deterministic: a retried batch keeps the same occurrences.
	const again = applySuppression(batch, rules);
	assert.deepEqual(again.kept.map((o) => o.occurrenceId), first.kept.map((o) => o.occurrenceId));
	const fatal = Array.from({ length: 100 }, () => occurrence({ severity: "fatal" }));
	assert.equal(applySuppression(fatal, rules).kept.length, 100);
	assert.ok(sampleUnit("ffffffff") < 1 && sampleUnit("00000000") === 0);
	assert.ok(sampleUnit("not-hex-at-all") >= 0 && sampleUnit("not-hex-at-all") < 1);
});
