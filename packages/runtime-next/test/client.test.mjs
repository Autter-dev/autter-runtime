import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as breadcrumbs from "@autter/runtime-browser/breadcrumbs";
import * as tracing from "@autter/runtime-browser/tracing";
import * as filters from "@autter/runtime-browser/filters";
import * as client from "../dist/client.js";

test("the client entry's trace propagation switches drive @autter/runtime-browser/tracing", () => {
	// Thin wrappers (they remember that the app chose, so initAutterBrowser's
	// default keeps that choice) over the tracing module, which hooks into the
	// same tracker instance initAutterBrowser starts. Breadcrumbs are the very
	// functions.
	assert.equal(client.enableBreadcrumbs, breadcrumbs.enableBreadcrumbs);
	assert.equal(typeof tracing.enableTracePropagation, "function");
	// Callable without a browser (no XMLHttpRequest here): a no-op wrap.
	client.enableTracePropagation({ tracePropagationTargets: ["https://api.example.com", /^https:\/\/internal\./] });
	client.disableTracePropagation();
});

test("initAutterBrowser outside a browser (server rendering a client component) does nothing and never throws", () => {
	assert.equal(typeof globalThis.window, "undefined");
	client.initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web" });
	client.initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", tracePropagation: false });
	assert.equal(typeof globalThis.XMLHttpRequest, "undefined", "nothing was wrapped or defined");
});

test("the client entry's types include the trace propagation options, for ESM and CJS", () => {
	for (const file of ["client.d.ts", "client.d.cts"]) {
		const types = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
		assert.match(types, /enableTracePropagation/);
		assert.match(types, /disableTracePropagation/);
		assert.match(types, /TracePropagationOptions/);
		assert.match(types, /AutterNextBrowserOptions/);
		assert.match(types, /tracePropagation\?: boolean/);
		assert.match(types, /tracePropagationTargets\?:/);
	}
	// The bundle imports the tracing subpath (it is on by default here), so
	// the app's bundler resolves the same module instance the tracker uses.
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
