// Two copies of the SDK in one process — what Next.js does when it bundles
// @autter/runtime-node into `instrumentation.ts` and again into each route.
// The copy `registerAutter` starts (here: A, the package's own dist) and a
// copy that is never started (B, the same dist copied to another directory,
// so Node loads it as separate modules) must behave as ONE SDK: B's request
// summaries and logs are exported by A's sinks, an error B reports is not
// reported again by A, and nothing falls back to the console.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
// Inside dist/ (git-ignored, removed by every build) so the copy resolves the
// package's dependencies exactly like the original.
const copyDir = join(dist, `.copy-${process.pid}`);
const KEY = Symbol.for("@autter/runtime-node");

/** Each POST the stub ingester received: { path, body }. */
const received = [];
let collector;
let endpoint;
let A;
let B;

before(async () => {
	mkdirSync(copyDir, { recursive: true });
	for (const file of readdirSync(dist)) {
		if (file.endsWith(".js") || file.endsWith(".cjs")) copyFileSync(join(dist, file), join(copyDir, file));
	}
	collector = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			try {
				received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
			} catch {
				/* metrics may be protobuf-free JSON too; ignore anything else */
			}
			res.setHeader("content-type", "application/json");
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	endpoint = `http://127.0.0.1:${collector.address().port}`;
	A = await import("../dist/index.js");
	B = await import(pathToFileURL(join(copyDir, "index.js")).href);
});

after(async () => {
	rmSync(copyDir, { recursive: true, force: true });
	await new Promise((resolve) => {
		collector.close(resolve);
		collector.closeAllConnections();
	});
});

const value = (v) => v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? (v ? JSON.stringify(v) : undefined);
const attrs = (list = []) => Object.fromEntries(list.map((a) => [a.key, value(a.value)]));

function logRecords() {
	const out = [];
	for (const { path, body } of received) {
		if (path !== "/v1/logs") continue;
		for (const rl of body.resourceLogs ?? [])
			for (const sl of rl.scopeLogs ?? [])
				for (const r of sl.logRecords ?? []) out.push({ body: value(r.body), attributes: attrs(r.attributes) });
	}
	return out;
}

function exceptionEvents() {
	const out = [];
	for (const { path, body } of received) {
		if (path !== "/v1/traces") continue;
		for (const rs of body.resourceSpans ?? [])
			for (const ss of rs.scopeSpans ?? [])
				for (const span of ss.spans ?? [])
					for (const event of span.events ?? [])
						if (event.name === "exception") out.push({ span: attrs(span.attributes), event: attrs(event.attributes) });
	}
	return out;
}

/** Collect console output (the logger's fallback sink uses console.log). */
function watchConsole() {
	const lines = [];
	const saved = {};
	for (const method of ["log", "info", "warn", "error"]) {
		saved[method] = console[method];
		console[method] = (...args) => lines.push(args.map(String).join(" "));
	}
	return {
		lines,
		stop: () => Object.assign(console, saved),
	};
}

