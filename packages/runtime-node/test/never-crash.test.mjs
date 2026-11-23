// The SDK must never crash the host app: every export and flush path is run
// against a local ingester that refuses the key (401), fails (500), or is
// not there at all (connection refused). Nothing may reject or throw, no
// unhandled rejection may appear, and the failure must be surfaced (the
// onExportError callback, the result object and a console warning).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	captureException,
	emitLlmSelftestTrace,
	flushRuntimeLogs,
	initAutterLogging,
	initAutterServer,
	runtimeLogger,
} from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A local ingester that answers every request with `status`. */
async function failingIngester(status) {
	const hits = [];
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			hits.push(req.url);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: status === 401 ? "unauthorized" : "internal" }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		endpoint: `http://127.0.0.1:${server.address().port}`,
		hits,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/** An address nothing listens on: every connection is refused. */
async function refusedIngester() {
	const server = http.createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return { endpoint: `http://127.0.0.1:${port}`, hits: [], close: async () => {} };
}

const CASES = [
	{
		name: "401 (wrong ingest key)",
		start: () => failingIngester(401),
		kind: "unauthorized",
		status: 401,
		warning: /export failed \(401 Unauthorized\) — check your ingest key/,
	},
	{
		name: "500 (ingester error)",
		start: () => failingIngester(500),
		kind: "server_error",
		status: 500,
		warning: /export failed \(500 Internal Server Error\)/,
	},
	{
		name: "connection refused",
		start: refusedIngester,
		kind: "unreachable",
		status: undefined,
		warning: /export failed \(ECONNREFUSED\) — could not reach the ingester/,
	},
];

/** Record unhandled rejections and console warnings while `fn` runs. */
async function observe(fn) {
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const warnings = [];
	const warn = console.warn;
	console.warn = (...args) => warnings.push(args.map(String).join(" "));
	try {
		await fn(warnings);
		// Nothing rejects: a bounded wait (there is nothing to poll for) gives
		// a stray rejection a chance to surface.
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		console.warn = warn;
		process.off("unhandledRejection", onUnhandled);
	}
	return { unhandled, warnings };
}

for (const scenario of CASES) {
	test(`initAutterServer: nothing rejects against an ingester answering ${scenario.name}`, { timeout: 60_000 }, async () => {
		const ingester = await scenario.start();
		const reported = [];
		const { unhandled, warnings } = await observe(async () => {
			const runtime = initAutterServer({
				apiKey: "autter_rt_wrong",
				service: "never-crash",
				endpoint: ingester.endpoint,
				autoFlush: false,
				captureGlobalErrors: false,
				memoryMetrics: false,
				compatCheck: false,
				metricIntervalMs: 3_600_000,
				logging: { console: false },
				onExportError: (error) => {
					reported.push(error);
					throw new Error("a throwing handler is ignored");
				},
			});
			try {
				const selftest = await emitLlmSelftestTrace();
				assert.equal(selftest.ok, false, "the self-test says it was not delivered");
				assert.match(selftest.traceId, /^[0-9a-f]{32}$/);
				assert.ok(selftest.errors.length >= 1, "and why");
				assert.equal(selftest.errors[0].kind, scenario.kind);
				assert.equal(selftest.errors[0].status, scenario.status);
				assert.equal(selftest.errors[0].signal, "traces");
				// The result is safe to res.json(): no error objects in it.
				assert.doesNotThrow(() => JSON.stringify(selftest));
				assert.ok(selftest.errors[0].error, "the original error stays reachable");

				runtimeLogger.info("a log record that cannot be delivered");
				const logs = await flushRuntimeLogs();
				assert.equal(logs.ok, false);
				assert.ok(logs.errors.some((error) => error.signal === "logs" && error.kind === scenario.kind));

				captureException(new Error("an error that cannot be delivered"));
				const flushed = await runtime.forceFlush();
				assert.equal(flushed.ok, false);
				assert.ok(flushed.errors.some((error) => error.kind === scenario.kind));

				captureException(new Error("buffered at shutdown"));
			} finally {
				// Resolves even though its final export fails.
				await runtime.shutdown();
			}
		});
		await ingester.close();

		assert.deepEqual(unhandled, [], "no unhandled rejection");
		assert.ok(reported.length >= 3, `onExportError called for every failure (${reported.length})`);
		assert.ok(reported.every((error) => error.kind === scenario.kind), JSON.stringify(reported));
		assert.ok(reported.some((error) => error.signal === "traces"));
		assert.ok(reported.some((error) => error.signal === "logs"));
		assert.ok(
			warnings.some((line) => scenario.warning.test(line)),
			`an actionable warning was printed:\n${warnings.join("\n")}`,
		);
		// Rate limited: one warning per kind of failure and pipe, not one per batch.
		assert.ok(warnings.length <= 4, `warnings are rate limited:\n${warnings.join("\n")}`);
		if (scenario.status) assert.ok(ingester.hits.includes("/v1/traces"), "the ingester was really asked");
	});
}

