// Wrong-key handling in the edge SDK: clean what can be cleaned, drop a
// personal access token, warn once, never throw.
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureEdgeException } from "../dist/index.js";

function capture() {
	const sent = [];
	const warnings = [];
	const original = console.warn;
	console.warn = (line) => warnings.push(String(line));
	return {
		sent,
		warnings,
		fetch: async (url, init) => {
			sent.push({ url: String(url), authorization: init?.headers?.authorization ?? init?.headers?.get?.("authorization") });
			return new Response("{}", { status: 200 });
		},
		restore: () => (console.warn = original),
	};
}

test("a quoted key is cleaned and warned about once", async () => {
	const c = capture();
	try {
		for (let i = 0; i < 2; i++)
			await captureEdgeException({ apiKey: '"autter_rt_abc123"', service: "s", fetch: c.fetch }, new Error(`boom ${i}`));
		assert.ok(c.sent.length >= 1);
		for (const r of c.sent) assert.equal(r.authorization, "Bearer autter_rt_abc123");
		assert.equal(c.warnings.filter((w) => w.includes("wrapped in quotes")).length, 1);
	} finally {
		c.restore();
	}
});

test("a personal access token is never sent, and is named once", async () => {
	const c = capture();
	try {
		for (let i = 0; i < 2; i++)
			await captureEdgeException({ apiKey: "autter_pat_secretsecret", service: "s", fetch: c.fetch }, new Error(`boom ${i}`));
		assert.deepEqual(c.sent, []);
		const named = c.warnings.filter((w) => w.includes("personal access token"));
		assert.equal(named.length, 1);
		assert.match(named[0], /Settings > Keys and tokens\./);
		assert.ok(!c.warnings.join("\n").includes("secretsecret"));
	} finally {
		c.restore();
	}
});

test("a client key is sent as before, with a warning naming the server key", async () => {
	const c = capture();
	try {
		await captureEdgeException({ apiKey: "autter_rtc_publicpublic", service: "s", fetch: c.fetch }, new Error("boom"));
		assert.equal(c.sent.length, 1);
		assert.ok(c.warnings.some((w) => w.includes("This is a runtime client key (autter_rtc_…), for browser errors.")));
	} finally {
		c.restore();
	}
});
