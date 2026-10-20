// EI-11: a browser request's W3C traceparent is continued by the server, so
// a browser error and the server spans (and error) of the same request share
// one trace id. The relay keeps the browser event's trace id.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { initAutterServer, sanitizeBrowserPayload } from "../dist/index.js";

const TRACE_OK = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACE_FAIL = "0af7651916cd43dd8448eb211c80319c";
const BROWSER_SPAN = "00f067aa0ba902b7";

test("the relay forwards a valid browser trace id and drops a malformed one", () => {
	const event = (traceId) => ({ type: "exception", timestamp: new Date().toISOString(), message: "m", traceId });
	const payload = sanitizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "production",
		events: [event(TRACE_OK), event(TRACE_OK.toUpperCase()), event("0".repeat(32)), event("abc"), event(7), event(undefined)],
	});
	assert.deepEqual(payload.events.map((e) => e.traceId), [TRACE_OK, undefined, undefined, undefined, undefined, undefined]);
});

test("server spans and the server error continue the browser's unsampled traceparent", async () => {
	const bodies = [];
	const collector = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (req.url === "/v1/traces") bodies.push(JSON.parse(body));
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	const sdk = initAutterServer({
		service: "api",
		apiKey: "k",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		traceSampleRate: 1,
		logging: { console: false },
	});
	// Loaded after init so the HTTP instrumentation patches it.
	const http = createRequire(import.meta.url)("node:http");
	const server = http.createServer((req, res) => {
		if (req.url === "/fail") {
			sdk.captureException(new Error("server boom"));
			res.statusCode = 500;
		}
		res.end("done");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		// The browser sends unsampled parents (-00): it makes no sampling decision.
		for (const [path, trace] of [["/ok", TRACE_OK], ["/fail", TRACE_FAIL]]) {
			const res = await fetch(`${base}${path}`, { headers: { traceparent: `00-${trace}-${BROWSER_SPAN}-00` } });
			await res.text();
		}
	} finally {
		await new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		});
		await sdk.shutdown();
		await new Promise((resolve) => {
			collector.close(resolve);
			collector.closeAllConnections();
		});
	}
	const spans = bodies.flatMap((body) =>
		(body.resourceSpans ?? []).flatMap((rs) => (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? [])),
	);
	const serverSpan = (trace) => spans.find((span) => span.traceId === trace && span.parentSpanId === BROWSER_SPAN);
	// A healthy browser-initiated request is head-sampled at the service's own
	// rate (1 here) instead of never: the unsampled parent is not a "no".
	assert.ok(serverSpan(TRACE_OK), `no server span continued ${TRACE_OK}: ${JSON.stringify(spans.map((s) => [s.name, s.traceId]))}`);
	// The failing request's server span carries the exception, on the browser's trace.
	const failed = serverSpan(TRACE_FAIL);
	assert.ok(failed, "no server span continued the failing request's trace");
	const exceptions = spans.filter((span) => span.traceId === TRACE_FAIL).flatMap((span) => span.events ?? []).filter((e) => e.name === "exception");
	assert.ok(exceptions.length > 0, "the server error was not recorded on the browser's trace");
	assert.match(JSON.stringify(exceptions), /server boom/);
});