test("emitLlmSelftestTrace before initAutterServer resolves with ok: false", async () => {
	const { unhandled, warnings } = await observe(async () => {
		const result = await emitLlmSelftestTrace();
		assert.equal(result.ok, false);
		assert.equal(result.traceId, "");
		assert.equal(result.errors[0].kind, "not_initialized");
	});
	assert.deepEqual(unhandled, []);
	assert.ok(warnings.some((line) => /requires initAutterServer/.test(line)));
});

test("initAutterLogging: flush and shutdown never reject against a 401 ingester", async () => {
	const ingester = await failingIngester(401);
	const reported = [];
	const { unhandled } = await observe(async () => {
		const logging = initAutterLogging({
			apiKey: "autter_rt_wrong",
			endpoint: ingester.endpoint,
			service: "never-crash-logging",
			autoFlush: false,
			captureGlobalErrors: false,
			logging: { console: false },
			onExportError: (error) => reported.push(error),
		});
		runtimeLogger.info("refused");
		const flushed = await logging.flush();
		assert.equal(flushed.ok, false);
		assert.equal(flushed.errors[0]?.status, 401);
		runtimeLogger.info("refused at shutdown");
		await logging.shutdown();
	});
	await ingester.close();
	assert.deepEqual(unhandled, []);
	assert.ok(reported.length >= 1);
	assert.ok(reported.every((error) => error.kind === "unauthorized"));
	// After the 401 the sink pauses: the record written before shutdown is
	// dropped quietly instead of being sent to be refused again.
	assert.equal(ingester.hits.filter((url) => url === "/v1/logs").length, 1);
});

