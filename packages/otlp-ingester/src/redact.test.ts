import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { sanitizeRuntimeContext } from "./context.js";
import { configureRedaction, scrubText } from "./redact.js";
import { createIngesterApp } from "./server.js";

/**
 * Server-side scrubbing is the backstop for senders that don't scrub (old
 * SDKs, plain OTel SDKs in any language). Vectors are shared with the Node
 * SDK, browser SDK and Python adapter (test-vectors/redaction.json).
 */

interface Vector {
	name: string;
	input: string | string[];
	expect: string | string[];
	skip?: string[];
}
const vectors = JSON.parse(
	readFileSync(new URL("../../../test-vectors/redaction.json", import.meta.url), "utf8"),
) as { text: Vector[]; keys: { sensitive: string[]; safe: string[] } };
const join = (value: string | string[]) => (Array.isArray(value) ? value.join("") : value);

for (const vector of vectors.text) {
	if (vector.skip?.includes("ingester")) continue;
	test(`scrubText vector: ${vector.name}`, () => {
		assert.equal(scrubText(join(vector.input)), join(vector.expect));
	});
}

test("sensitive keys are masked at any depth; safe keys survive", () => {
	for (const key of vectors.keys.sensitive) {
		const out = sanitizeRuntimeContext({ outer: { list: [{ [key]: "raw" }] } }) as any;
		assert.equal(out.outer.list[0][key], "[redacted]", key);
	}
	for (const key of vectors.keys.safe) {
		const out = sanitizeRuntimeContext({ outer: { [key]: "kept" } }) as any;
		assert.equal(out.outer[key], "kept", key);
	}
});

test("operator-supplied patterns extend the built-ins", () => {
	configureRedaction({ redactValuePatterns: ["EMP-\\d{4}"], redactKeyPatterns: ["^tenant_ref$"] });
	try {
		assert.equal(scrubText("employee EMP-1234 and EMP-9999"), "employee [redacted] and [redacted]");
		assert.deepEqual(sanitizeRuntimeContext({ tenant_ref: "t1", plan: "pro" }), {
			tenant_ref: "[redacted]",
			plan: "pro",
		});
	} finally {
		configureRedaction({});
	}
});

// ---------------------------------------------------------------------------
// Over the wire: an unscrubbing OTLP sender → ingester → ClickHouse + sink.
// Nothing secret may reach either.
// ---------------------------------------------------------------------------

let chStub: Server;
let sinkServer: Server;
let appServer: Server;
let ingestUrl: string;
const clickhouseBodies: string[] = [];
const sinkBodies: string[] = [];

before(async () => {
	chStub = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			clickhouseBodies.push(`${req.url}\n${body}`);
			res.writeHead(200).end();
		});
	});
	await new Promise<void>((resolve) => chStub.listen(0, resolve));
	sinkServer = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			sinkBodies.push(body);
			res.writeHead(202).end();
		});
	});
	await new Promise<void>((resolve) => sinkServer.listen(0, resolve));
	const config: IngesterConfig = {
		port: 0,
		clickhouseUrl: `http://127.0.0.1:${(chStub.address() as AddressInfo).port}`,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [{ key: "test-key", orgId: "org-r", repositoryId: "repo-r" }],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: `http://127.0.0.1:${(sinkServer.address() as AddressInfo).port}/sink`,
		sinkToken: null,
		sinkMaxAttempts: 3,
		sinkMaxBufferedBatches: 10,
		sinkMaxBufferedMb: 1,
		maxBodyBytes: 1024 * 1024,
		rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
	};
	const { app } = createIngesterApp(config);
	appServer = app.listen(0);
	await new Promise((resolve) => appServer.once("listening", resolve));
	ingestUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

after(() => {
	appServer.close();
	chStub.close();
	sinkServer.close();
});

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const STRIPE = ["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("secrets from an unscrubbing OTLP sender never reach ClickHouse or the sink", async () => {
	const now = `${BigInt(Date.now()) * 1_000_000n}`;
	const res = await fetch(`${ingestUrl}/v1/traces`, {
		method: "POST",
		headers: { authorization: "Bearer test-key", "content-type": "application/json" },
		body: JSON.stringify({
			resourceSpans: [{
				resource: { attributes: [str("service.name", "py-worker")] },
				scopeSpans: [{
					spans: [
						{
							traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
							spanId: "00f067aa0ba902b7",
							name: "GET /reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpM",
							kind: 2,
							startTimeUnixNano: now,
							endTimeUnixNano: now,
							status: { code: 2, message: "psycopg2: postgres://admin:hunter2pg@db:5432/app" },
							attributes: [
								str("http.url", "https://api.test/cb?access_token=leakytoken99&page=2"),
								str("http.request.header.cookie", "sid=rawcookie42"),
							],
							events: [{
								name: "exception",
								timeUnixNano: now,
								attributes: [
									str("exception.type", "OperationalError"),
									str("exception.message", `stripe rejected ${STRIPE} for jane@example.com`),
									str("exception.stacktrace", 'Traceback (most recent call last):\n  File "/app/pay.py", line 9, in charge\n    stripe.api_key = "' + STRIPE + '"\nOperationalError: password=hunter3py'),
								],
							}],
						},
						{
							traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
							spanId: "00f067aa0ba902b8",
							name: "chat gpt-x",
							kind: 3,
							startTimeUnixNano: now,
							endTimeUnixNano: now,
							attributes: [
								str("gen_ai.system", "openai"),
								str("gen_ai.request.model", "gpt-x"),
								str("gen_ai.prompt", "summarise: my key is sk-proj-abcdefghijklmnopqrstuvwxyz0123"),
								{ key: "gen_ai.usage.input_tokens", value: { intValue: "321" } },
								str("enduser.id", "jane@example.com"),
							],
						},
					],
				}],
			}],
		}),
	});
	assert.equal(res.status, 200);
	await waitFor(() => sinkBodies.length > 0);

	const everything = [...clickhouseBodies, ...sinkBodies].join("\n");
	for (const secret of [
		"hunter2pg",
		"4eC39HqLyjWDarjtT1zdp7dc",
		"jane@example.com",
		"hunter3py",
		"leakytoken99",
		"rawcookie42",
		"eyJhbGciOiJIUzI1NiJ9",
		"abcdefghijklmnopqrstuvwxyz0123",
	]) {
		assert.ok(!everything.includes(secret), `secret reached storage/sink: ${secret}`);
	}
	// Useful context survives: error type, scrubbed message shape, stack
	// frames, and LLM token usage for cost tracking.
	assert.ok(everything.includes("OperationalError"));
	assert.ok(everything.includes("stripe rejected [redacted] for [redacted]"));
	assert.ok(everything.includes('File \\"/app/pay.py\\", line 9, in charge'));
	assert.match(everything, /321/);
});
