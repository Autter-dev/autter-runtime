// Route templates on request metrics (EI-26). The HTTP instrumentation names
// a request's route on its span AND its http.server.duration data point from
// the request's RPC metadata. Express gets it from the response hook; Next.js
// gets it from the `next.route` its own spans carry at start (route-label.ts),
// even for spans no one records. Request spans whose metric has a route are
// marked `autter.metric_has_route`, and the resource says
// `autter.metrics_routes`, so the ingester can count those requests from the
// metric alone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { context, trace, SpanKind } from "@opentelemetry/api";
import { getRPCMetadata } from "@opentelemetry/core";
import express from "express";
import { initAutterServer } from "../dist/index.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const bodies = { "/v1/traces": [], "/v1/metrics": [] };
let collector;
let endpoint;

before(async () => {
	const { createServer } = await import("node:http");
	collector = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			bodies[req.url]?.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
const attrs = (list = []) => Object.fromEntries(list.map((a) => [a.key, value(a.value)]));

function serverSpans(traces) {
	const out = [];
	for (const body of traces)
		for (const rs of body.resourceSpans ?? [])
			for (const ss of rs.scopeSpans ?? [])
				for (const span of ss.spans ?? [])
					if (span.kind === 2 && ss.scope?.name === "@opentelemetry/instrumentation-http")
						out.push({ resource: attrs(rs.resource?.attributes), attributes: attrs(span.attributes) });
	return out;
}

/** http.server.duration data points: { target-less attributes, count }. */
function durationPoints(metrics) {
	const out = [];
	for (const body of metrics)
		for (const rm of body.resourceMetrics ?? [])
			for (const sm of rm.scopeMetrics ?? [])
				for (const metric of sm.metrics ?? [])
					if (metric.name === "http.server.duration")
						for (const point of metric.histogram?.dataPoints ?? [])
							out.push({ resource: attrs(rm.resource?.attributes), attributes: attrs(point.attributes), count: Number(point.count) });
	return out;
}

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

/** What Next.js opens while it serves /blog/hello-world (default span set,
 * plus the verbose-only "rendering page" span that carries the raw path). */
function nextLikeRequest() {
	const tracer = trace.getTracer("next.js");
	const server = tracer.startSpan("GET", {
		kind: SpanKind.SERVER,
		attributes: { "next.span_type": "BaseServer.handleRequest", "http.method": "GET", "http.target": "/blog/hello-world" },
	});
	context.with(trace.setSpan(context.active(), server), () => {
		tracer.startSpan("rendering page", {
			attributes: { "next.span_type": "BaseServer.renderToResponse", "next.route": "/blog/hello-world" },
		}).end();
		tracer.startSpan("resolve page components", {
			attributes: { "next.span_type": "NextNodeServer.findPageComponents", "next.route": "/blog/[slug]" },
		}).end();
		tracer.startSpan("render route (app) /blog/[slug]", {
			attributes: { "next.span_type": "AppRender.getBodyResult", "next.route": "/blog/[slug]" },
		}).end();
	});
	server.end();
}

/** Next 15 serving an app route handler: the template, then the handler's
 * file path ("/route" suffix) on its "executing api route" span. */
function next15RouteHandler() {
	const tracer = trace.getTracer("next.js");
	tracer.startSpan("resolve page components", {
		attributes: { "next.span_type": "NextNodeServer.findPageComponents", "next.route": "/api/items/[id]" },
	}).end();
	tracer.startSpan("executing api route (app) /api/items/[id]/route", {
		attributes: { "next.span_type": "AppRouteRouteHandlers.runHandler", "next.route": "/api/items/[id]/route" },
	}).end();
}

test("Next.js, Express and plain requests: routes on metrics, and the request span says when", async () => {
	const sdk = initAutterServer({
		apiKey: "test-key",
		service: "request-routes",
		endpoint,
		traceSampleRate: 1,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		metricIntervalMs: 3_600_000,
		logging: { console: false },
	});
	const http = require("http");
	const handler = (req, res) => {
		if (req.url === "/blog/hello-world") nextLikeRequest();
		if (req.url === "/api/items/7") next15RouteHandler();
		if (req.url === "/owned") {
			// A router instrumentation named the route first: it stays.
			getRPCMetadata(context.active()).route = "/owned/:by-router";
			trace.getTracer("next.js").startSpan("render route (app) /x", { attributes: { "next.route": "/x" } }).end();
		}
		res.end("ok");
	};
	const plain = http.createServer(handler);
	await new Promise((resolve) => plain.listen(0, "127.0.0.1", resolve));
	const app = express();
	app.get("/users/:id", (_req, res) => res.send("ok"));
	const expressServer = http.createServer(app);
	await new Promise((resolve) => expressServer.listen(0, "127.0.0.1", resolve));
	const plainUrl = `http://127.0.0.1:${plain.address().port}`;
	try {
		await get(`${plainUrl}/blog/hello-world`);
		await get(`${plainUrl}/blog/hello-world`);
		await get(`${plainUrl}/api/items/7`);
		await get(`http://127.0.0.1:${expressServer.address().port}/users/42`);
		await get(`${plainUrl}/no-route`);
		await get(`${plainUrl}/owned`);
	} finally {
		await new Promise((resolve) => {
			plain.close(resolve);
			plain.closeAllConnections();
		});
		await new Promise((resolve) => {
			expressServer.close(resolve);
			expressServer.closeAllConnections();
		});
		await sdk.shutdown();
	}

	const points = durationPoints(bodies["/v1/metrics"]);
	const byRoute = Object.fromEntries(points.map((p) => [p.attributes["http.route"] ?? "", p.count]));
	assert.deepEqual(byRoute, { "/blog/[slug]": 2, "/api/items/[id]": 1, "/users/:id": 1, "": 1, "/owned/:by-router": 1 });
	assert.equal(points[0]?.resource["autter.metrics_wired"], true);
	assert.equal(points[0]?.resource["autter.metrics_routes"], true);

	const spans = serverSpans(bodies["/v1/traces"]);
	const byTarget = (target) => spans.filter((s) => s.attributes["http.target"] === target);
	for (const span of byTarget("/blog/hello-world")) {
		assert.equal(span.attributes["http.route"], "/blog/[slug]");
		assert.equal(span.attributes["autter.metric_has_route"], true);
	}
	assert.equal(byTarget("/users/42")[0]?.attributes["autter.metric_has_route"], true);
	assert.equal(byTarget("/no-route")[0]?.attributes["autter.metric_has_route"], undefined);
	assert.equal(byTarget("/no-route")[0]?.attributes["http.route"], undefined);
	assert.equal(byTarget("/owned")[0]?.attributes["http.route"], "/owned/:by-router");
	assert.equal(spans[0]?.resource["autter.metrics_routes"], true);
});

test("the route reaches the metric when nothing is sampled or retained", async () => {
	// No span is recorded at all here (sampling 0, retention off), so only
	// the sampler sees Next's spans start.
	const script = `
		import { createRequire } from "node:module";
		import { context, trace } from "@opentelemetry/api";
		import { initAutterServer } from "./dist/index.js";
		const require = createRequire(import.meta.url);
		const sdk = initAutterServer({
			apiKey: "k", service: "unsampled", endpoint: process.env.ENDPOINT, traceSampleRate: 0,
			retainTracesOnError: false, captureGlobalErrors: false, autoFlush: false, memoryMetrics: false,
			compatCheck: false, metricIntervalMs: 3_600_000, logging: { console: false },
		});
		const http = require("http");
		const server = http.createServer((req, res) => {
			const span = trace.getTracer("next.js").startSpan("executing api route (app) /api/items/[id]", {
				attributes: { "next.span_type": "AppRouteRouteHandlers.runHandler", "next.route": "/api/items/[id]" },
			});
			if (span.isRecording()) throw new Error("expected an unrecorded span");
			span.end();
			res.end("ok");
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		await new Promise((resolve, reject) => http.get("http://127.0.0.1:" + server.address().port + "/api/items/7", (r) => { r.resume(); r.on("end", resolve); }).on("error", reject));
		server.close();
		await sdk.shutdown();
	`;
	const before = bodies["/v1/metrics"].length;
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			cwd: join(here, ".."),
			env: { ...process.env, ENDPOINT: endpoint },
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
	});
	const points = durationPoints(bodies["/v1/metrics"].slice(before)).filter((p) => p.resource["service.name"] === "unsampled");
	assert.deepEqual(points.map((p) => [p.attributes["http.route"], p.count]), [["/api/items/[id]", 1]]);
});

