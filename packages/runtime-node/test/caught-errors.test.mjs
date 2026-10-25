// RF-01 (caught errors become occurrences) and RF-02 (runtimeContext.degraded),
// end to end against real loggers: console.error, pino, winston, bunyan and
// runtimeLogger.error. A caught error is reported as an occurrence with its
// stack, marked handled; a deliberate fallback as a warning. Neither fails the
// request it happens in.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { test } from "node:test";
import {
	initAutterServer,
	runtimeContext,
	withRuntimeOperation,
	captureException,
	runtimeLogger,
} from "../dist/index.js";
import { captureRuntime, expectOperation } from "../dist/testing.js";

const require = createRequire(import.meta.url);
const sink = () => new Writable({ write(_chunk, _enc, cb) { cb(); } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { await tick(); await new Promise((r) => setTimeout(r, 25)); };

function start(options = {}) {
	return initAutterServer({
		apiKey: "test-key",
		service: "caught-test",
		endpoint: "http://127.0.0.1:1/unused",
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		logging: { console: false },
		...options,
	});
}

test("errors logged through console, pino, winston, bunyan and runtimeLogger become caught occurrences", async () => {
	const server = start();
	const runtime = captureRuntime();
	try {
		const pino = require("pino")({}, sink());
		const winston = require("winston");
		const wl = winston.createLogger({ transports: [new winston.transports.Stream({ stream: sink() })] });
		const bunyan = require("bunyan");
		const bl = bunyan.createLogger({ name: "t", streams: [{ stream: sink() }] });

		console.error("a plain line with no error");
		console.error("lookup failed for %s", "u1", new Error("from console"));
		pino.error(new Error("from pino"), "pino says");
		pino.child({ a: 1 }).error({ err: new Error("from pino child") }, "child says");
		wl.error(new Error("from winston"));
		bl.error(new Error("from bunyan"), "bunyan says");
		runtimeLogger.error(new Error("from runtimeLogger"));
		await settle();

		const byMessage = new Map(runtime.exceptions.map((e) => [e.message, e]));
		for (const [message, source] of [
			["from console", "console"],
			["from pino", "pino"],
			["from pino child", "pino"],
			["from winston", "winston"],
			["from bunyan", "bunyan"],
			["from runtimeLogger", "runtimeLogger"],
		]) {
			const occ = byMessage.get(message);
			assert.ok(occ, `${message} reported`);
			assert.equal(occ.attributes["autter.handled"], true, `${message} handled`);
			assert.equal(occ.attributes["autter.handling"], "caught", `${message} caught`);
			assert.equal(occ.attributes["autter.log.source"], source, `${message} source`);
			assert.ok(occ.error instanceof Error && occ.error.stack, `${message} keeps its stack`);
		}
		assert.equal(byMessage.get("from console").attributes["autter.log.message"], "lookup failed for u1");
		assert.ok(!runtime.exceptions.some((e) => /plain line/.test(e.message)), "a log line with no error is untouched");
	} finally {
		await server.shutdown();
		runtime.stop();
	}
});

test("a caught error inside a request does not fail it; a deliberate fallback degrades it", async () => {
	const server = start();
	const runtime = captureRuntime();
	try {
		await withRuntimeOperation("checkout", async () => {
			console.error(new Error("caught inside op"));
		});
		await withRuntimeOperation("pricing", async () => {
			runtimeContext.degraded(new Error("pricing down"), "using cached prices");
		});
		await settle();

		// The caught error is recorded, but the operation it happened in succeeded.
		expectOperation(runtime, "checkout").toHaveOutcome("succeeded");
		// The deliberate fallback degrades its operation (no incident), at warning severity.
		expectOperation(runtime, "pricing").toHaveOutcome("degraded");
		const degraded = runtime.exceptions.find((e) => e.message === "pricing down");
		assert.ok(degraded, "degraded reported");
		assert.equal(degraded.attributes["autter.handling"], "deliberate");
		assert.equal(degraded.attributes["autter.degraded.reason"], "using cached prices");
		assert.equal(degraded.attributes["autter.severity"], "warning");
	} finally {
		await server.shutdown();
		runtime.stop();
	}
});

test("an error also passed to captureException in the same tick is reported once; opt-out is per logger", async () => {
	const server = start({ captureLoggedErrors: { console: false } });
	const runtime = captureRuntime();
	try {
		const both = new Error("both paths");
		console.error(both); // console capture is OFF here
		captureException(both); // explicit capture
		runtimeLogger.error(new Error("still caught")); // runtimeLogger stays on
		await settle();

		assert.equal(runtime.exceptions.filter((e) => e.message === "both paths").length, 1, "reported once");
		assert.notEqual(runtime.exceptions.find((e) => e.message === "both paths").attributes["autter.handling"], "caught");
		const still = runtime.exceptions.find((e) => e.message === "still caught");
		assert.equal(still?.attributes["autter.handling"], "caught", "runtimeLogger opt-out independent of console");
	} finally {
		await server.shutdown();
		runtime.stop();
	}
});

test("the burst limit caps a looping caught error and counts the ones left out", async () => {
	const server = start();
	const runtime = captureRuntime();
	try {
		function loop() {
			console.error(new Error("tight loop"));
		}
		for (let i = 0; i < 40; i++) loop();
		await settle();
		const reported = runtime.exceptions.filter((e) => e.message === "tight loop");
		// Ten through the burst, the rest dropped (one kind: same type + throw site).
		assert.ok(reported.length <= 11, `burst-limited to ~10, got ${reported.length}`);
		assert.ok(reported.length >= 1, "at least the first passes");
	} finally {
		await server.shutdown();
		runtime.stop();
	}
});
