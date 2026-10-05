import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
	initAutterServer,
	withRuntimeOperation,
	runtimeLogger,
} from "../dist/index.js";
import { createIngesterApp } from "../../otlp-ingester/dist/server.js";
const close = (server) =>
	new Promise((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});

test("customer SDK operations survive the ingester and ClickHouse write boundary", async () => {
	const inserts = [];
	const ch = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const query =
				new URL(req.url, "http://localhost").searchParams.get("query") ?? "";
			if (query.includes("INSERT INTO") && query.includes("runtime_logs"))
				inserts.push(...body.trim().split("\n").map(JSON.parse));
			res.end();
		});
	});
	await new Promise((resolve) => ch.listen(0, "127.0.0.1", resolve));
	const { app } = createIngesterApp({
		port: 0,
		clickhouseUrl: `http://127.0.0.1:${ch.address().port}`,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [
			{ key: "test-server", orgId: "org-sdk", repositoryId: "repo-sdk" },
		],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: null,
		sinkToken: null,
		maxBodyBytes: 1048576,
		rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
	});
	const ingester = app.listen(0);
	await new Promise((resolve) => ingester.once("listening", resolve));
	const runtime = initAutterServer({
		service: "checkout-api",
		environment: "test",
		release: "abc123",
		apiKey: "test-server",
		endpoint: `http://127.0.0.1:${ingester.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		logging: { console: false, minLevel: "error" },
	});
	try {
		const attrs = Object.fromEntries(
			Array.from({ length: 200 }, (_, i) => [`custom.${i}`, i]),
		);
		await withRuntimeOperation("checkout", async (operation) => {
			operation.setContext({
				payment: { provider: "stripe" },
				...attrs,
				token: "secret-token",
				"autter.operation.id": "spoofed",
			});
			operation.setContext({ payment: { attempts: 2 } });
			await operation.step("reserve", async () => true);
			runtimeLogger.info("filtered message");
			operation.outcome("failed", "Payment not confirmed");
		});
		await runtime.shutdown();
		assert.equal(
			inserts.length,
			1,
			"operation summary survives minLevel filtering",
		);
		const summary = inserts[0];
		const context = JSON.parse(summary.attributes);
		assert.equal(summary.org_id, "org-sdk");
		assert.equal(summary.repository_id, "repo-sdk");
		assert.equal(summary.operation, "checkout");
		assert.equal(summary.outcome, "failed");
		assert.deepEqual(context.payment, { provider: "stripe", attempts: 2 });
		assert.notEqual(summary.operation_id, "spoofed");
		assert.match(summary.trace_id, /^[a-f0-9]{32}$/);
		assert.equal(context["autter.operation.steps"][0].name, "reserve");
		assert.equal(JSON.stringify(summary).includes("secret-token"), false);
	} finally {
		await close(ingester);
		await close(ch);
	}
});