test("a copy that was never started reports through the copy that was", async () => {
	assert.notEqual(A.runtimeLogger, B.runtimeLogger, "the two copies must be separate module instances");
	assert.notEqual(A.withRuntimeRequest, B.withRuntimeRequest);

	// Nothing started: today's behaviour, records go to the console.
	let output = watchConsole();
	try {
		B.runtimeLogger.warn("before start");
	} finally {
		output.stop();
	}
	assert.ok(output.lines.some((line) => line.includes("before start")), "unstarted copy should print to the console");

	const sdk = A.initAutterServer({
		apiKey: "test-key",
		service: "shared-state",
		endpoint,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		metricIntervalMs: 3_600_000,
		// Any console line below can then only come from a fallback sink.
		logging: { console: false },
	});
	assert.equal(B.initAutterServer({ apiKey: "other", service: "ignored" }), sdk, "a second init in another copy returns the started SDK");

	output = watchConsole();
	const routeError = new Error("route boom");
	const capturedError = new Error("captured in route");
	// Next hands errors from its edge sandbox (another realm) to onRequestError.
	const foreignError = vm.runInNewContext("new Error('edge sandbox boom')");
	assert.equal(foreignError instanceof Error, false);
	try {
		// A route handler wrapped by the route's copy, which throws.
		const thrower = B.withRuntimeRequest(
			async () => {
				B.runtimeLogger.info("loading order");
				B.runtimeLogger.warn("route warning");
				throw routeError;
			},
			{ name: "wrapped" },
		);
		await assert.rejects(thrower(new Request("http://localhost/api/wrapped")), /route boom/);
		// Next then calls onRequestError, which runs in instrumentation's copy.
		A.captureRequestError(routeError, { "next.route_path": "/api/wrapped" });

		// captureServerException (runtime-node's captureException) in a route.
		const capturer = B.withRuntimeRequest(
			async () => {
				B.captureException(capturedError, { step: "charge" });
				return new Response("failed", { status: 500 });
			},
			{ name: "captured" },
		);
		assert.equal((await capturer(new Request("http://localhost/api/captured"))).status, 500);
		A.captureRequestError(capturedError);

		const foreign = B.withRuntimeRequest(async () => {
			throw foreignError;
		}, { name: "foreign" });
		await assert.rejects(foreign(new Request("http://localhost/api/foreign")));
		A.captureRequestError(foreignError, { "next.route_path": "/api/foreign" });

		// The other direction: a request the started copy runs, logged from the route copy.
		await A.withRuntimeOperation("job", async () => {
			B.runtimeContext.set({ batch: 7 });
			B.runtimeLogger.warn("job warning");
		});
	} finally {
		output.stop();
	}
	await sdk.shutdown();

	assert.deepEqual(output.lines, [], "nothing may fall back to the console while a copy is started");

	const records = logRecords();
	const summaries = (name) => records.filter((r) => r.attributes["autter.operation.name"] === name && r.attributes["autter.event.type"] === "operation");
	for (const name of ["GET wrapped", "GET captured", "GET foreign"]) {
		assert.equal(summaries(name).length, 1, `one exported summary for ${name}`);
	}
	const wrapped = summaries("GET wrapped")[0].attributes;
	assert.equal(wrapped["autter.operation.outcome"], "failed");
	assert.match(String(wrapped["autter.operation.logs"] ?? ""), /loading order/, "info folded into the route's summary");
	assert.ok(records.some((r) => r.body === "route warning"), "the route's warning is exported");
	assert.equal(summaries("GET captured")[0].attributes["autter.operation.outcome"], "failed");
	const job = summaries("job")[0]?.attributes;
	assert.ok(job, "operation summary exported");
	assert.equal(Number(job.batch), 7, "context set from the route copy lands on the started copy's operation");
	assert.ok(records.some((r) => r.body === "job warning" && r.attributes["autter.operation.name"] === "job"),
		"the route copy's record joins the started copy's operation");

	const exceptions = exceptionEvents();
	const count = (message) => exceptions.filter((e) => e.event["exception.message"] === message).length;
	assert.equal(count("route boom"), 1, "a thrown route error is reported once");
	assert.equal(count("captured in route"), 1, "a captured route error is reported once");
	assert.equal(count("edge sandbox boom"), 1, "an error from another realm is reported once");
	const boom = exceptions.find((e) => e.event["exception.message"] === "route boom");
	assert.equal(boom.span["autter.request.id"], wrapped["autter.request.id"], "the report carries the route's request id");
	assert.match(String(boom.event["exception.stacktrace"]), /route boom/);

	// Shutdown cleared the shared state: every copy is "not started" again.
	const state = globalThis[KEY];
	assert.equal(state.v, 1);
	assert.equal(state.server.active, null);
	assert.equal(state.logger.config, null);
	assert.deepEqual(state.logger.sinks, []);
	output = watchConsole();
	try {
		B.runtimeLogger.warn("after shutdown");
	} finally {
		output.stop();
	}
	assert.ok(output.lines.some((line) => line.includes("after shutdown")), "back to the console after shutdown");
});

