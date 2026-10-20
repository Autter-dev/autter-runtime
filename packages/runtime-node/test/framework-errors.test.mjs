// Express, Fastify and Koa error hooks, end to end: a real app whose handler
// throws, the real OTel HTTP instrumentation, the SDK's OTLP export, and the
// ingester's normaliser. The thrown error must arrive as an exception event
// with its real stack on the request span — not as a stackless
// HttpServerError synthesized from the 500.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { context, trace } from "@opentelemetry/api";
import express from "express";
import Fastify from "fastify";
import Koa from "koa";
import { normalizeTraces } from "../../otlp-ingester/dist/normalize-otlp.js";
import {
	autterErrorHandler,
	autterFastifyErrors,
	autterKoa,
	autterRequests,
	captureException,
	initAutterServer,
} from "../dist/index.js";
import { captureRuntime } from "../dist/testing.js";

const require = createRequire(import.meta.url);
const traceBodies = [];
let collector;
let sdk;
let runtime;
const apps = [];

before(async () => {
	const { createServer } = await import("node:http");
	collector = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.url === "/v1/traces") traceBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	sdk = initAutterServer({
		apiKey: "test-key",
		service: "framework-errors",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		// Default 1% head sampling: the erroring traces must still be kept
		// (tail retention), exactly as in production.
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		metricIntervalMs: 3_600_000,
		logging: { console: false },
	});
	runtime = captureRuntime();
	// Loaded after init so the HTTP instrumentation patches the server.
	require("http");
});

after(async () => {
	runtime?.stop();
	await Promise.all(apps.map((close) => close()));
	await new Promise((resolve) => {
		collector.close(resolve);
		collector.closeAllConnections();
	});
});

async function listen(handler) {
	const server = require("http").createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	apps.push(
		() =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	);
	return `http://127.0.0.1:${server.address().port}`;
}

let exported;
/** Flush everything once (shutdown exports every buffered span), then read
 * the server span and the ingester's occurrences for one request path. */
async function exportedFor(path) {
	if (!exported) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		await sdk.shutdown();
		const spans = [];
		const occurrences = [];
		for (const body of traceBodies) {
			for (const rs of body.resourceSpans ?? [])
				for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []));
			occurrences.push(...normalizeTraces(body).occurrences);
		}
		exported = { spans, occurrences };
	}
	const attr = (span, key) => span.attributes?.find((a) => a.key === key)?.value?.stringValue;
	const server = exported.spans.filter(
		(span) => span.kind === 2 && (attr(span, "http.target") ?? attr(span, "url.path")) === path,
	);
	assert.equal(server.length, 1, `one server span for ${path}`);
	const traceId = server[0].traceId;
	return {
		server: server[0],
		exceptions: (server[0].events ?? []).filter((event) => event.name === "exception"),
		traceSpans: exported.spans.filter((span) => span.traceId === traceId),
		occurrences: exported.occurrences.filter((occurrence) => occurrence.traceId === traceId),
	};
}

const eventAttr = (event, key) => event.attributes.find((a) => a.key === key)?.value?.stringValue;

function assertThrownWithStack(result, { message, frame }) {
	assert.equal(result.exceptions.length, 1, "one exception event on the request span");
	const [event] = result.exceptions;
	assert.equal(eventAttr(event, "exception.type"), "Error");
	assert.equal(eventAttr(event, "exception.message"), message);
	const stack = eventAttr(event, "exception.stacktrace");
	assert.match(stack, new RegExp(`at (?:\\S+\\.)?${frame} `), "real stack: the throwing handler's frame");
	assert.match(stack, /framework-errors\.test\.mjs/);
	// The ingester sees the real exception, and no stackless 500.
	assert.equal(result.occurrences.length, 1, JSON.stringify(result.occurrences.map((o) => o.errorType)));
	const [occurrence] = result.occurrences;
	assert.equal(occurrence.errorType, "Error");
	assert.equal(occurrence.message, message);
	assert.equal(occurrence.statusCode, 500);
	assert.match(occurrence.stack, new RegExp(frame));
	assert.ok(!result.occurrences.some((o) => o.errorType === "HttpServerError"));
}

const runs = {};

test("Express: autterErrorHandler records the thrown error with its stack and calls next(err) unchanged", async () => {
	const app = express();
	app.use(autterRequests());
	app.get("/express/boom", function expressBoomHandler() {
		throw new Error("express handler failed");
	});
	app.get("/express/not-found", (_req, _res, next) => {
		next(Object.assign(new Error("no such order"), { status: 404 }));
	});
	app.get("/express/already-captured", (_req, _res, next) => {
		const error = new Error("captured by the handler");
		captureException(error);
		next(error);
	});
	app.get("/express/child-span", (_req, _res, next) => {
		// An instrumentation (ExpressInstrumentation, …) leaves a child span
		// active: the exception must still land on the request span.
		const child = trace.getTracer("test").startSpan("middleware - layer");
		context.with(trace.setSpan(context.active(), child), function childSpanHandler() {
			next(new Error("thrown under a child span"));
		});
		child.end();
	});
	const seen = [];
	app.use(autterErrorHandler());
	app.use((error, _req, res, _next) => {
		seen.push(error);
		res.status(error.status ?? 500).send("app error handler");
	});
	const url = await listen(app);

	const boom = await fetch(`${url}/express/boom`);
	assert.equal(boom.status, 500);
	assert.equal(await boom.text(), "app error handler", "the app's own error handler still answers");
	const notFound = await fetch(`${url}/express/not-found`);
	assert.equal(notFound.status, 404);
	await notFound.text();
	await (await fetch(`${url}/express/already-captured`)).text();
	await (await fetch(`${url}/express/child-span`)).text();
	assert.deepEqual(
		seen.map((error) => error.message),
		["express handler failed", "no such order", "captured by the handler", "thrown under a child span"],
		"next(err) passes the same errors on",
	);
	runs.express = true;
});

