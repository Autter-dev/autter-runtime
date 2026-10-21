import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as breadcrumbs from "@autter/runtime-browser/breadcrumbs";
import * as tracing from "@autter/runtime-browser/tracing";
import * as filters from "@autter/runtime-browser/filters";
import * as client from "../dist/client.js";

test("the client entry re-exports opt-in trace propagation, like breadcrumbs", () => {
	// The very functions of @autter/runtime-browser/tracing, so they hook into
	// the same tracker instance initAutterBrowser starts.
	assert.equal(client.enableTracePropagation, tracing.enableTracePropagation);
	assert.equal(client.disableTracePropagation, tracing.disableTracePropagation);
	assert.equal(client.enableBreadcrumbs, breadcrumbs.enableBreadcrumbs);
	// Callable without a browser (no XMLHttpRequest here): a no-op wrap.
	client.enableTracePropagation({ tracePropagationTargets: ["https://api.example.com", /^https:\/\/internal\./] });
	client.disableTracePropagation();
});

test("the client entry's types include TracePropagationOptions, for ESM and CJS", () => {
	for (const file of ["client.d.ts", "client.d.cts"]) {
		const types = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
		assert.match(types, /enableTracePropagation/);
		assert.match(types, /disableTracePropagation/);
		assert.match(types, /TracePropagationOptions/);
	}
	// The bundle keeps the subpath import, so the tracing code stays out of
	// apps that never call it.
	assert.match(readFileSync(new URL("../dist/client.js", import.meta.url), "utf8"), /@autter\/runtime-browser\/tracing/);
});

test("the client entry re-exports the opt-in filters (sampleRate, ignoreErrors, denyUrls)", () => {
	assert.equal(client.withFilters, filters.withFilters);
	assert.equal(client.createFilter, filters.createFilter);
	const options = client.withFilters({ endpoint: "/api/autter-runtime", service: "web", sampleRate: 0, ignoreErrors: ["x"] });
	assert.equal(typeof options.beforeSend, "function");
	assert.equal(options.beforeSend({ type: "exception", timestamp: "t", message: "y", severity: "error" }), null);
	for (const file of ["client.d.ts", "client.d.cts"]) {
		assert.match(readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8"), /AutterFilterOptions/);
	}
	assert.match(readFileSync(new URL("../dist/client.js", import.meta.url), "utf8"), /@autter\/runtime-browser\/filters/);
});
