// Query strings in span URLs: whatever instrumentation made the span (the
// HTTP instrumentation's server and client spans behind Express and Fastify,
// undici/fetch's stable-semconv `url.full`, Next.js's own `http.target` and
// `GET /path?…` names), it leaves the process with the query cut from the
// URL and `url.query` reduced to parameter names, except `keepQueryParams`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { trace, SpanKind } from "@opentelemetry/api";
import express from "express";
import Fastify from "fastify";
import { initAutterServer } from "../dist/index.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const bodies = [];
let collector;
let endpoint;

before(async () => {
	const { createServer } = await import("node:http");
	collector = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.url === "/v1/traces") bodies.push(Buffer.concat(chunks).toString("utf8"));
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	endpoint = `http://127.0.0.1:${collector.address().port}`;
});

after(async () => {
	await new Promise((resolve) => {
		collector.close(resolve);
		collector.closeAllConnections();
	});
});

const value = (v) => v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue;

/** Every exported span: { name, kind, attributes }. */
function spans(raw) {
	const out = [];
	for (const text of raw) {
		const body = JSON.parse(text);
		for (const rs of body.resourceSpans ?? [])
			for (const ss of rs.scopeSpans ?? [])
				for (const span of ss.spans ?? [])
					out.push({
						name: span.name,
						kind: span.kind,
						attributes: Object.fromEntries((span.attributes ?? []).map((a) => [a.key, value(a.value)])),
					});
	}
	return out;
}

const URL_KEYS = ["http.target", "http.url", "url.full", "url.original", "url.path"];

function get(url) {
	return new Promise((resolve, reject) => {
		require("http")
			.get(url, (res) => {
				res.resume();
				res.on("end", resolve);
			})
			.on("error", reject);
	});
}