test("Fastify: autterFastifyErrors (onError) records the thrown error with its stack", async () => {
	const app = Fastify();
	await app.register(autterFastifyErrors);
	app.get("/fastify/boom", async function fastifyBoomHandler() {
		throw new Error("fastify handler failed");
	});
	app.get("/fastify/bad-request", async () => {
		throw Object.assign(new Error("invalid cart"), { statusCode: 400 });
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	apps.push(() => app.close());
	const url = `http://127.0.0.1:${app.server.address().port}`;
	const boom = await fetch(`${url}/fastify/boom`);
	assert.equal(boom.status, 500);
	assert.equal((await boom.json()).message, "fastify handler failed", "Fastify's error handler still answers");
	const bad = await fetch(`${url}/fastify/bad-request`);
	assert.equal(bad.status, 400);
	await bad.text();

	// Direct form: autterFastifyErrors(app) without register.
	const direct = Fastify();
	autterFastifyErrors(direct, { capture: true });
	direct.get("/fastify/direct", async function fastifyDirectHandler() {
		throw Object.assign(new Error("direct registration"), { statusCode: 409 });
	});
	await direct.listen({ port: 0, host: "127.0.0.1" });
	apps.push(() => direct.close());
	const conflict = await fetch(`http://127.0.0.1:${direct.server.address().port}/fastify/direct`);
	assert.equal(conflict.status, 409);
	await conflict.text();
	runs.fastify = true;
});

test("Koa: autterKoa records the thrown error with its stack and rethrows it", async () => {
	const app = new Koa();
	const emitted = [];
	app.on("error", (error) => emitted.push(error));
	app.use(autterKoa());
	app.use(async function koaBoomHandler(ctx) {
		if (ctx.path === "/koa/boom") throw new Error("koa handler failed");
		if (ctx.path === "/koa/forbidden") ctx.throw(403, "not yours");
		ctx.body = "ok";
	});
	const url = await listen(app.callback());
	const boom = await fetch(`${url}/koa/boom`);
	assert.equal(boom.status, 500);
	await boom.text();
	const forbidden = await fetch(`${url}/koa/forbidden`);
	assert.equal(forbidden.status, 403);
	await forbidden.text();
	assert.deepEqual(
		emitted.map((error) => error.message),
		["koa handler failed", "not yours"],
		"Koa still sees the same errors",
	);
	runs.koa = true;
});

test("exported spans: each framework's thrown error is an exception with a real stack, never a stackless HttpServerError", async () => {
	assert.deepEqual(runs, { express: true, fastify: true, koa: true });

	assertThrownWithStack(await exportedFor("/express/boom"), {
		message: "express handler failed",
		frame: "expressBoomHandler",
	});
	assertThrownWithStack(await exportedFor("/fastify/boom"), {
		message: "fastify handler failed",
		frame: "fastifyBoomHandler",
	});
	assertThrownWithStack(await exportedFor("/koa/boom"), {
		message: "koa handler failed",
		frame: "koaBoomHandler",
	});

	// The child span stays clean; the request span carries the exception.
	const child = await exportedFor("/express/child-span");
	assert.equal(child.exceptions.length, 1);
	assert.match(eventAttr(child.exceptions[0], "exception.stacktrace"), /childSpanHandler/);
	const layer = child.traceSpans.find((span) => span.name === "middleware - layer");
	assert.ok(layer, "child span exported with the trace");
	assert.equal((layer.events ?? []).filter((event) => event.name === "exception").length, 0);
	assert.equal(child.occurrences.length, 1);

	// An error the handler already captured is reported once.
	const captured = await exportedFor("/express/already-captured");
	assert.equal(captured.exceptions.length, 1);
	assert.equal(captured.occurrences.length, 1);

	// 4xx errors are not reported by default; `capture: true` reports them.
	for (const path of ["/express/not-found", "/fastify/bad-request", "/koa/forbidden"]) {
		const result = await exportedFor(path).catch(() => null);
		if (result) assert.equal(result.exceptions.length, 0, path);
	}
	const direct = await exportedFor("/fastify/direct");
	assert.equal(direct.exceptions.length, 1);
	assert.match(eventAttr(direct.exceptions[0], "exception.stacktrace"), /fastifyDirectHandler/);

	// The request summary (autterRequests) carries the failure too.
	const summary = runtime.operations.find((event) => event.attributes["autter.operation.name"] === "GET /express/boom");
	assert.equal(summary?.attributes["autter.operation.outcome"], "failed");
});