test("the ESM and CJS builds share one SDK too", async () => {
	const require = createRequire(import.meta.url);
	const cjs = require("../dist/index.cjs");
	const { captureRuntime } = await import("../dist/testing.js");
	assert.notEqual(cjs.runtimeLogger, A.runtimeLogger);
	const runtime = captureRuntime();
	try {
		const error = new Error("dual package boom");
		const handler = cjs.withRuntimeRequest(async () => {
			cjs.runtimeLogger.warn("from cjs");
			throw error;
		}, { name: "dual" });
		await assert.rejects(handler(new Request("http://localhost/dual")));
		A.captureRequestError(error);
		assert.equal(runtime.operations.filter((e) => e.attributes["autter.operation.name"] === "GET dual").length, 1);
		assert.ok(runtime.logs.some((e) => e.message === "from cjs"), "the CJS copy writes to the ESM copy's test sink");
		assert.equal(runtime.exceptions.filter((e) => e.error === error).length, 1, "reported once across the two builds");
	} finally {
		runtime.stop();
	}
});

/** Run `code` (an ES module) in a fresh process; returns its stdout as JSON. */
function child(code) {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
		cwd: join(here, ".."),
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("a copy that finds another layout of the shared object keeps private state", () => {
	const out = child(`
		const KEY = Symbol.for("@autter/runtime-node");
		const foreign = { v: 99, sdk: "9.0.0", server: { active: "not an sdk" } };
		Object.defineProperty(globalThis, KEY, { value: foreign, configurable: true });
		const sdk = await import("./dist/index.js");
		const { captureRuntime } = await import("./dist/testing.js");
		const runtime = captureRuntime();
		const handler = sdk.withRuntimeRequest(async () => new Response("ok"), { name: "private" });
		await handler(new Request("http://localhost/private"));
		const error = new Error("private boom");
		sdk.captureException(error);
		sdk.captureRequestError(error);
		console.log(JSON.stringify({
			untouched: JSON.stringify(Object.keys(foreign)) === JSON.stringify(["v", "sdk", "server"]) && foreign.server.active === "not an sdk",
			same: globalThis[KEY] === foreign,
			summaries: runtime.operations.length,
			exceptions: runtime.exceptions.length,
		}));
	`);
	assert.deepEqual(out, { untouched: true, same: true, summaries: 1, exceptions: 1 });
});

test("a newer copy fills in what an older copy of the same layout did not create", () => {
	const out = child(`
		import { AsyncLocalStorage } from "node:async_hooks";
		const KEY = Symbol.for("@autter/runtime-node");
		// An older copy: fewer slots and fields, but the same layout.
		const local = new AsyncLocalStorage();
		const captured = new WeakSet();
		const marked = new Error("reported by the older copy");
		captured.add(marked);
		const older = { v: 1, sdk: "1.6.1", logger: { local, config: null, sinks: [] }, requests: { captured } };
		Object.defineProperty(globalThis, KEY, { value: older, configurable: true });
		const sdk = await import("./dist/index.js");
		const { captureRuntime } = await import("./dist/testing.js");
		const runtime = captureRuntime();
		sdk.captureRequestError(marked);
		let seen;
		await local.run({ id: "op-1", name: "older", kind: "operation", attributes: {}, steps: [], inline: { logs: [], level: "debug" }, startedAt: Date.now(), outcome: "succeeded" }, async () => {
			seen = sdk.runtimeContext.id;
		});
		console.log(JSON.stringify({
			reusedStore: older.logger.local === local,
			reusedMarks: older.requests.captured === captured,
			filled: older.logger.extraSinks instanceof Set && typeof older.server === "object" && typeof older.breadcrumbs === "object",
			skipped: runtime.exceptions.length === 0,
			seen,
		}));
	`);
	assert.deepEqual(out, { reusedStore: true, reusedMarks: true, filled: true, skipped: true, seen: "op-1" });
});
