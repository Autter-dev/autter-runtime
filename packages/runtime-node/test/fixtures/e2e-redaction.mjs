// Child fixture: FULL pipeline e2e — initAutterServer against the parent's
// local collector, capture exceptions full of PII/secrets (in attributes,
// messages, stacks, third-party spans), then SIGTERM. Auto-flush must push
// the redacted spans out before the process dies.
import { trace } from "@opentelemetry/api";
import { initAutterServer } from "../../dist/index.js";

const autter = initAutterServer({
	endpoint: `http://127.0.0.1:${process.env.COLLECTOR_PORT}`,
	apiKey: "autter_rt_e2e",
	service: "e2e-redaction",
	environment: "test",
	metricIntervalMs: 3_600_000, // keep metric noise out of this test
	traceSampleRate: 1,
	redactAttributes: { additionalValuePatterns: [/CUST-\d{6}/] },
});

// Fake secrets assembled from fragments so repo secret scanners stay quiet.
const STRIPE = ["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");

setTimeout(async () => {
	autter.captureException(new Error("boom: order failed"), {
		"order.id": "o-1",
		"user.email": "jane.doe@example.com",
		auth: "Bearer supersecrettoken123456",
		"context.jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpM",
		// (OTel drops object-valued attributes on its own; redaction must
		// still never pass the raw cookie through.)
		request: { headers: { cookie: "sid=rawcookievalue" } },
	});

	// The classic leak: a secret inside the error MESSAGE (and so the stack).
	autter.captureException(
		new Error("connect ECONNREFUSED postgres://admin:hunter2pg@db.internal:5432/app"),
	);
	autter.captureMessage(`charge failed for card 4111 1111 1111 1111 key ${STRIPE}`, "warning");
	autter.captureException(new Error("lookup failed for CUST-123456"));

	// A process span whose thrown error carries a secret.
	await autter
		.withProcessSpan("nightly-sync", () => {
			throw new Error("redis://:redispass99@cache:6379 refused");
		})
		.catch(() => {});

	// LLM provider error echoing a key.
	await autter
		.withLlmCall({ provider: "openai", model: "gpt-x" }, (llm) => {
			llm.setAttributes({ "gen_ai.request.api_key": "should-not-leak", note: "ok" });
			throw new Error("401 Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz0123");
		})
		.catch(() => {});

	// Spans written by someone else (an instrumentation or the app itself
	// via the global tracer): only export-time scrubbing can catch these.
	const foreign = trace.getTracer("third-party").startSpan("GET /callback");
	foreign.setAttributes({
		"http.url": "https://app.example.test/callback?code=abc&access_token=foreigntoken123&page=2",
		"http.request.header.authorization": ["Bearer foreignbearer12345"],
		"ai.usage.promptTokens": 42,
	});
	foreign.recordException(new Error("upstream said password=foreignpw1 for x"));
	foreign.addEvent("retry with Bearer eventnamesecret1234");
	foreign.end();
	// Link attributes are serialised with the span too.
	trace
		.getTracer("third-party")
		.startSpan("consume", {
			links: [{ context: foreign.spanContext(), attributes: { note: "Bearer linkbearersecret123" } }],
		})
		.end();

	setTimeout(() => {
		process.kill(process.pid, "SIGTERM");
	}, 100);
}, 30);
