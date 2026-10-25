// RF-06 / RF-05: cause stacks and the debug ids of the bundles in an
// exception's stacks, on occurrence records only.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEBUG_IDS_ATTRIBUTE,
	RuntimeError,
	boundContext,
	debugIdsForStacks,
	errorAttributes,
	firstFramePath,
	stackAttributesLast,
} from "../dist/index.js";

const ID = "4f3c6a1e-9b2d-4e8f-a1b2-c3d4e5f60718";
const OTHER = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";

/** Run with a debug id registry, as injected bundles leave it. */
function withRegistry(t, registry) {
	const saved = globalThis._autterDebugIds;
	globalThis._autterDebugIds = registry;
	t.after(() => {
		if (saved === undefined) delete globalThis._autterDebugIds;
		else globalThis._autterDebugIds = saved;
	});
}

test("each cause's stack becomes exception.cause.N.stacktrace; summaries leave them out", () => {
	const root = new TypeError("fetch failed");
	root.stack = "TypeError: fetch failed\n    at async checkout (/app/dist/server.js:10:5)";
	const err = new Error("checkout failed", { cause: root });
	const attrs = errorAttributes(err);
	assert.equal(attrs["exception.cause.1.type"], "TypeError");
	assert.equal(attrs["exception.cause.1.stacktrace"], root.stack);
	// A non-Error cause has no stack.
	assert.equal(errorAttributes(new RuntimeError({ message: "x", cause: "just a string" }))["exception.cause.1.stacktrace"], undefined);
	assert.equal(errorAttributes(err, { stacks: false })["exception.cause.1.stacktrace"], undefined);
	assert.equal(errorAttributes(err, { stacks: false })["exception.cause.1.type"], "TypeError");
	assert.equal(errorAttributes(err, { causes: false })["exception.cause.1.stacktrace"], undefined);
	// Nothing injected: no debug ids.
	assert.equal(DEBUG_IDS_ATTRIBUTE in attrs, false);
});

test("autter.debug_ids names the injected bundles in the error's and its causes' stacks", (t) => {
	withRegistry(t, {
		"Error\n    at Object.<anonymous> (/app/dist/server.js:1:60)\n    at Module._compile (node:internal/modules/cjs/loader:1554:14)": ID,
		"Error\n    at file:///app/dist/worker.mjs:1:60": OTHER,
		"Error\n    at Object.<anonymous> (/app/dist/unused.js:1:60)": "c0ffee00-0000-4000-8000-000000000003",
	});
	const root = new TypeError("fetch failed");
	root.stack = "TypeError: fetch failed\n    at load (file:///app/dist/worker.mjs:3:9)";
	const err = new Error("checkout failed", { cause: root });
	err.stack = "Error: checkout failed\n    at checkout (/app/dist/server.js:12:11)";
	const ids = JSON.parse(String(errorAttributes(err)[DEBUG_IDS_ATTRIBUTE]));
	assert.deepEqual(ids, { "/app/dist/server.js": ID, "file:///app/dist/worker.mjs": OTHER });
	assert.equal(DEBUG_IDS_ATTRIBUTE in errorAttributes(err, { stacks: false }), false);
	// A hostile or empty registry never throws and adds nothing.
	globalThis._autterDebugIds = { get boom() { throw new Error("x"); } };
	assert.equal(debugIdsForStacks([err.stack]), undefined);
	globalThis._autterDebugIds = 42;
	assert.equal(debugIdsForStacks([err.stack]), undefined);
});

test("the first frame's script path, as stacks write it", () => {
	assert.equal(firstFramePath("Error\n    at Object.<anonymous> (/app/dist/server.js:1:60)"), "/app/dist/server.js");
	assert.equal(firstFramePath("Error\n    at file:///app/dist/index.mjs:1:60"), "file:///app/dist/index.mjs");
	assert.equal(firstFramePath("Error\n    at index.js:1:60"), "index.js");
	assert.equal(firstFramePath("Error\n    at Object.<anonymous> (C:\\app\\dist\\index.js:1:60)"), "C:\\app\\dist\\index.js");
	assert.equal(firstFramePath("Error\n    at Object.<anonymous> (/var/task/.next/server/app/(shop)/page.js:1:60)"), "/var/task/.next/server/app/(shop)/page.js");
	assert.equal(firstFramePath("@https://app.example.com/assets/index-abc.js:1:60"), "https://app.example.com/assets/index-abc.js");
	assert.equal(firstFramePath("Error: no frames"), null);
});

test("stackAttributesLast keeps every value and moves cause stacks and debug ids to the end", () => {
	const ordered = stackAttributesLast({
		"exception.cause.1.stacktrace": "s1",
		[DEBUG_IDS_ATTRIBUTE]: "{}",
		"autter.capture.mode": "log",
		"exception.stacktrace": "main",
		"exception.cause.1.type": "TypeError",
	});
	assert.deepEqual(Object.keys(ordered), [
		"autter.capture.mode",
		"exception.stacktrace",
		"exception.cause.1.type",
		"exception.cause.1.stacktrace",
		DEBUG_IDS_ATTRIBUTE,
	]);
	// In a bounded context the main stack is kept whole before a cause stack is cut.
	const big = "x".repeat(20_000);
	const bounded = boundContext(stackAttributesLast({ "exception.cause.1.stacktrace": big, "exception.stacktrace": "main stack" }));
	assert.equal(bounded["exception.stacktrace"], "main stack");
	assert.ok(String(bounded["exception.cause.1.stacktrace"]).length < big.length);
});
