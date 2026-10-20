import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BreadcrumbTrail,
	breadcrumbsAttribute,
	makeRedactor,
	MAX_BREADCRUMBS,
	normalizeBreadcrumb,
	sanitizeBreadcrumbs,
} from "../dist/index.js";

const redact = makeRedactor(true);
const AT = "2026-10-20T10:00:00.000Z";

test("normalizeBreadcrumb whitelists, defaults and scrubs", () => {
	const crumb = normalizeBreadcrumb(
		{
			type: "teleport",
			level: "WARN",
			message: "paid with 4242 4242 4242 4242 at https://api.example.test/pay?token=abc",
			data: { url: "https://api.example.test/x?sig=1", apiKey: "k", count: 2, deep: { a: 1 }, nan: Number.NaN },
			extra: "dropped",
		},
		redact,
	);
	assert.equal(crumb.type, "custom");
	assert.equal(crumb.level, "warning");
	assert.ok(!Number.isNaN(Date.parse(crumb.at)), "defaults to now");
	assert.equal(crumb.message, "paid with [redacted] at https://api.example.test/pay");
	assert.deepEqual(crumb.data, { url: "https://api.example.test/x", apiKey: "[redacted]", count: 2 });
	assert.ok(!("extra" in crumb));
	assert.equal(normalizeBreadcrumb({ message: "x".repeat(2000) }, redact).message.length, 500);
	assert.equal(normalizeBreadcrumb({ message: "" }, redact), null);
	assert.equal(normalizeBreadcrumb({ message: "late", at: "nope" }, redact), null);
	assert.equal(normalizeBreadcrumb({ message: "no time" }, redact, { requireAt: true }), null);
	const hostile = new Proxy({}, { get() { throw new Error("trap"); } });
	assert.equal(normalizeBreadcrumb(hostile, redact), null);
});

test("sanitizeBreadcrumbs keeps the newest 30 valid entries, oldest first", () => {
	const list = Array.from({ length: 50 }, (_, i) => ({ type: "log", at: AT, message: `m${i}` }));
	const out = sanitizeBreadcrumbs([...list, { message: "no time" }, 7], redact);
	assert.equal(out.length, MAX_BREADCRUMBS);
	assert.equal(out[0].message, "m20");
	assert.equal(out[29].message, "m49");
	assert.equal(sanitizeBreadcrumbs("nope", redact), undefined);
	assert.equal(sanitizeBreadcrumbs([], redact), undefined);
});

test("BreadcrumbTrail is a 30-entry ring buffer that hands out copies", () => {
	const trail = new BreadcrumbTrail();
	for (let i = 0; i < 35; i++) trail.add({ type: "custom", at: AT, message: `s${i}`, data: { i } });
	assert.equal(trail.size, 30);
	const list = trail.list();
	assert.equal(list[0].message, "s5");
	list[0].data.i = -1;
	assert.equal(trail.list()[0].data.i, 5);
	trail.clear();
	assert.equal(trail.size, 0);
});

test("breadcrumbsAttribute is JSON the exporter's re-scrub leaves intact, within budget", () => {
	const scrub = redact.text;
	// Scrubbed once already, but the escaped quote lets the assignment
	// pattern match the serialised text a second time.
	const tricky = { type: "log", at: AT, message: 'password="[redacted]" then "ok"' };
	assert.notEqual(scrub(JSON.stringify(tricky)), JSON.stringify(tricky));
	const plain = { type: "request", at: AT, level: "info", message: "GET /api 200", data: { status: 200 } };
	const json = breadcrumbsAttribute([plain, tricky], scrub);
	assert.equal(scrub(json), json, "a fixed point of the export-time scrubber");
	assert.deepEqual(JSON.parse(json), [plain, { type: "log", at: AT, message: "[redacted]" }]);

	const many = Array.from({ length: 40 }, (_, i) => ({ type: "custom", at: AT, message: `${i} ${"x".repeat(480)}` }));
	const bounded = JSON.parse(breadcrumbsAttribute(many, scrub, 4096));
	assert.ok(JSON.stringify(bounded).length <= 4096);
	assert.ok(bounded.at(-1).message.startsWith("39 "), "newest kept");
	assert.equal(JSON.parse(breadcrumbsAttribute(many, scrub)).length <= 30, true);
	assert.equal(breadcrumbsAttribute([], scrub), undefined);
});
