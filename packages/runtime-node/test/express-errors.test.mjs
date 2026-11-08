// Express errors with no error middleware from Autter: initAutterServer +
// autterRequests only (the minimal setup), on Express 4 and Express 5, end
// to end through the real HTTP instrumentation, the OTLP export and the
// ingester's normaliser. Each error behind a 5xx must arrive as one
// occurrence with its type, message, real stack, route and request id —
// never as a stackless "GET /x returned 500" HttpServerError — and a
// floating promise that rejects after the response must keep its route and
// request id.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import express4 from "express";
import express5 from "express5";
import { normalizeTraces } from "../../otlp-ingester/dist/normalize-otlp.js";
import { autterErrorHandler, autterRequests, captureException, initAutterServer } from "../dist/index.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const traceBodies = [];
let collector;
let collectorPort;
let sdk;
const servers = [];

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
	collectorPort = collector.address().port;
	sdk = initAutterServer({
		apiKey: "test-key",
		service: "express-errors",
		endpoint: `http://127.0.0.1:${collectorPort}`,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		metricIntervalMs: 3_600_000,
		logging: { console: false },
	});
	require("http");
});

after(async () => {
	await Promise.all(servers.map((close) => close()));
	await new Promise((resolve) => {
		collector.close(resolve);
		collector.closeAllConnections();
	});
});

async function listen(app) {
	const server = require("http").createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(
		() =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	);
	return `http://127.0.0.1:${server.address().port}`;
}

/** The app every Express major gets: the minimal setup, no autterErrorHandler. */
function buildApp(express, prefix) {
	const app = express();
	app.use(autterRequests());
	app.get(`${prefix}/orders/:id/sync`, function syncThrowHandler() {
		throw new TypeError("cannot read properties of undefined (reading 'total')");
	});
	app.get(`${prefix}/orders/:id/next`, function nextErrorHandler(_req, _res, next) {
		next(new RangeError("order search failed"));
	});
	app.get(`${prefix}/orders/:id/not-found`, (_req, _res, next) => {
		next(Object.assign(new Error("no such order"), { status: 404 }));
	});
	app.get(`${prefix}/orders/:id/already-captured`, function capturedHandler(_req, _res, next) {
		const error = new Error("captured by the handler");
		captureException(error);
		next(error);
	});
	if (express === express5) {
		app.get(`${prefix}/orders/:id/async`, async function asyncThrowHandler() {
			await new Promise((resolve) => setTimeout(resolve, 5));
			throw new SyntaxError("bad search query");
		});
	}
	// A router with its own error handler: errors never reach the app level.
	const billing = express.Router();
	billing.get("/invoices/:invoice", function nestedThrowHandler() {
		throw new EvalError("invoice renderer crashed");
	});
	billing.get("/invoices/:invoice/validation", () => {
		throw new Error("invoice number is malformed");
	});
	billing.use((error, _req, res, _next) => {
		const validation = /malformed/.test(error.message);
		res.status(validation ? 400 : 500).json({ error: validation ? "bad invoice" : "billing failed" });
	});
	app.use(`${prefix}/billing`, billing);
	// A second router that also mounts autterErrorHandler: still one report.
	const accounts = express.Router();
	accounts.get("/accounts/:id", function accountsThrowHandler() {
		throw new Error("accounts backend down");
	});
	accounts.use(autterErrorHandler());
	accounts.use((_error, _req, res, _next) => res.status(503).send("accounts unavailable"));
	app.use(prefix, accounts);
	// No app-level error handler: finalhandler answers the rest with 500.
	return app;
}

const requestIds = new Map();
async function hit(url, path, expectStatus) {
	const response = await fetch(`${url}${path}`);
	assert.equal(response.status, expectStatus, path);
	await response.text();
	const requestId = response.headers.get("x-request-id");
	assert.ok(requestId, `${path}: x-request-id echoed`);
	requestIds.set(path, requestId);
}