test("query values never leave the process, whichever instrumentation made the span", async () => {
	const sdk = initAutterServer({
		apiKey: "test-key",
		service: "url-query",
		endpoint,
		traceSampleRate: 1,
		keepQueryParams: ["page"],
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		metricIntervalMs: 3_600_000,
		logging: { console: false },
	});
	// Loaded after init so the HTTP instrumentation patches it.
	const http = require("http");

	const app = express();
	app.get("/search", (_req, res) => res.send("ok"));
	// `?` in a route template marks an optional parameter, not a query.
	app.get("/users/:id?", (_req, res) => res.send("ok"));
	const expressServer = http.createServer(app);
	await new Promise((resolve) => expressServer.listen(0, "127.0.0.1", resolve));
	const expressUrl = `http://127.0.0.1:${expressServer.address().port}`;

	const fastify = Fastify();
	fastify.get("/items/:id", async () => "ok");
	await fastify.listen({ port: 0, host: "127.0.0.1" });
	const fastifyUrl = `http://127.0.0.1:${fastify.server.address().port}`;

	try {
		// Server + client spans from the HTTP instrumentation.
		await get(`${expressUrl}/search?email=jane%40example.com&page=2&code=codesecret1&token=tokensecret1`);
		await get(`${fastifyUrl}/items/9?session=sesssecret1&sort=sortsecret1&page=3#frag`);
		await get(`${expressUrl}/users/7?ref=refsecret1`);

		const tracer = trace.getTracer("third-party");
		// undici/fetch with stable semantic conventions.
		tracer
			.startSpan("GET", {
				kind: SpanKind.CLIENT,
				attributes: { "url.full": "https://api.example.test/v1/users?filter=fetchsecret1&page=4", "server.address": "api.example.test" },
			})
			.end();
		// A stable-semconv server span that already split the query out.
		tracer
			.startSpan("GET /lookup", {
				kind: SpanKind.SERVER,
				attributes: { "url.path": "/lookup", "url.query": "?q=querysecret1&page=5&flag", "http.route": "/lookup" },
			})
			.end();
		// Next.js names its request span after the raw URL until it knows the route.
		tracer
			.startSpan("GET /rsc-throw?draft=nextsecret1", {
				kind: SpanKind.SERVER,
				attributes: {
					"http.target": "/rsc-throw?draft=nextsecret1",
					"http.method": "GET",
					"next.span_type": "BaseServer.handleRequest",
					// Next 15 copies the name into an attribute.
					"next.span_name": "GET /rsc-throw?draft=nextsecret1",
				},
			})
			.end();
		// The whole query is an opaque token.
		tracer.startSpan("verify", { attributes: { "http.target": "/verify?opaquesecret1" } }).end();
	} finally {
		await new Promise((resolve) => {
			expressServer.close(resolve);
			expressServer.closeAllConnections();
		});
		await fastify.close();
		await sdk.shutdown();
	}

	const wire = bodies.join("\n");
	for (const secret of ["jane", "refsecret1", "codesecret1", "tokensecret1", "sesssecret1", "sortsecret1", "fetchsecret1", "querysecret1", "nextsecret1", "opaquesecret1", "frag"]) {
		assert.ok(!wire.includes(secret), `query value left the process: ${secret}`);
	}

	const exported = spans(bodies);
	for (const span of exported) {
		assert.ok(!/[?#]/.test(span.name), `span name kept its query: ${span.name}`);
		for (const key of URL_KEYS) {
			const url = span.attributes[key];
			if (typeof url === "string") assert.ok(!/[?#]/.test(url), `${key} kept its query: ${url}`);
		}
	}
	const queries = exported.map((span) => span.attributes["url.query"]).filter(Boolean);
	// Express server span (from http.target) and its client span (from http.url).
	assert.ok(queries.includes("email=[redacted]&page=2&code=[redacted]&token=[redacted]"), JSON.stringify(queries));
	// Fastify: the fragment never reaches the server; the client span drops it too.
	assert.ok(queries.includes("session=[redacted]&sort=[redacted]&page=3"), JSON.stringify(queries));
	assert.ok(queries.includes("filter=[redacted]&page=4"), JSON.stringify(queries));
	assert.ok(queries.includes("q=[redacted]&page=5&[redacted]"), JSON.stringify(queries));
	assert.ok(queries.includes("draft=[redacted]"), JSON.stringify(queries));
	assert.ok(queries.includes("[redacted]"), JSON.stringify(queries));

	const server = exported.find((span) => span.kind === 2 && span.attributes["http.target"] === "/search");
	assert.ok(server, "the Express request span is exported");
	assert.equal(server.attributes["http.url"], `${expressUrl}/search`);
	assert.equal(server.attributes["http.route"], "/search");
	const users = exported.find((span) => span.kind === 2 && span.attributes["http.target"] === "/users/7");
	assert.equal(users.attributes["http.route"], "/users/:id?", "route templates are left alone");
	assert.equal(users.attributes["url.query"], "ref=[redacted]");
	const next = exported.find((span) => span.attributes["next.span_type"] === "BaseServer.handleRequest");
	assert.equal(next.name, "GET /rsc-throw");
	assert.equal(next.attributes["http.target"], "/rsc-throw");
	assert.equal(next.attributes["next.span_name"], "GET /rsc-throw");
	const fetchSpan = exported.find((span) => span.attributes["server.address"] === "api.example.test");
	assert.equal(fetchSpan.attributes["url.full"], "https://api.example.test/v1/users");
});

test("the query policy applies with redactAttributes: false", async () => {
	const before = bodies.length;
	const script = `
		import { trace } from "@opentelemetry/api";
		import { initAutterServer } from "./dist/index.js";
		const sdk = initAutterServer({
			apiKey: "k", service: "no-redact", endpoint: process.env.ENDPOINT, traceSampleRate: 1,
			redactAttributes: false, captureGlobalErrors: false, autoFlush: false, memoryMetrics: false,
			compatCheck: false, metricIntervalMs: 3_600_000, logging: { console: false },
		});
		trace.getTracer("t").startSpan("GET /a?email=raw@example.com", {
			attributes: { "http.target": "/a?email=raw@example.com&page=1", "user.email": "kept@example.com" },
		}).end();
		await sdk.shutdown();
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: join(here, ".."),
		env: { ...process.env, ENDPOINT: endpoint },
		stdio: ["ignore", "inherit", "inherit"],
	});
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 0);
	const exported = spans(bodies.slice(before)).find((span) => span.attributes["user.email"]);
	assert.ok(exported, "span exported");
	assert.equal(exported.name, "GET /a");
	assert.equal(exported.attributes["http.target"], "/a");
	assert.equal(exported.attributes["url.query"], "email=[redacted]&page=[redacted]");
	// Redaction itself stays off, as configured.
	assert.equal(exported.attributes["user.email"], "kept@example.com");
});