test("a server created before initAutterServer (Next.js) still gets request spans and metrics", async () => {
	// Next creates its server before instrumentation.ts runs; nothing in this
	// process requires `http` after the SDK starts.
	const script = `
		import { createRequire } from "node:module";
		import { context, trace } from "@opentelemetry/api";
		const require = createRequire(import.meta.url);
		const http = require("http");
		const server = http.createServer((req, res) => {
			trace.getTracer("next.js").startSpan("render route (app) /blog/[slug]", {
				attributes: { "next.span_type": "AppRender.getBodyResult", "next.route": "/blog/[slug]" },
			}).end();
			res.end("ok");
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { initAutterServer } = await import("./dist/index.js");
		const sdk = initAutterServer({
			apiKey: "k", service: "early-server", endpoint: process.env.ENDPOINT, traceSampleRate: 1,
			captureGlobalErrors: false, autoFlush: false, memoryMetrics: false,
			compatCheck: false, metricIntervalMs: 3_600_000, logging: { console: false },
		});
		const res = await fetch("http://127.0.0.1:" + server.address().port + "/blog/hello-world");
		await res.text();
		server.close();
		await sdk.shutdown();
	`;
	const metricsBefore = bodies["/v1/metrics"].length;
	const tracesBefore = bodies["/v1/traces"].length;
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			cwd: join(here, ".."),
			env: { ...process.env, ENDPOINT: endpoint },
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
	});
	const points = durationPoints(bodies["/v1/metrics"].slice(metricsBefore)).filter((p) => p.resource["service.name"] === "early-server");
	assert.deepEqual(points.map((p) => [p.attributes["http.route"], p.count]), [["/blog/[slug]", 1]]);
	const spans = serverSpans(bodies["/v1/traces"].slice(tracesBefore)).filter((s) => s.resource["service.name"] === "early-server");
	assert.equal(spans.length, 1);
	assert.equal(spans[0].attributes["http.route"], "/blog/[slug]");
	assert.equal(spans[0].attributes["autter.metric_has_route"], true);
});