const runs = {};
for (const [name, express, prefix] of [
	["Express 4", express4, "/e4"],
	["Express 5", express5, "/e5"],
]) {
	test(`${name}: requests that fail (the app's behaviour is unchanged)`, async () => {
		const url = await listen(buildApp(express, prefix));
		await hit(url, `${prefix}/orders/1/sync`, 500);
		await hit(url, `${prefix}/orders/2/next`, 500);
		await hit(url, `${prefix}/orders/3/not-found`, 404);
		await hit(url, `${prefix}/orders/4/already-captured`, 500);
		if (express === express5) await hit(url, `${prefix}/orders/5/async`, 500);
		await hit(url, `${prefix}/billing/invoices/6`, 500);
		await hit(url, `${prefix}/billing/invoices/7/validation`, 400);
		await hit(url, `${prefix}/accounts/8`, 503);
		const body = await (await fetch(`${url}${prefix}/billing/invoices/9`)).json();
		assert.deepEqual(body, { error: "billing failed" }, "the router's own error handler still answers");
		runs[name] = true;
	});
}

let exported;
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
		exceptions: (server[0].events ?? []).filter((event) => event.name === "exception"),
		occurrences: exported.occurrences.filter((occurrence) => occurrence.traceId === traceId),
	};
}

function assertOccurrence(result, path, { type, message, frame, route, status = 500 }) {
	assert.equal(result.exceptions.length, 1, `${path}: one exception event on the request span`);
	assert.equal(
		result.occurrences.length,
		1,
		`${path}: ${JSON.stringify(result.occurrences.map((o) => `${o.errorType}: ${o.message}`))}`,
	);
	const [occurrence] = result.occurrences;
	assert.equal(occurrence.errorType, type, path);
	assert.equal(occurrence.message, message, path);
	assert.match(occurrence.stack ?? "", new RegExp(`at (?:\\S+\\.)?${frame} `), `${path}: the throwing handler's frame`);
	assert.match(occurrence.stack ?? "", /express-errors\.test\.mjs/, path);
	assert.equal(occurrence.route, route, `${path}: route`);
	assert.equal(occurrence.statusCode, status, path);
	assert.equal(occurrence.requestId, requestIds.get(path), `${path}: request id`);
}

describe("exported: every 5xx carries its error", () => {
	for (const [name, prefix, async] of [
		["Express 4", "/e4", false],
		["Express 5", "/e5", true],
	]) {
		test(`${name}: sync throw, next(err), async throw, nested router — type, message, stack, route, request id`, async () => {
			assert.ok(runs[name], `${name} requests ran`);
			const sync = `${prefix}/orders/1/sync`;
			assertOccurrence(await exportedFor(sync), sync, {
				type: "TypeError",
				message: "cannot read properties of undefined (reading 'total')",
				frame: "syncThrowHandler",
				route: `${prefix}/orders/:id/sync`,
			});
			const next = `${prefix}/orders/2/next`;
			assertOccurrence(await exportedFor(next), next, {
				type: "RangeError",
				message: "order search failed",
				frame: "nextErrorHandler",
				route: `${prefix}/orders/:id/next`,
			});
			if (async) {
				const path = `${prefix}/orders/5/async`;
				assertOccurrence(await exportedFor(path), path, {
					type: "SyntaxError",
					message: "bad search query",
					frame: "asyncThrowHandler",
					route: `${prefix}/orders/:id/async`,
				});
			}
			const nested = `${prefix}/billing/invoices/6`;
			assertOccurrence(await exportedFor(nested), nested, {
				type: "EvalError",
				message: "invoice renderer crashed",
				frame: "nestedThrowHandler",
				route: `${prefix}/billing/invoices/:invoice`,
			});
			// The router mounts autterErrorHandler too: reported once.
			const accounts = `${prefix}/accounts/8`;
			assertOccurrence(await exportedFor(accounts), accounts, {
				type: "Error",
				message: "accounts backend down",
				frame: "accountsThrowHandler",
				route: `${prefix}/accounts/:id`,
				status: 503,
			});
			// Already captured by the handler: once.
			const captured = await exportedFor(`${prefix}/orders/4/already-captured`);
			assert.equal(captured.exceptions.length, 1);
			assert.equal(captured.occurrences.length, 1);
			// Answered with a 4xx: nothing reported.
			for (const path of [`${prefix}/orders/3/not-found`, `${prefix}/billing/invoices/7/validation`]) {
				const result = await exportedFor(path).catch(() => null);
				if (result) {
					assert.equal(result.exceptions.length, 0, path);
					assert.equal(result.occurrences.length, 0, path);
				}
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Rejections outside the request's error path (child processes: they crash)
// ---------------------------------------------------------------------------

const fixture = path.join(here, "fixtures", "express-late-rejection.mjs");

function runFixture({ express, env = {}, requests }) {
	const { NODE_OPTIONS: _ignored, ...base } = process.env;
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [fixture], {
			env: { ...base, COLLECTOR_PORT: String(collectorPort), EXPRESS: express, ...env },
			stdio: "pipe",
		});
		let out = "";
		let err = "";
		const responses = [];
		let started = false;
		child.stdout.on("data", async (d) => {
			out += d;
			const port = /PORT (\d+)/.exec(out)?.[1];
			if (!port || started) return;
			started = true;
			for (const path of requests) {
				try {
					const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) });
					responses.push({ path, status: response.status, requestId: response.headers.get("x-request-id") });
					await response.text();
				} catch {
					responses.push({ path, status: 0, requestId: null });
				}
			}
		});
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => resolve({ code, out, err, responses }));
	});
}

