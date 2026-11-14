// The root entry's browser and edge builds (index.browser.ts, index.edge.ts):
// a module that both client and server code import (an error catalog) can
// import "@autter/runtime-next" without pulling Node code into the client or
// edge bundle, and without hitting "export not found".
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as edgeSdk from "@autter/runtime-edge";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
const require = createRequire(import.meta.url);

const server = await import("../dist/index.js");
const browser = await import("../dist/index.browser.js");
const edge = await import("../dist/index.edge.js");

function exportDiff(expected, actual) {
	const want = Object.keys(expected).filter((name) => name !== "default");
	const have = Object.keys(actual).filter((name) => name !== "default");
	return {
		missing: want.filter((name) => !have.includes(name)).sort(),
		extra: have.filter((name) => !want.includes(name)).sort(),
	};
}

test("the browser and edge roots export exactly the server root's names (ESM and CJS)", () => {
	const builds = {
		"index.browser.js": browser,
		"index.edge.js": edge,
		"index.browser.cjs": require("../dist/index.browser.cjs"),
		"index.edge.cjs": require("../dist/index.edge.cjs"),
	};
	for (const [file, mod] of Object.entries(builds)) {
		const { missing, extra } = exportDiff(server, mod);
		assert.deepEqual(
			{ missing, extra },
			{ missing: [], extra: [] },
			`dist/${file} differs from the server root: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
		);
		for (const name of Object.keys(server)) {
			assert.equal(typeof mod[name], typeof server[name], `${file}: ${name} is a ${typeof mod[name]}, the server's is a ${typeof server[name]}`);
		}
	}
	// The server root is the same with CJS.
	assert.deepEqual(exportDiff(server, require("../dist/index.cjs")), { missing: [], extra: [] });
});

test("Node resolves the root to the server build, for import and require", () => {
	assert.ok(import.meta.resolve("@autter/runtime-next").endsWith("/packages/runtime-next/dist/index.js"));
	assert.ok(require.resolve("@autter/runtime-next").endsWith(join("packages", "runtime-next", "dist", "index.cjs")));
	assert.equal(require("@autter/runtime-next").registerAutter, require("../dist/index.cjs").registerAutter);
});

// A module shared by a client component and a route handler.
const SHARED_MODULE = `
import {
	RuntimeError,
	defineRuntimeErrors,
	toClientError,
	isRuntimeErrorLike,
	captureServerException,
	runtimeLogger,
	runtimeContext,
	withAutter,
} from "@autter/runtime-next";

export const orderErrors = defineRuntimeErrors("orders", {
	not_found: { status: 404, message: "No such order", expected: true },
});

export function describe(error) {
	captureServerException(error);
	runtimeLogger.info("described an error");
	runtimeContext.set({ described: true });
	return isRuntimeErrorLike(error) ? toClientError(error) : null;
}

export { RuntimeError, withAutter };
`;

