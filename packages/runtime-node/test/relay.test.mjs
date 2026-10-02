import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeBrowserPayload } from "../dist/index.js";

const event = {
	type: "csp_violation",
	timestamp: "2026-01-01T00:00:00.000Z",
	message: "Content Security Policy blocked script-src-elem",
};

test("the relay keeps CSP violations", () => {
	const payload = sanitizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "production",
		events: [event],
	});
	assert.equal(payload?.events[0].type, "csp_violation");
});

test("the relay still rejects an unknown event type", () => {
	assert.equal(sanitizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "production",
		events: [{ ...event, type: "dom_recording" }],
	}), null);
});