function occurrencesFor(service) {
	return traceBodies
		.filter((body) =>
			body.resourceSpans?.some((rs) =>
				rs.resource?.attributes?.some((a) => a.key === "service.name" && a.value?.stringValue === service),
			),
		)
		.flatMap((body) => normalizeTraces(body).occurrences)
		.filter((occurrence) => occurrence.service === service);
}

describe("rejections that escape the request keep its route and request id", () => {
	for (const express of ["express", "express5"]) {
		test(`${express}: a floating promise rejecting after the response crashes the process, recorded with route and request id`, async () => {
			const service = `late-crash-${express}`;
			const run = await runFixture({ express, env: { SERVICE: service }, requests: ["/orders/42"] });
			assert.equal(run.code, 1, `the process still crashes as it would without Autter\n${run.err}`);
			assert.doesNotMatch(run.out, /survived/);
			const [response] = run.responses;
			assert.equal(response.status, 200);
			const [occurrence, ...rest] = occurrencesFor(service);
			assert.equal(rest.length, 0, JSON.stringify(occurrencesFor(service).map((o) => o.message)));
			assert.equal(occurrence.errorType, "TypeError");
			assert.equal(occurrence.message, "audit failed for order 42");
			assert.equal(occurrence.severity, "fatal");
			assert.match(occurrence.stack ?? "", /auditOrder/);
			assert.equal(occurrence.route, "/orders/:id");
			assert.equal(occurrence.method, "GET");
			assert.equal(occurrence.requestId, response.requestId);
		});

		test(`${express}: the same rejection with an app listener (no crash) keeps route and request id`, async () => {
			const service = `late-listener-${express}`;
			const run = await runFixture({ express, env: { SERVICE: service, APP_LISTENER: "log" }, requests: ["/orders/7"] });
			assert.equal(run.code, 0, run.err);
			assert.match(run.out, /app listener: audit failed for order 7/);
			const [response] = run.responses;
			const occurrences = occurrencesFor(service);
			assert.equal(occurrences.length, 1, JSON.stringify(occurrences.map((o) => o.message)));
			const [occurrence] = occurrences;
			assert.equal(occurrence.severity, "error");
			assert.equal(occurrence.message, "audit failed for order 7");
			assert.equal(occurrence.route, "/orders/:id");
			assert.equal(occurrence.requestId, response.requestId);
		});
	}

	test("Express 4: an async handler that throws (Express 4 ignores the promise) crashes as before, recorded with route and request id", async () => {
		const service = "async-crash-express4";
		const run = await runFixture({ express: "express", env: { SERVICE: service }, requests: ["/carts/9"] });
		assert.equal(run.code, 1, run.err);
		const occurrences = occurrencesFor(service);
		assert.equal(occurrences.length, 1, JSON.stringify(occurrences.map((o) => o.message)));
		const [occurrence] = occurrences;
		assert.equal(occurrence.errorType, "RangeError");
		assert.equal(occurrence.message, "cart lookup failed");
		assert.equal(occurrence.severity, "fatal");
		assert.match(occurrence.stack ?? "", /asyncThrowHandler/);
		assert.equal(occurrence.route, "/carts/:id");
		assert.match(occurrence.requestId ?? "", /^[\w.-]{8,128}$/, "the request's id (the response never came)");
	});
});
