import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fingerprintOccurrence, occurrenceFingerprint } from "./fingerprint.js";
import {
	CAUSE_V1,
	causeTypeToken,
	causeV1Fingerprint,
	frameTokenFile,
	frameTokenFunction,
	framesV3Fingerprint,
	occurrenceIdentity,
	type CauseLink,
} from "./fingerprint-v3.js";
import { STACK_FIXTURES } from "./stack-fixtures.js";
import { parseStackFrames } from "./stack-frames.js";
import type { RuntimeOccurrenceInput, StackFrame } from "./types.js";

/**
 * frames-v3 (contract §2) and cause-v1 (RF-06). The vectors are shared with
 * the platform mirror (EI-19, runtime-frames-fingerprint.ts) and
 * cross-checked at merge. An entry with `causes` also pins cause-v1: the
 * chain is the input's own exception followed by `causes`, and `cause` is
 * the expected `{ fingerprint, parts }` (null: no candidate).
 */
const vectors = JSON.parse(
	readFileSync(new URL("./fingerprint-v3-vectors.json", import.meta.url), "utf8"),
) as Array<{
	name: string;
	input: { service: string; errorType: string; message: string; frames: StackFrame[] };
	fingerprint: string;
	parts: string[];
	causes?: CauseLink[];
	cause?: { fingerprint: string; parts: string[] } | null;
}>;

