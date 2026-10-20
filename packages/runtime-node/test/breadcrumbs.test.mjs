import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { trace } from "@opentelemetry/api";
import {
	addBreadcrumb,
	autterRequests,
	captureException,
	initAutterServer,
	runtimeLogger,
	sanitizeBrowserPayload,
	withRuntimeOperation,
} from "../dist/index.js";
import { createIngesterApp } from "../../otlp-ingester/dist/server.js";

const close = (server) =>
	new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});
const listen = async (server) => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${server.address().port}`;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("relay: browser breadcrumbs are kept, bounded to 30, re-validated and re-scrubbed", () => {
	const at = "2026-10-20T10:00:00.000Z";
	const out = sanitizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "test",
		events: [
			{
				type: "exception",
				timestamp: at,
				message: "boom",
				breadcrumbs: [
					...Array.from({ length: 40 }, (_, i) => ({ type: "click", at, message: `click:${i}` })),
					{ type: "request", at, level: "warning", message: "GET /me 401 sk_" + "live_abcdefghijklmnopqrstuvwx", data: { status: 401, cookie: "a=b", nested: {} } },
					{ type: "click", message: "no time: dropped" },
					"junk",
				],
			},
			{ type: "exception", timestamp: at, message: "none", breadcrumbs: "not a list" },
		],
	});
	const [withSteps, without] = out.events;
	assert.equal(withSteps.breadcrumbs.length, 30);
	assert.equal(withSteps.breadcrumbs[0].message, "click:11");
	assert.deepEqual(withSteps.breadcrumbs.at(-1), {
		type: "request",
		at,
		level: "warning",
		message: "GET /me 401 [redacted]",
		data: { status: 401, cookie: "[redacted]" },
	});
	assert.equal(without.breadcrumbs, undefined);
	assert.ok(!("breadcrumbs" in without));
});

test("addBreadcrumb never throws on bad input", () => {
	for (const input of [undefined, null, 42, "text", [], { message: { toString() { throw new Error("x"); } } }, {
		get message() {
			throw new Error("getter");
		},
	}]) {
		assert.doesNotThrow(() => addBreadcrumb(input));
	}
});

test("request-scoped breadcrumbs and runtimeLogger entries reach the exception span, the ingester and the sink", async () => {
	const occurrenceRows = [];
	const ch = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const query = new URL(req.url, "http://localhost").searchParams.get("query") ?? "";
			if (query.includes("INSERT INTO") && query.includes("runtime_error_occurrences"))
				occurrenceRows.push(...body.trim().split("\n").filter(Boolean).map(JSON.parse));
			res.end();
		});
	});
	const sinkOccurrences = [];
	const sink = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			sinkOccurrences.push(...JSON.parse(body).occurrences);
			res.writeHead(202).end();
		});
	});
	const chUrl = await listen(ch);
	const sinkUrl = await listen(sink);
	const { app: ingesterApp } = createIngesterApp({
		port: 0,
		clickhouseUrl: chUrl,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [{ key: "test-server", orgId: "org-sdk", repositoryId: "repo-sdk" }],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: `${sinkUrl}/runtime/sink`,
		sinkToken: null,
		maxBodyBytes: 1048576,
		rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
		logTtlDays: 14,
	});
	const ingester = createServer(ingesterApp);
	const ingesterUrl = await listen(ingester);
	const runtime = initAutterServer({
		service: "breadcrumbs-api",
		environment: "test",
		apiKey: "test-server",
		endpoint: ingesterUrl,
		captureGlobalErrors: false,
		autoFlush: false,
		compatCheck: false,
		logging: { console: false },
	});

	const app = express();
	app.use(autterRequests());
	app.get("/a", async (_req, res) => {
		addBreadcrumb({ message: "opened cart", data: { items: 3, password: "hunter2", nested: { a: 1 } } });
		runtimeLogger.info("loading prices for jane@example.com", { region: "eu", token: "t0k3n" });
		await withRuntimeOperation("price", async () => {
			addBreadcrumb({ type: "custom", level: "debug", message: "child operation step" });
		});
		await delay(25); // /b runs meanwhile
		captureException(new Error("boom in a"));
		res.status(500).end();
	});
	app.get("/b", async (_req, res) => {
		addBreadcrumb({ message: "only in b" });
		await delay(5);
		res.end();
	});
	app.get("/c", (_req, res) => {
		for (let i = 0; i < 40; i++) addBreadcrumb({ message: `step ${i}` });
		captureException(new Error("boom in c"));
		res.status(500).end();
	});
	const server = createServer(app);
	const url = await listen(server);
	try {
		addBreadcrumb({ message: "booted" });
		await Promise.all([fetch(`${url}/a`), fetch(`${url}/b`), fetch(`${url}/c`)].map(async (r) => (await r).text()));
		// Without the request middleware, a traced unit of work is its own scope.
		const job = (n) =>
			trace.getTracer("test").startActiveSpan(`job-${n}`, async (span) => {
				addBreadcrumb({ message: `in job ${n}` });
				await delay(10);
				captureException(new Error(`boom in job ${n}`));
				span.end();
			});
		await Promise.all([job(1), job(2)]);
		// A background operation that throws: its span records the error after
		// the operation's scope has exited, and still gets the operation's steps.
		await withRuntimeOperation("nightly-sync", async () => {
			addBreadcrumb({ message: "sync started" });
			runtimeLogger.warn("upstream slow", { ms: 900 });
			throw new Error("sync failed");
		}).catch(() => {});
		captureException(new Error("crash outside any request"));
		await runtime.shutdown();

		const deadline = Date.now() + 5000;
		while (sinkOccurrences.length < 6 && Date.now() < deadline) await delay(20);
		const byMessage = (list, message) => list.find((o) => o.message === message);

		const a = byMessage(sinkOccurrences, "boom in a");
		assert.ok(a, "occurrence for /a reached the sink");
		assert.deepEqual(
			a.breadcrumbs.map((c) => [c.type, c.level, c.message]),
			[
				["custom", undefined, "opened cart"],
				["log", "info", "loading prices for [redacted]"],
				["custom", "debug", "child operation step"],
			],
		);
		assert.deepEqual(a.breadcrumbs[0].data, { items: 3, password: "[redacted]" });
		assert.deepEqual(a.breadcrumbs[1].data, { region: "eu", token: "[redacted]" });
		assert.ok(!JSON.stringify(a.breadcrumbs).includes("only in b"), "scoped to its own request");
		assert.ok(!JSON.stringify(a.breadcrumbs).includes("booted"));

		const c = byMessage(sinkOccurrences, "boom in c");
		assert.equal(c.breadcrumbs.length, 30);
		assert.equal(c.breadcrumbs[0].message, "step 10");
		assert.equal(c.breadcrumbs[29].message, "step 39");

		for (const n of [1, 2]) {
			const jobOccurrence = byMessage(sinkOccurrences, `boom in job ${n}`);
			assert.deepEqual(jobOccurrence.breadcrumbs.map((crumb) => crumb.message), [`in job ${n}`]);
		}

		const sync = byMessage(sinkOccurrences, "sync failed");
		assert.deepEqual(
			sync.breadcrumbs.map((crumb) => [crumb.type, crumb.level, crumb.message]),
			[
				["custom", undefined, "sync started"],
				["log", "warning", "upstream slow"],
			],
		);

		const outside = byMessage(sinkOccurrences, "crash outside any request");
		assert.deepEqual(outside.breadcrumbs.map((crumb) => crumb.message), ["booted"]);

		const row = occurrenceRows.find((r) => r.occurrence_id === a.occurrenceId);
		assert.ok(row, "stored in ClickHouse");
		assert.deepEqual(JSON.parse(row.attributes)["autter.breadcrumbs"], a.breadcrumbs);
	} finally {
		await close(server);
		await close(ingester);
		await close(sink);
		await close(ch);
	}
});
