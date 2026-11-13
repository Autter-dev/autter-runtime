import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { initAutterServer, instrumentLlmClient } from "../dist/index.js";

// The exporter scrubs every span attribute on the way out ("token" is a
// sensitive key pattern): the cache and reasoning counts must survive it.
test("cache, reasoning and convention attributes reach the OTLP exporter unmasked", async () => {
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
	const sdk = initAutterServer({
		service: "llm",
		apiKey: "k",
		endpoint: `http://127.0.0.1:${server.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		logging: { console: false },
	});
	try {
		class Anthropic {
			messages = {
				create: async () => ({
					type: "message",
					model: "claude-sonnet-4-5-20250929",
					usage: {
						input_tokens: 1000,
						cache_read_input_tokens: 4000,
						cache_creation_input_tokens: 5000,
						cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 2000 },
						output_tokens: 500,
						output_tokens_details: { thinking_tokens: 200 },
					},
				}),
			};
		}
		const anthropic = instrumentLlmClient(new Anthropic());
		await anthropic.messages.create({ model: "claude-sonnet-4-5", messages: [] });
		await sdk.shutdown();
		const spans = requests
			.filter((r) => r.path === "/v1/traces")
			.flatMap((r) => r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
		const span = spans.find((s) => s.name === "chat claude-sonnet-4-5");
		assert.ok(span, "the LLM span was exported");
		const attrs = Object.fromEntries(
			span.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue]),
		);
		const n = (key) => Number(attrs[key]);
		assert.equal(n("gen_ai.usage.input_tokens"), 10000);
		assert.equal(n("gen_ai.usage.output_tokens"), 500);
		assert.equal(n("gen_ai.usage.cache_read.input_tokens"), 4000);
		assert.equal(n("gen_ai.usage.cache_creation.input_tokens"), 5000);
		assert.equal(n("autter.llm.cache_creation.long_ttl_tokens"), 2000);
		assert.equal(n("gen_ai.usage.reasoning.output_tokens"), 200);
		assert.equal(attrs["autter.llm.usage_convention"], "total");
	} finally {
		await new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		});
	}
});