function input(overrides: Partial<RuntimeOccurrenceInput> = {}): RuntimeOccurrenceInput {
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

function v3(overrides: Partial<RuntimeOccurrenceInput> = {}): string {
	const occurrence = input(overrides);
	const identity = occurrenceIdentity(occurrence, parseStackFrames(occurrence.stack));
	const candidate = identity.candidates.find((c) => c.scheme === "frames-v3");
	assert.ok(candidate, "uncoded occurrences carry a frames-v3 candidate");
	return candidate.fingerprint;
}

test("frames-v3 vectors: at least 25 cases", () => {
	assert.ok(vectors.length >= 25, `${vectors.length} vectors`);
});

for (const vector of vectors) {
	test(`frames-v3 vector: ${vector.name}`, () => {
		const result = framesV3Fingerprint(vector.input);
		assert.match(result.fingerprint, /^[0-9a-f]{32}$/);
		assert.equal(result.fingerprint, vector.fingerprint);
		assert.deepEqual(result.record, { scheme: "frames-v3", parts: vector.parts });
	});
	if (vector.causes) {
		test(`cause-v1 vector: ${vector.name}`, () => {
			const result = causeV1Fingerprint({
				service: vector.input.service,
				chain: [{ type: vector.input.errorType, frames: vector.input.frames }, ...vector.causes!],
			});
			if (vector.cause === null) {
				assert.equal(result, null);
				return;
			}
			assert.ok(result && vector.cause);
			assert.match(result.fingerprint, /^[0-9a-f]{32}$/);
			assert.equal(result.fingerprint, vector.cause.fingerprint);
			assert.deepEqual(result.record, { scheme: CAUSE_V1, parts: vector.cause.parts });
		});
	}
}

test("cause-v1 vectors: at least 8 cases, wrapped and raw forms paired", () => {
	const withCauses = vectors.filter((vector) => vector.causes);
	assert.ok(withCauses.length >= 8, `${withCauses.length} cause-v1 vectors`);
	const byName = (prefix: string) => withCauses.find((vector) => vector.name.startsWith(prefix))!.cause!.fingerprint;
	assert.equal(byName("cause-v1 js: a wrapped fetch failure"), byName("cause-v1 js: the raw fetch failure"));
	assert.equal(byName("cause-v1 jvm: the root of a Caused by chain"), byName("cause-v1 jvm: the root cause reported unwrapped"));
});

test("token rules: prefixes, short unresolved names, anonymous and file runs", () => {
	const fn = (name: string | null, resolved = false) => frameTokenFunction({ function: name, resolved });
	assert.equal(fn("async new Widget"), "Widget");
	assert.equal(fn("Object.Module.x1"), "Module.x1");
	assert.equal(fn("Module.load"), "load");
	assert.equal(fn("Xe"), "");
	assert.equal(fn("Xe", true), "Xe");
	assert.equal(fn("<anonymous>"), "");
	assert.equal(fn("Object.<anonymous>"), "");
	assert.equal(fn("anonymous"), "");
	assert.equal(fn(null), "");
	const file = (filename: string | null, module: string | null = null) => frameTokenFile({ filename, module });
	assert.equal(file("https://a.example.com/assets/index-5f3a9c1e.js?v=1#x"), "index-*.js");
	assert.equal(file("C:\\src\\App\\OrderService.cs"), "orderservice.cs");
	assert.equal(file("/static/js/2.a1b2c3d4.chunk.js"), "2.*.chunk.js");
	assert.equal(file("/x/CHECKOUTS.js"), "*.js");
	assert.equal(file("/x/Checkouts.js"), "checkouts.js");
	assert.equal(file(null, "com.acme.Billing"), "com.acme.billing");
	assert.equal(file(null, null), "");
});

// ── Stability (the regressions frames-v3 exists to fix) ─────────────────────

for (const [language, fixture] of Object.entries(STACK_FIXTURES)) {
	test(`frames-v3 survives a redeploy (line/offset drift) for ${language}`, () => {
		assert.equal(v3({ stack: fixture.primary }), v3({ stack: fixture.redeploy }));
	});

	test(`frames-v3 keeps different defects with the same message apart for ${language}`, () => {
		assert.notEqual(v3({ stack: fixture.primary }), v3({ stack: fixture.sibling }));
	});
}

test("frames-v3 survives a browser redeploy: new chunk hash, offsets and origin", () => {
	const before = [
		"TypeError: Cannot read properties of undefined (reading 'total')",
		"    at Xe (https://app.example.com/assets/index-5f3a9c1e.js:1:23456)",
		"    at HTMLButtonElement.onClick (https://app.example.com/assets/index-5f3a9c1e.js:1:9876)",
	].join("\n");
	const after = [
		"TypeError: Cannot read properties of undefined (reading 'total')",
		"    at Qt (https://my-branch.preview.example.dev/assets/index-0b9d7e21.js:1:30111)",
		"    at HTMLButtonElement.onClick (https://my-branch.preview.example.dev/assets/index-0b9d7e21.js:1:10002)",
	].join("\n");
	const browser = { source: "browser" as const, route: "/checkout" };
	assert.equal(v3({ ...browser, stack: before }), v3({ ...browser, stack: after }));
	// The legacy scheme splits on exactly this (origin + chunk hash in the hash).
	assert.notEqual(
		fingerprintOccurrence(input({ ...browser, stack: before })),
		fingerprintOccurrence(input({ ...browser, stack: after })),
	);
});

test("frames-v3 ignores the route: one component failing on two pages is one issue", () => {
	const stack = STACK_FIXTURES.node!.primary;
	assert.equal(v3({ stack, route: "/orders/42" }), v3({ stack, route: "/invoices/7" }));
	assert.notEqual(
		fingerprintOccurrence(input({ stack, route: "/orders/42" })),
		fingerprintOccurrence(input({ stack, route: "/invoices/7" })),
	);
});

test("frames-v3 ignores the source: a browser and a server report of one bug match", () => {
	const stack = STACK_FIXTURES.node!.primary;
	assert.equal(v3({ stack, source: "browser" }), v3({ stack, source: "server" }));
	assert.notEqual(
		fingerprintOccurrence(input({ stack, source: "browser" })),
		fingerprintOccurrence(input({ stack, source: "server" })),
	);
});

test("frames-v3 ignores the release and the message when frames exist", () => {
	const stack = STACK_FIXTURES.go!.primary;
	assert.equal(
		v3({ stack, release: "a1", message: "order 1 failed: timeout" }),
		v3({ stack, release: "b2", message: "a completely different message" }),
	);
});

test("python: frames-v3 groups by the crash site, not the framework entry frames", () => {
	const shared = [
		"Traceback (most recent call last):",
		'  File "/usr/local/lib/python3.12/site-packages/django/core/handlers/base.py", line 197, in _get_response',
		'  File "/app/web/views.py", line 12, in dispatch',
	];
	const a = [...shared, '  File "/app/orders/service.py", line 51, in place', "ValueError: bad"].join("\n");
	const b = [...shared, '  File "/app/billing/invoice.py", line 9, in render', "ValueError: bad"].join("\n");
	assert.notEqual(v3({ stack: a }), v3({ stack: b }));
	const identity = occurrenceIdentity(input({ stack: a }), parseStackFrames(a));
	assert.deepEqual(identity.record?.parts, ["TypeError", "place@service.py", "dispatch@views.py"]);
});

// ── Candidate list (contract §1/§4) ────────────────────────────────────────

test("uncoded occurrences carry [frames-v3, message-v1, cause-v1]; the legacy identity is unchanged", () => {
	const occurrence = input({ stack: STACK_FIXTURES.java!.primary });
	const identity = occurrenceIdentity(occurrence, parseStackFrames(occurrence.stack));
	assert.deepEqual(identity.legacy, occurrenceFingerprint(occurrence));
	// cause-v1 comes after every existing scheme (RF-06): an existing issue
	// is always found by frames-v3 or message-v1 first.
	assert.deepEqual(
		identity.candidates.map((c) => c.scheme),
		["frames-v3", "message-v1", "cause-v1"],
	);
	assert.equal(identity.candidates[1]!.fingerprint, fingerprintOccurrence(occurrence));
	for (const candidate of identity.candidates) assert.match(candidate.fingerprint, /^[0-9a-f]{32}$/);
	assert.equal(identity.record?.scheme, "frames-v3");
	// The JVM fixture is wrapped: its root cause's frame, class name only.
	assert.deepEqual(identity.causeRecord, { scheme: "cause-v1", parts: ["IllegalStateException", "require@orderloader.java"] });
	// No in-app frame anywhere: no cause-v1, and the legacy one is last again.
	const vendored = input({ stack: "TypeError: x\n    at f (/app/node_modules/lib/index.js:1:2)" });
	const plain = occurrenceIdentity(vendored, parseStackFrames(vendored.stack));
	assert.deepEqual(plain.candidates.map((c) => c.scheme), ["frames-v3", "message-v1"]);
	assert.equal(plain.causeRecord, null);
});

test("coded occurrences carry [code-v1] only: the explicit scheme is the legacy one", () => {
	const occurrence = input({ errorCode: "billing.declined", service: "payments-api" });
	const identity = occurrenceIdentity(occurrence, []);
	assert.deepEqual(identity.candidates, [
		{ scheme: "code-v1", fingerprint: "1692d304df5e4edbd3a0bbac5d7658bb" },
	]);
	assert.equal(identity.legacy.scheme, "code-v1");
	assert.equal(identity.record, null);
	assert.equal(identity.causeRecord, null);
});

// ── cause-v1: a wrapped error groups with its root cause (RF-06) ───────────

function cause(occurrence: RuntimeOccurrenceInput, causes?: CauseLink[]): string | undefined {
	const identity = occurrenceIdentity(occurrence, parseStackFrames(occurrence.stack), causes);
	return identity.candidates.find((c) => c.scheme === "cause-v1")?.fingerprint;
}

const RAW_FETCH = [
	"TypeError: fetch failed",
	"    at node:internal/deps/undici/undici:13502:13",
	"    at async fetchCart (/app/src/cart.ts:8:3)",
	"    at async checkout (/app/src/checkout.ts:12:5)",
].join("\n");
const WRAPPER = [
	"Error: checkout failed",
	"    at checkout (/app/src/checkout.ts:14:11)",
	"    at async handle (/app/src/routes.ts:30:5)",
].join("\n");

test("cause-v1 js: a wrapped fetch failure and its raw form are one identity (the plan's done-when)", () => {
	const raw = input({ errorType: "TypeError", message: "fetch failed", stack: RAW_FETCH });
	const wrapped = input({
		errorType: "Error",
		message: "checkout failed",
		stack: WRAPPER,
		attributes: {
			"exception.cause.1.type": "TypeError",
			"exception.cause.1.message": "fetch failed",
			"exception.cause.1.stacktrace": RAW_FETCH,
		},
	});
	assert.ok(cause(raw));
	assert.equal(cause(wrapped), cause(raw));
	// frames-v3 still tells them apart, so existing issues never merge by it.
	assert.notEqual(v3({ ...wrapped }), v3({ ...raw }));
	// Wrapped twice: still the root's.
	const twice = input({
		errorType: "Error",
		message: "request failed",
		stack: "Error: request failed\n    at handle (/app/src/routes.ts:31:9)",
		attributes: {
			"exception.cause.1.type": "Error",
			"exception.cause.1.stacktrace": WRAPPER,
			"exception.cause.2.type": "TypeError",
			"exception.cause.2.stacktrace": RAW_FETCH,
		},
	});
	assert.equal(cause(twice), cause(raw));
	// Another root type at the same frame is another identity.
	assert.notEqual(cause(input({ ...raw, errorType: "RangeError" })), cause(raw));
});

test("cause-v1 js: without cause stacks (older SDKs), a failure wrapped where it was called still groups", () => {
	const direct = RAW_FETCH.replace("    at async fetchCart (/app/src/cart.ts:8:3)\n", "");
	const raw = input({ errorType: "TypeError", message: "fetch failed", stack: direct });
	const wrapped = input({ errorType: "Error", message: "checkout failed", stack: WRAPPER, attributes: { "exception.cause.1.type": "TypeError" } });
	assert.equal(cause(wrapped), cause(raw));
});

test("cause-v1 uses the causes it is given (symbolicated at ingest) over the stack text", () => {
	const wrapped = input({ errorType: "Error", stack: WRAPPER, attributes: { "exception.cause.1.type": "TypeError", "exception.cause.1.stacktrace": RAW_FETCH } });
	const resolved: CauseLink[] = [{
		type: "TypeError",
		frames: [{ function: "loadCart", module: null, filename: "webpack://shop/./src/cart.ts", lineno: 8, colno: 3, inApp: true, resolved: true }],
	}];
	const identity = occurrenceIdentity(wrapped, parseStackFrames(wrapped.stack), resolved);
	assert.deepEqual(identity.causeRecord?.parts, ["TypeError", "loadCart@cart.ts"]);
});

test("cause-v1 jvm, python and .NET: a chained exception groups with its root reported alone", () => {
	// JVM: the last top-level "Caused by:" is the root.
	const jvmRoot = input({
		errorType: "java.lang.IllegalStateException",
		message: "order not loaded",
		stack: "java.lang.IllegalStateException: order not loaded\n\tat com.example.orders.OrderLoader.require(OrderLoader.java:57)\n\tat com.example.orders.OrderService.load(OrderService.java:20)",
	});
	assert.equal(cause(input({ errorType: "java.lang.NullPointerException", stack: STACK_FIXTURES.java!.primary })), cause(jvmRoot));
	// Python: the first traceback block is the root; OTel reports the short class name.
	const chained = [
		"Traceback (most recent call last):",
		'  File "/app/db/pool.py", line 30, in acquire',
		"    conn = self._connect()",
		"TimeoutError: pool exhausted",
		"",
		"The above exception was the direct cause of the following exception:",
		"",
		"Traceback (most recent call last):",
		'  File "/app/orders/service.py", line 51, in place',
		"    raise OrderError('could not place order') from err",
		"orders.errors.OrderError: could not place order",
	].join("\n");
	const pyRoot = input({
		errorType: "TimeoutError",
		message: "pool exhausted",
		stack: ["Traceback (most recent call last):", '  File "/app/db/pool.py", line 31, in acquire', "TimeoutError: pool exhausted"].join("\n"),
	});
	assert.equal(cause(input({ errorType: "OrderError", stack: chained })), cause(pyRoot));
	// .NET: the innermost exception (first frame segment) is the root.
	const wrapped = [
		"System.InvalidOperationException: Checkout failed",
		" ---> System.ArgumentNullException: Value cannot be null. (Parameter 'cart')",
		"   at Shop.Cart.Total(Cart cart) in /src/Shop/Cart.cs:line 14",
		"   --- End of inner exception stack trace ---",
		"   at Shop.Checkout.Submit(Order order) in /src/Shop/Checkout.cs:line 61",
	].join("\n");
	const dotnetRoot = input({
		errorType: "System.ArgumentNullException",
		stack: "System.ArgumentNullException: Value cannot be null. (Parameter 'cart')\n   at Shop.Cart.Total(Cart cart) in /src/Shop/Cart.cs:line 16",
	});
	assert.equal(cause(input({ errorType: "System.InvalidOperationException", stack: wrapped })), cause(dotnetRoot));
});

test("cause-v1 type tokens drop the package or namespace", () => {
	assert.equal(causeTypeToken("java.lang.IllegalStateException"), "IllegalStateException");
	assert.equal(causeTypeToken("System.Net.Sockets.SocketException"), "SocketException");
	assert.equal(causeTypeToken("requests.exceptions.ConnectionError"), "ConnectionError");
	assert.equal(causeTypeToken("ActiveRecord::RecordNotFound"), "RecordNotFound");
	assert.equal(causeTypeToken(" TypeError "), "TypeError");
	assert.equal(causeTypeToken(""), "");
});

test("a stackless error hashes its normalised message under frames-v3", () => {
	assert.equal(v3({ message: "user 42 not found" }), v3({ message: "user 7 not found" }));
	assert.notEqual(v3({ message: "user 42 not found" }), v3({ message: "cart 42 is empty" }));
});