function runFixture(env) {
	const { NODE_OPTIONS: _ignored, ...base } = process.env;
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(here, "fixtures", "express-selftest.mjs")], {
			env: { ...base, ...env },
			stdio: "pipe",
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

for (const scenario of CASES) {
	test(`Express 4 route awaiting emitLlmSelftestTrace() survives ${scenario.name}`, { timeout: 60_000 }, async () => {
		const ingester = await scenario.start();
		const { code, out, err } = await runFixture({ INGESTER: ingester.endpoint });
		await ingester.close();
		assert.equal(code, 0, `the process did not crash\nstdout:\n${out}\nstderr:\n${err}`);
		assert.match(out, /survived/);
		const answer = JSON.parse(out.split("\n")[0]);
		assert.equal(answer.status, 200);
		assert.equal(answer.ok, false);
		assert.ok(answer.kinds.includes(scenario.kind), out);
		assert.match(err, scenario.warning, "the failure was printed");
		assert.doesNotMatch(err, /UnhandledPromiseRejection|unhandled/i);
	});
}

/**
 * A local ingester with a body limit, like otlp-ingester's MAX_BODY_BYTES
 * (1 MiB): a larger POST is answered 413 and nothing in it is kept. Counts
 * the exception events it accepted on /v1/traces.
 */
async function limitedIngester(limit) {
	const sizes = [];
	const messages = [];
	let refused = 0;
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			sizes.push(body.length);
			if (body.length > limit) {
				refused++;
				res.writeHead(413, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "payload too large" }));
				return;
			}
			if (req.url === "/v1/traces") {
				for (const resource of JSON.parse(body).resourceSpans ?? [])
					for (const scope of resource.scopeSpans ?? [])
						for (const span of scope.spans ?? [])
							for (const event of span.events ?? [])
								if (event.name === "exception")
									messages.push(event.attributes.find((a) => a.key === "exception.message")?.value.stringValue);
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		endpoint: `http://127.0.0.1:${server.address().port}`,
		sizes,
		messages,
		refused: () => refused,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

// An error storm: 600 captured exceptions used to leave as one 1.27 MB batch
// (OpenTelemetry's 512 spans per export), refused whole with 413.
for (const [name, limit, expectSplits] of [
	["1 MiB, the ingester's default body limit", 1024 * 1024, false],
	["64 KiB, so batches of 128 are refused and split", 64 * 1024, true],
]) {
	test(`600 captured exceptions all arrive at an ingester with a ${name}`, { timeout: 60_000 }, async () => {
		const ingester = await limitedIngester(limit);
		const { unhandled, warnings } = await observe(async () => {
			const runtime = initAutterServer({
				apiKey: "autter_rt_test",
				service: "error-storm",
				endpoint: ingester.endpoint,
				autoFlush: false,
				captureGlobalErrors: false,
				memoryMetrics: false,
				compatCheck: false,
				metricIntervalMs: 3_600_000,
				logging: { console: false },
			});
			try {
				const padding = "x".repeat(1200);
				for (let i = 0; i < 600; i++) captureException(new Error(`storm ${i} ${padding}`));
				const flushed = await runtime.forceFlush();
				assert.equal(flushed.ok, true, JSON.stringify(flushed.errors));
			} finally {
				await runtime.shutdown();
			}
		});
		await ingester.close();
		assert.deepEqual(unhandled, []);
		const accepted = ingester.sizes.filter((size) => size <= limit);
		assert.ok(accepted.length > 1, "the storm was sent in several batches");
		if (expectSplits) assert.ok(ingester.refused() > 0, "batches over the limit were refused, then split");
		else assert.equal(ingester.refused(), 0, `every POST is under 1 MiB: ${Math.max(...ingester.sizes)} bytes`);
		const arrived = new Set(ingester.messages.map((message) => message?.split(" ")[1]));
		assert.equal(arrived.size, 600, "every exception arrived");
		assert.deepEqual(warnings, []);
	});
}

test("a single span larger than the body limit is dropped with one warning, its batch's other spans arrive", { timeout: 60_000 }, async () => {
	const ingester = await limitedIngester(64 * 1024);
	const { unhandled, warnings } = await observe(async () => {
		const runtime = initAutterServer({
			apiKey: "autter_rt_test",
			service: "error-storm",
			endpoint: ingester.endpoint,
			autoFlush: false,
			captureGlobalErrors: false,
			memoryMetrics: false,
			compatCheck: false,
			metricIntervalMs: 3_600_000,
			logging: { console: false },
		});
		try {
			for (let i = 0; i < 20; i++) captureException(new Error(`small ${i}`));
			captureException(new Error(`huge ${"y".repeat(60_000)}`), { "big.one": "z".repeat(60_000) });
			captureException(new Error(`huge ${"y".repeat(60_000)}`), { "big.two": "z".repeat(60_000) });
			const flushed = await runtime.forceFlush();
			assert.equal(flushed.ok, false);
			assert.equal(flushed.errors[0].kind, "payload_too_large");
		} finally {
			await runtime.shutdown();
		}
	});
	await ingester.close();
	assert.deepEqual(unhandled, []);
	assert.equal(new Set(ingester.messages.filter((m) => m?.startsWith("small"))).size, 20);
	assert.equal(ingester.messages.filter((m) => m?.startsWith("huge")).length, 0);
	assert.equal(warnings.filter((line) => /413 Payload Too Large/.test(line)).length, 1, warnings.join("\n"));
});
