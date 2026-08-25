import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBrowserPayload } from "./normalize-browser.ts";

function contextOf(payload: unknown): Record<string, unknown> {
	const result = normalizeBrowserPayload(
		payload as Parameters<typeof normalizeBrowserPayload>[0],
	);
	return (result.occurrences[0]?.attributes?.context ?? {}) as Record<
		string,
		unknown
	>;
}

const baseEvent = {
	type: "exception" as const,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: "boom",
};

test("masks sensitive-keyed context values before storage", () => {
	const stored = contextOf({
		version: 1,
		service: "web",
		environment: "prod",
		events: [
			{
				...baseEvent,
				context: {
					"user.email": "jane@example.com",
					authToken: "raw-token",
					card_number: "4111111111111111",
				},
			},
		],
	});
	assert.equal(stored["user.email"], "[redacted]");
	assert.equal(stored.authToken, "[redacted]");
	assert.equal(stored.card_number, "[redacted]");
});

test("scrubs email-shaped strings in ordinary values", () => {
	const stored = contextOf({
		version: 1,
		service: "web",
		environment: "prod",
		events: [{ ...baseEvent, context: { note: "mail a@b.io now" } }],
	});
	assert.equal(stored.note, "mail [redacted] now");
});

test("keeps non-sensitive context intact and drops nullish entries", () => {
	const stored = contextOf({
		version: 1,
		service: "web",
		environment: "prod",
		events: [
			{
				...baseEvent,
				context: { plan: "pro", seats: 5, empty: null, gone: undefined },
			},
		],
	});
	assert.deepEqual(stored, { plan: "pro", seats: 5 });
});

test("track_event rollups still work with scrubbed contexts", () => {
	const result = normalizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "prod",
		events: [
			{
				type: "track_event",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: "",
				name: "checkout_opened",
				context: { "user.email": "a@b.com" },
			},
		],
	});
	assert.equal(result.metricPoints[0]?.route, "event:checkout_opened");
});
