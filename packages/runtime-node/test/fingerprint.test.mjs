import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import { captureException, initAutterServer, sanitizeBrowserPayload } from "../dist/index.js";
import { captureRuntime } from "../dist/testing.js";

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
	return {
		endpoint: `http://127.0.0.1:${server.address().port}`,
		spans: () =>
			requests
				.filter((r) => r.path === "/v1/traces")
				.flatMap((r) => r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))),
		close: () =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	};
}
const attrs = (list = []) =>
	Object.fromEntries(list.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.boolValue ?? a.value.arrayValue]));

test("captureException sends `fingerprint` as autter.fingerprint on the exception event, never as a span attribute", async () => {
	const c = await collector();
	const sdk = initAutterServer({
		service: "payments-api",
		apiKey: "k",
		endpoint: c.endpoint,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		logging: { console: false },
	});
	const runtime = captureRuntime();
	try {
		captureException(new Error("card timeout after 3000ms"), { fingerprint: ["checkout", "card-timeout"], step: "pay" });
		captureException(new Error("chunk 12 failed"), { fingerprint: "chunk-load" });
		captureException(new Error("token sk-abcdefghijklmnopqrstuvwxyz leaked"), {
			fingerprint: ["sk-abcdefghijklmnopqrstuvwxyz", "x".repeat(500), ...Array.from({ length: 12 }, (_, i) => `v${i}`)],
		});
		captureException(new Error("plain"), { step: "pay" });
		// Inside a live request-like span the override stays on the event.
		await trace.getTracer("test").startActiveSpan("POST /pay", async (span) => {
			captureException(new Error("in request"), { fingerprint: "request-level" });
			span.end();
		});
		await sdk.shutdown();
		const spans = c.spans();
		const byMessage = (message) => {
			const span = spans.find((s) => s.events?.some((e) => e.name === "exception" && attrs(e.attributes)["exception.message"] === message));
			assert.ok(span, message);
			return { span: attrs(span.attributes), event: attrs(span.events.find((e) => e.name === "exception").attributes) };
		};
		const listed = byMessage("card timeout after 3000ms");
		assert.equal(listed.event["autter.fingerprint"], '["checkout","card-timeout"]');
		assert.equal(listed.span.step, "pay");
		assert.equal("fingerprint" in listed.span, false);
		assert.equal("autter.fingerprint" in listed.span, false);
		assert.equal(byMessage("chunk 12 failed").event["autter.fingerprint"], '["chunk-load"]');
		const bounded = JSON.parse(byMessage("token [redacted] leaked").event["autter.fingerprint"]);
		assert.equal(bounded.length, 10, "at most 10 values");
		assert.equal(bounded[0], "[redacted]", "values are scrubbed");
		assert.equal(bounded[1].length, 200, "each value is cut to 200 chars");
		assert.equal(byMessage("plain").event["autter.fingerprint"], undefined);
		const inRequest = byMessage("in request");
		assert.equal(inRequest.event["autter.fingerprint"], '["request-level"]');
		assert.equal("autter.fingerprint" in inRequest.span, false, "never sticks to the reused span");
		// Test sinks see it too, so apps can assert their grouping.
		assert.equal(runtime.exceptions[0].attributes["autter.fingerprint"], '["checkout","card-timeout"]');
		assert.equal("fingerprint" in runtime.exceptions[0].attributes, false);
	} finally {
		runtime.stop();
		await c.close();
	}
});

test("the browser relay passes `fingerprint` through, scrubbed and bounded", () => {
	const now = new Date().toISOString();
	const payload = sanitizeBrowserPayload({
		version: 1,
		service: "web",
		environment: "production",
		events: [
			{ type: "exception", timestamp: now, message: "a", fingerprint: "chunk-load" },
			{ type: "exception", timestamp: now, message: "b", fingerprint: ["checkout", "ada@example.com", 42, "y".repeat(400)] },
			{ type: "exception", timestamp: now, message: "c", fingerprint: { nope: true } },
			{ type: "exception", timestamp: now, message: "d" },
		],
	});
	const [single, listed, bad, none] = payload.events;
	assert.equal(single.fingerprint, "chunk-load");
	assert.deepEqual(listed.fingerprint.slice(0, 2), ["checkout", "[redacted]"]);
	assert.equal(listed.fingerprint.length, 3);
	assert.equal(listed.fingerprint[2].length, 200);
	assert.equal("fingerprint" in bad, false);
	assert.equal("fingerprint" in none, false);
});
