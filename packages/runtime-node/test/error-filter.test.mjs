import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { captureException, captureMessage, initAutterLogging, initAutterServer, reportOutcome } from "../dist/index.js";

/** `ignoreErrors` and `sampleRate` (EI-38): what the SDK never reports. */

async function collector() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			requests.push({ path: req.url, body: body ? JSON.parse(body) : null });
			res.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const spans = () =>
		requests
			.filter((r) => r.path === "/v1/traces")
			.flatMap((r) => r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
	const value = (v) => v.stringValue ?? v.intValue ?? v.boolValue;
	return {
		endpoint: `http://127.0.0.1:${server.address().port}`,
		/** Messages of every exception / outcome event exported. */
		reported: () =>
			spans().flatMap((span) =>
				(span.events ?? []).flatMap((event) => {
					const attributes = Object.fromEntries((event.attributes ?? []).map((a) => [a.key, value(a.value)]));
					if (event.name === "exception") return [attributes["exception.message"]];
					if (event.name === "autter.outcome") return [`outcome:${attributes["autter.outcome.name"]}`];
					return [];
				}),
			),
		logRecords: () =>
			requests
				.filter((r) => r.path === "/v1/logs")
				.flatMap((r) => r.body.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords))),
		close: () =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	};
}

const base = (endpoint) => ({
	service: "api",
	apiKey: "k",
	endpoint,
	autoFlush: false,
	memoryMetrics: false,
	compatCheck: false,
	logging: { console: false },
});

test("ignoreErrors drops matching errors by type or message on every capture path", async () => {
	const c = await collector();
	const sdk = initAutterServer({
		...base(c.endpoint),
		captureGlobalErrors: false,
		ignoreErrors: ["ResizeObserver loop", /^AbortError$/, /checkout\.declined/],
	});
	try {
		captureException(new Error("ResizeObserver loop limit exceeded"));
		const abort = new Error("The operation was aborted");
		abort.name = "AbortError";
		captureException(abort);
		captureException(new TypeError("x is not a function"));
		captureMessage("ResizeObserver loop again", "error");
		captureMessage("kept warning", "warning");
		reportOutcome("checkout.declined", "card declined");
		reportOutcome("checkout.failed", "gateway down");
		await sdk.shutdown();
		assert.deepEqual(c.reported().sort(), ["kept warning", "outcome:checkout.failed", "x is not a function"]);
	} finally {
		await c.close();
	}
});

test("sampleRate samples errors, never warnings, fatal messages or crashes", async () => {
	const c = await collector();
	const sdk = initAutterServer({ ...base(c.endpoint), captureGlobalErrors: false, sampleRate: 0 });
	try {
		captureException(new Error("sampled out"));
		captureMessage("a warning", "warning");
		captureMessage("a fatal message", "fatal");
		captureMessage("an error message", "error");
		reportOutcome("job.failed", "sampled out too");
		// What the crash monitor and rejection capture send.
		captureException(new Error("uncaught"), { "autter.unhandled": true });
		captureException(new Error("unhandled rejection"), { "autter.unhandled_rejection": true });
		await sdk.shutdown();
		assert.deepEqual(c.reported().sort(), ["a fatal message", "a warning", "uncaught", "unhandled rejection"]);
	} finally {
		await c.close();
	}
});

test("sampleRate keeps about its share of errors", async () => {
	const c = await collector();
	const sdk = initAutterServer({ ...base(c.endpoint), captureGlobalErrors: false, sampleRate: 0.5 });
	try {
		for (let i = 0; i < 400; i++) captureException(new Error(`error ${i}`));
		await sdk.shutdown();
		const kept = c.reported().length;
		assert.ok(kept > 140 && kept < 260, `kept ${kept} of 400 at 0.5`);
	} finally {
		await c.close();
	}
});

test("logger-only mode takes the same options", async () => {
	const c = await collector();
	const logging = initAutterLogging({
		service: "worker",
		apiKey: "k",
		endpoint: c.endpoint,
		exceptions: "log",
		autoFlush: false,
		captureGlobalErrors: false,
		ignoreErrors: ["known flaky upstream"],
		sampleRate: 0,
	});
	try {
		logging.captureException(new Error("known flaky upstream timed out"));
		logging.captureException(new Error("sampled out"));
		logging.captureException(new Error("a crash"), { "autter.unhandled": true });
		await logging.flush();
		await logging.shutdown();
		const messages = c
			.logRecords()
			.map((record) => record.attributes.find((a) => a.key === "exception.message")?.value.stringValue)
			.filter(Boolean);
		assert.deepEqual(messages, ["a crash"]);
	} finally {
		await c.close();
	}
});