// What must never reach a browser or edge bundle.
const NODE_ONLY = [
	{ what: "a node: import", pattern: /["']node:[a-z_/]+["']/ },
	{ what: "fs", pattern: /(?:require\(\s*|from\s*|import\(\s*)["']fs(?:\/promises)?["']/ },
	{ what: "@opentelemetry", pattern: /@opentelemetry/ },
	{ what: "require-in-the-middle", pattern: /require-in-the-middle/ },
	{ what: "@autter/runtime-node", pattern: /@autter\/runtime-node/ },
];

async function bundle(options) {
	const result = await build({
		stdin: { contents: SHARED_MODULE, resolveDir: PACKAGE, sourcefile: "shared-errors.js", loader: "js" },
		bundle: true,
		write: false,
		format: "esm",
		metafile: true,
		logLevel: "silent",
		...options,
	});
	const code = result.outputFiles[0].text;
	const minified = await build({ ...options, stdin: { contents: code, loader: "js" }, bundle: false, write: false, minify: true, format: "esm", logLevel: "silent" });
	return { code, inputs: Object.keys(result.metafile.inputs), bytes: code.length, minifiedBytes: minified.outputFiles[0].text.length };
}

function assertNodeFree(label, { code, inputs }) {
	for (const { what, pattern } of NODE_ONLY) {
		assert.doesNotMatch(code, pattern, `${label}: the bundle contains ${what}`);
	}
	const nodeInputs = inputs.filter((input) => /runtime-node|@opentelemetry|require-in-the-middle/.test(input));
	assert.deepEqual(nodeInputs, [], `${label}: the bundle read Node-only files`);
}

const BUNDLES = [
	// Turbopack/webpack client builds, Vite: the "browser" condition.
	{ label: "browser", options: { platform: "browser", conditions: ["browser"] }, entry: "dist/index.browser.js" },
	// Next.js edge compiles add "edge-light" (webpack keeps its "browser" default too).
	{ label: "edge-light", options: { platform: "neutral", mainFields: ["module", "main"], conditions: ["edge-light"] }, entry: "dist/index.edge.js" },
	{ label: "edge-light + browser (Next.js webpack edge)", options: { platform: "neutral", mainFields: ["module", "main"], conditions: ["edge-light", "browser"] }, entry: "dist/index.edge.js" },
	// Cloudflare Workers (wrangler: workerd, worker, browser).
	{ label: "worker", options: { platform: "neutral", mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"] }, entry: "dist/index.edge.js" },
];

for (const { label, options, entry } of BUNDLES) {
	test(`a shared module importing the root bundles for ${label} without Node code`, async (t) => {
		const result = await bundle(options);
		assert.ok(
			result.inputs.some((input) => input === entry || input.endsWith(`runtime-next/${entry}`)),
			`${label}: expected ${entry}, the bundle read ${result.inputs.join(", ")}`,
		);
		assertNodeFree(label, result);
		t.diagnostic(`${label}: ${entry}, ${result.bytes} bytes (${result.minifiedBytes} minified), inputs: ${result.inputs.join(", ")}`);
	});
}

async function captureConsole(fn) {
	const calls = { warn: [], error: [] };
	const original = { warn: console.warn, error: console.error };
	console.warn = (...args) => calls.warn.push(args.join(" "));
	console.error = (...args) => calls.error.push(args.join(" "));
	try {
		await fn();
	} finally {
		console.warn = original.warn;
		console.error = original.error;
	}
	return calls;
}

async function withNodeEnv(value, fn) {
	const before = process.env.NODE_ENV;
	process.env.NODE_ENV = value;
	try {
		return await fn();
	} finally {
		if (before === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = before;
	}
}

async function useNoOps(root) {
	root.captureServerException(new Error("x"), { a: 1 });
	root.captureServerMessage("m", "warning");
	root.reportServerOutcome("checkout", "declined");
	root.captureRequestError(new Error("x"));
	root.trackLlmCall({ provider: "openai", model: "gpt", durationMs: 1 });
	root.addBreadcrumb({ message: "clicked" });
	root.runtimeLogger.info("hello");
	root.runtimeLogger.error(new Error("x"));
	root.createRuntimeLogger({ area: "cart" }).warn("careful");
	root.runtimeContext.set({ a: 1 });
	root.runtimeContext.outcome("failed");
	root.runtimeContext.degraded(new Error("x"), "fallback");
	const safe = root.makeSafeCapture();
	safe.captureException(new Error("x"));
	safe.captureMessage("m");
	assert.equal(root.runtimeContext.id, undefined);
	assert.equal(root.runtimeContext.requestId, undefined);
	assert.equal(root.runtimeContext.carrier(), undefined);
	// Wrappers still run the app's work.
	assert.equal(await root.withRuntimeOperation("op", (op) => op.step("s", () => 41 + 1)), 42);
	assert.equal(await root.withProcessSpan("job", async () => "done"), "done");
	assert.equal(await root.runtimeContext.fork("child", () => "forked"), "forked");
	assert.equal(await root.runInBackground("bg", () => "ok"), "ok");
	assert.equal(await root.runInBackground("bg-fails", () => { throw new Error("boom"); }), undefined);
	const client = { chat: {} };
	assert.equal(root.instrumentLlmClient(client), client);
	// Plumbing and config builders.
	assert.deepEqual(await root.flushRuntimeLogs(), { ok: true, errors: [] });
	assert.deepEqual(root.runtimeLogStats(), { buffered: 0, dropped: 0 });
	for (const sink of [root.otlpSink(), root.consoleSink(), root.fileSink({ path: "x.log" })]) {
		assert.equal(typeof sink.name, "string");
		sink.write({});
	}
	for (const enricher of [root.enrichUserAgent(), root.enrichRequestSize(), root.enrichEdgeGeo(), root.enrichDeployment({})]) {
		enricher({ level: "info", message: "m", attributes: {} }, {});
	}
}

for (const [label, root] of [["browser", browser], ["edge", edge]]) {
	test(`${label} root: no-ops never throw and stay silent in production`, async () => {
		const calls = await withNodeEnv("production", () => captureConsole(() => useNoOps(root)));
		assert.deepEqual(calls, { warn: [], error: [] });
	});

	test(`${label} root: no-ops warn once per name in development`, async () => {
		const first = await withNodeEnv("development", () => captureConsole(() => useNoOps(root)));
		const warned = first.warn.join("\n");
		for (const name of ["captureServerException", "runtimeLogger.info", "runtimeContext.set", "withRuntimeOperation", "instrumentLlmClient"]) {
			assert.match(warned, new RegExp(`\\[autter\\] ${name.replace(".", "\\.")}\\(\\) did nothing`), name);
		}
		assert.match(warned, new RegExp(`resolved to its ${label} build`));
		assert.equal(new Set(first.warn).size, first.warn.length, "a name warned twice");
		// A failed background task is printed in development (it is not reported anywhere).
		assert.equal(first.error.length, 1);
		assert.match(first.error[0], /runInBackground\("bg-fails"\) failed/);
		// The second time round: nothing new.
		const second = await withNodeEnv("development", () => captureConsole(() => useNoOps(root)));
		assert.deepEqual(second.warn, []);
	});

	test(`${label} root: setup and server wrappers throw a clear server-only error`, () => {
		const where = label === "browser" ? /@autter\/runtime-next\/client/ : /@autter\/runtime-next\/edge/;
		const calls = {
			registerAutter: () => root.registerAutter({ apiKey: "k", service: "s" }),
			createAutterRelayRoute: () => root.createAutterRelayRoute({ apiKey: "k" }),
			withRuntimeRequest: () => root.withRuntimeRequest(async () => new Response("ok")),
			withAutter: () => root.withAutter(async () => new Response("ok")),
			withLlmCall: () => root.withLlmCall({ provider: "openai", model: "gpt" }, () => 1),
			emitLlmSelftestTrace: () => root.emitLlmSelftestTrace(),
			installAutterAutoFlush: () => root.installAutterAutoFlush(),
			initAutterLogging: () => root.initAutterLogging({ service: "s" }),
			autterRequests: () => root.autterRequests(),
			autterFastify: () => root.autterFastify({ addHook() {} }, {}, () => {}),
			autterErrorResponse: () => root.autterErrorResponse(),
			autterErrorHandler: () => root.autterErrorHandler(),
			autterFastifyErrors: () => root.autterFastifyErrors({ addHook() {} }),
			autterKoa: () => root.autterKoa(),
		};
		for (const [name, call] of Object.entries(calls)) {
			assert.throws(call, (error) => {
				assert.match(error.message, new RegExp(`^${name}\\(\\) is server-only`), name);
				assert.match(error.message, new RegExp(`its ${label} build`), name);
				assert.match(error.message, where, name);
				return true;
			});
		}
	});

	test(`${label} root: the coded-error helpers are the real ones`, () => {
		const errors = root.defineRuntimeErrors("orders", { not_found: { status: 404, message: "No such order", expected: true } });
		const error = errors.not_found();
		assert.ok(error instanceof root.RuntimeError);
		assert.equal(error.code, "orders.not_found");
		assert.equal(root.isRuntimeErrorLike(error), true);
		assert.deepEqual(root.toClientError(error, "req-1"), { error: { message: "No such order", code: error.code, requestId: "req-1" } });
		assert.equal(root.errorAttributes(error)["exception.type"], server.errorAttributes(error)["exception.type"]);
		assert.equal(root.CODE_PATTERN.source, server.CODE_PATTERN.source);
		assert.deepEqual(root.redactAttributes({ password: "hunter2", plan: "pro" }), server.redactAttributes({ password: "hunter2", plan: "pro" }));
		assert.equal(root.redactText("Bearer abcdefghijklmnop"), server.redactText("Bearer abcdefghijklmnop"));
	});
}

test("edge root: RuntimeError is @autter/runtime-edge's, the class @autter/runtime-next/edge checks", () => {
	assert.equal(edge.RuntimeError, edgeSdk.RuntimeError);
	assert.equal(edge.defineRuntimeErrors, edgeSdk.defineRuntimeErrors);
	assert.equal(edge.toClientError, edgeSdk.toClientError);
});
