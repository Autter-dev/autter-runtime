import assert from "node:assert/strict";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	instrumentLlmClient,
	trackLlmCall,
	withLlmCall,
	withRuntimeOperation,
} from "../dist/index.js";
import { captureRuntime, expectOperation } from "../dist/testing.js";

// No initAutterServer: autterLlmTracer() falls back to the global provider,
// so an in-memory exporter sees every LLM span with its raw attributes.
const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
	new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

const USAGE_KEYS = /^(gen_ai\.usage\.|gen_ai\.response\.model|gen_ai\.provider\.name|autter\.llm\.)/;

/** The last span's usage attributes, the operation rollup, and the span. */
async function capture(name, fn) {
	exporter.reset();
	const runtime = captureRuntime();
	try {
		await withRuntimeOperation(name, fn);
		const spans = exporter.getFinishedSpans();
		assert.equal(spans.length, 1, `one LLM span for ${name}`);
		const span = spans[0];
		const attrs = Object.fromEntries(
			Object.entries(span.attributes).filter(([key]) => USAGE_KEYS.test(key)),
		);
		const summary = expectOperation(runtime, name);
		return { attrs, ai: summary.attributes["autter.operation.ai"], span };
	} finally {
		runtime.stop();
	}
}

async function* gen(items) {
	for (const item of items) yield item;
}

// ---------------------------------------------------------------- OpenAI ---

class OpenAI {
	baseURL = "https://api.openai.com/v1";
	chat = {
		completions: {
			create: async (req) =>
				req.stream
					? gen([
							{ model: "gpt-4o-2024-08-06", choices: [{ delta: { content: "hi" } }], usage: null },
							{
								model: "gpt-4o-2024-08-06",
								choices: [],
								usage: {
									prompt_tokens: 10000,
									completion_tokens: 500,
									total_tokens: 10500,
									prompt_tokens_details: { cached_tokens: 9000 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							},
						])
					: {
							model: "gpt-4o-2024-08-06",
							usage: {
								prompt_tokens: 10000,
								completion_tokens: 500,
								total_tokens: 10500,
								prompt_tokens_details: { cached_tokens: 9000, cache_write_tokens: 600, audio_tokens: 0 },
								completion_tokens_details: { reasoning_tokens: 120 },
							},
						},
		},
	};
	responses = {
		create: async (req) =>
			req.stream
				? gen([
						{ type: "response.created", response: { model: "gpt-5.6-terra", usage: null } },
						{ type: "response.output_text.delta", delta: "hi" },
						{ type: "response.completed", response: { model: "gpt-5.6-terra", usage: RESPONSES_USAGE } },
					])
				: { model: "gpt-5.6-terra", usage: RESPONSES_USAGE },
	};
}

const RESPONSES_USAGE = {
	input_tokens: 12000,
	output_tokens: 500,
	total_tokens: 12500,
	input_tokens_details: {
		cached_tokens: 4000,
		cache_write_tokens: 7000,
		cache_write_tokens_details: { ttl_30m_tokens: 5000, ttl_12h_tokens: 2000 },
	},
	output_tokens_details: { reasoning_tokens: 300 },
};

test("OpenAI chat: prompt_tokens is already the total; cache read/write and reasoning are subsets", async () => {
	const openai = instrumentLlmClient(new OpenAI());
	const { attrs, ai } = await capture("openai-chat", () =>
		openai.chat.completions.create({ model: "gpt-4o", messages: [] }),
	);
	assert.deepEqual(attrs, {
		"gen_ai.provider.name": "openai",
		"autter.llm.usage_convention": "total",
		"gen_ai.usage.input_tokens": 10000,
		"gen_ai.usage.output_tokens": 500,
		"gen_ai.usage.cache_read.input_tokens": 9000,
		"gen_ai.usage.cache_creation.input_tokens": 600,
		"gen_ai.usage.reasoning.output_tokens": 120,
		"gen_ai.response.model": "gpt-4o-2024-08-06",
	});
	assert.equal(ai.input_tokens, 10000);
	assert.equal(ai.cache_read_tokens, 9000);
	assert.equal(ai.cache_write_tokens, 600);
	assert.deepEqual(ai.models, ["gpt-4o-2024-08-06"]);
});

test("OpenAI chat stream: usage from the include_usage chunk", async () => {
	const openai = instrumentLlmClient(new OpenAI());
	const { attrs, ai } = await capture("openai-chat-stream", async () => {
		const stream = await openai.chat.completions.create({
			model: "gpt-4o",
			messages: [],
			stream: true,
			stream_options: { include_usage: true },
		});
		for await (const _ of stream) {
			/* consume */
		}
	});
	assert.equal(attrs["gen_ai.usage.input_tokens"], 10000);
	assert.equal(attrs["gen_ai.usage.cache_read.input_tokens"], 9000);
	assert.equal(attrs["gen_ai.usage.reasoning.output_tokens"], 0);
	assert.equal(attrs["autter.llm.streamed"], true);
	assert.equal(ai.cache_read_tokens, 9000);
});

test("OpenAI Responses: input_tokens_details cache read, write and 12h split; reasoning", async () => {
	const openai = instrumentLlmClient(new OpenAI());
	const { attrs, ai } = await capture("openai-responses", () =>
		openai.responses.create({ model: "gpt-5.6-terra", input: "x" }),
	);
	assert.deepEqual(attrs, {
		"gen_ai.provider.name": "openai",
		"autter.llm.usage_convention": "total",
		"gen_ai.usage.input_tokens": 12000,
		"gen_ai.usage.output_tokens": 500,
		"gen_ai.usage.cache_read.input_tokens": 4000,
		"gen_ai.usage.cache_creation.input_tokens": 7000,
		"autter.llm.cache_creation.long_ttl_tokens": 2000,
		"gen_ai.usage.reasoning.output_tokens": 300,
		"gen_ai.response.model": "gpt-5.6-terra",
	});
	assert.equal(ai.input_tokens, 12000);
	assert.equal(ai.cache_write_tokens, 7000);
});

test("OpenAI Responses stream: usage from response.completed", async () => {
	const openai = instrumentLlmClient(new OpenAI());
	const { attrs } = await capture("openai-responses-stream", async () => {
		for await (const _ of await openai.responses.create({ model: "gpt-5.6-terra", input: "x", stream: true })) {
			/* consume */
		}
	});
	assert.equal(attrs["gen_ai.usage.input_tokens"], 12000);
	assert.equal(attrs["gen_ai.usage.output_tokens"], 500);
	assert.equal(attrs["gen_ai.usage.cache_read.input_tokens"], 4000);
	assert.equal(attrs["gen_ai.usage.cache_creation.input_tokens"], 7000);
	assert.equal(attrs["gen_ai.usage.reasoning.output_tokens"], 300);
	assert.equal(attrs["gen_ai.response.model"], "gpt-5.6-terra");
});

// ------------------------------------------------------------- Anthropic ---

const READ_USAGE = {
	input_tokens: 1000,
	cache_read_input_tokens: 9000,
	cache_creation_input_tokens: 0,
	cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
	output_tokens: 500,
	output_tokens_details: { thinking_tokens: 200 },
};
const WRITE_USAGE = {
	input_tokens: 1000,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 9000,
	cache_creation: { ephemeral_5m_input_tokens: 6000, ephemeral_1h_input_tokens: 3000 },
	output_tokens: 500,
};
const anthropicEvents = (usage) => [
	{
		type: "message_start",
		message: { type: "message", model: "claude-sonnet-4-5-20250929", usage: { ...usage, output_tokens: 1 } },
	},
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
	// Cumulative counters; the cache fields are null when they don't apply.
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: {
			output_tokens: usage.output_tokens,
			input_tokens: null,
			cache_read_input_tokens: null,
			cache_creation_input_tokens: null,
		},
	},
	{ type: "message_stop" },
];

/**
 * Mirrors @anthropic-ai/sdk's MessageStream: it reads the HTTP stream
 * eagerly from construction, emits `streamEvent` / `finalMessage` / `end`
 * (also after an error), surfaces an error with no listener as an unhandled
 * rejection, and may never be iterated (`await stream.finalMessage()`).
 */
class FakeMessageStream {
	#listeners = {};
	#done;
	#message;
	errored = false;
	constructor(events, failWith) {
		this.#done = new Promise((resolve, reject) => {
			setTimeout(() => {
				let snapshot;
				for (const event of events) {
					if (event.type === "message_start") snapshot = structuredClone(event.message);
					if (event.type === "message_delta") snapshot.usage.output_tokens = event.usage.output_tokens;
					this.#emit("streamEvent", event, snapshot);
				}
				if (failWith) {
					this.errored = true;
					this.#emit("end");
					reject(failWith);
					return;
				}
				this.#message = snapshot;
				this.#emit("finalMessage", snapshot);
				this.#emit("end");
				resolve();
			}, 0);
		});
		this.#done.catch(() => undefined);
	}
	#emit(event, ...args) {
		for (const listener of this.#listeners[event] ?? []) listener(...args);
	}
	on(event, listener) {
		(this.#listeners[event] ??= []).push(listener);
		return this;
	}
	async done() {
		await this.#done;
	}
	async finalMessage() {
		await this.#done;
		return this.#message;
	}
	async *[Symbol.asyncIterator]() {
		yield* [];
	}
}

class Anthropic {
	baseURL = "https://api.anthropic.com";
	messages = {
		create: async (req) =>
			req.stream
				? gen(anthropicEvents(req.usage))
				: { type: "message", model: "claude-sonnet-4-5-20250929", usage: req.usage },
		stream: (req) => new FakeMessageStream(anthropicEvents(req.usage), req.failWith),
	};
}

test("Anthropic cache read: input_tokens excludes the cache, so the total adds it", async () => {
	const anthropic = instrumentLlmClient(new Anthropic());
	const { attrs, ai } = await capture("anthropic-read", () =>
		anthropic.messages.create({ model: "claude-sonnet-4-5", messages: [], usage: READ_USAGE }),
	);
	assert.deepEqual(attrs, {
		"gen_ai.provider.name": "anthropic",
		"autter.llm.usage_convention": "total",
		"gen_ai.usage.input_tokens": 10000,
		"gen_ai.usage.output_tokens": 500,
		"gen_ai.usage.cache_read.input_tokens": 9000,
		"gen_ai.usage.cache_creation.input_tokens": 0,
		"autter.llm.cache_creation.long_ttl_tokens": 0,
		"gen_ai.usage.reasoning.output_tokens": 200,
		"gen_ai.response.model": "claude-sonnet-4-5-20250929",
	});
	assert.equal(ai.input_tokens, 10000);
	assert.equal(ai.cache_read_tokens, 9000);
});

test("Anthropic cache write: 5m/1h split, the 1h part as long_ttl_tokens", async () => {
	const anthropic = instrumentLlmClient(new Anthropic());
	const { attrs, ai } = await capture("anthropic-write", () =>
		anthropic.messages.create({ model: "claude-sonnet-4-5", messages: [], usage: WRITE_USAGE }),
	);
	assert.equal(attrs["gen_ai.usage.input_tokens"], 10000);
	assert.equal(attrs["gen_ai.usage.cache_read.input_tokens"], 0);
	assert.equal(attrs["gen_ai.usage.cache_creation.input_tokens"], 9000);
	assert.equal(attrs["autter.llm.cache_creation.long_ttl_tokens"], 3000);
	assert.equal(ai.cache_write_tokens, 9000);
	assert.equal(ai.input_tokens, 10000);
});

test("Anthropic create stream: message_start usage and model survive message_delta's null counters", async () => {
	const anthropic = instrumentLlmClient(new Anthropic());
	const { attrs } = await capture("anthropic-create-stream", async () => {
		for await (const _ of await anthropic.messages.create({
			model: "claude-sonnet-4-5",
			messages: [],
			stream: true,
			usage: READ_USAGE,
		})) {
			/* consume */
		}
	});
	assert.equal(attrs["gen_ai.usage.input_tokens"], 10000);
	assert.equal(attrs["gen_ai.usage.cache_read.input_tokens"], 9000);
	assert.equal(attrs["gen_ai.usage.output_tokens"], 500);
	assert.equal(attrs["gen_ai.response.model"], "claude-sonnet-4-5-20250929");
	assert.equal(attrs["autter.llm.streamed"], true);
});

test("Anthropic messages.stream() consumed only via finalMessage() still ends the span", async () => {
	const anthropic = instrumentLlmClient(new Anthropic());
	const { attrs, ai, span } = await capture("anthropic-final-message", async () => {
		const stream = anthropic.messages.stream({ model: "claude-sonnet-4-5", messages: [], usage: WRITE_USAGE });
		assert.ok(stream instanceof FakeMessageStream, "the helper is returned untouched");
		const message = await stream.finalMessage();
		assert.equal(message.usage.output_tokens, 500);
	});
	assert.equal(span.status.code, 1);
	assert.equal(attrs["gen_ai.usage.input_tokens"], 10000);
	assert.equal(attrs["gen_ai.usage.cache_creation.input_tokens"], 9000);
	assert.equal(attrs["autter.llm.cache_creation.long_ttl_tokens"], 3000);
	assert.equal(attrs["gen_ai.usage.output_tokens"], 500);
	assert.equal(attrs["gen_ai.response.model"], "claude-sonnet-4-5-20250929");
	assert.equal(ai.cache_write_tokens, 9000);
});

test("Anthropic messages.stream() failure ends the span as an error without adding an error listener", async () => {
	const anthropic = instrumentLlmClient(new Anthropic());
	const { span } = await capture("anthropic-stream-error", async () => {
		const stream = anthropic.messages.stream({
			model: "claude-sonnet-4-5",
			messages: [],
			usage: READ_USAGE,
			failWith: new Error("overloaded"),
		});
		await assert.rejects(stream.finalMessage(), /overloaded/);
	});
	assert.equal(span.status.code, 2);
});

// ---------------------------------------------------------------- Gemini ---

const GEMINI_USAGE = {
	promptTokenCount: 10000,
	cachedContentTokenCount: 9000,
	candidatesTokenCount: 500,
	thoughtsTokenCount: 1200,
	totalTokenCount: 11700,
};

class GoogleGenAI {
	models = {
		generateContent: async () => ({ modelVersion: "gemini-2.5-pro", usageMetadata: GEMINI_USAGE }),
		generateContentStream: async () =>
			gen([
				{ modelVersion: "gemini-2.5-pro", usageMetadata: { promptTokenCount: 10000 } },
				{ modelVersion: "gemini-2.5-pro", usageMetadata: GEMINI_USAGE },
			]),
	};
}

test("Gemini: thoughts are billed as output, cached content is part of the prompt", async () => {
	const google = instrumentLlmClient(new GoogleGenAI());
	const { attrs, ai } = await capture("gemini", () =>
		google.models.generateContent({ model: "gemini-2.5-pro", contents: "x" }),
	);
	assert.deepEqual(attrs, {
		"gen_ai.provider.name": "google",
		"autter.llm.usage_convention": "total",
		"gen_ai.usage.input_tokens": 10000,
		"gen_ai.usage.output_tokens": 1700,
		"gen_ai.usage.cache_read.input_tokens": 9000,
		"gen_ai.usage.reasoning.output_tokens": 1200,
		"gen_ai.response.model": "gemini-2.5-pro",
	});
	assert.equal(ai.output_tokens, 1700);
	assert.equal(ai.cache_read_tokens, 9000);
});

test("Gemini stream: the final usageMetadata wins", async () => {
	const google = instrumentLlmClient(new GoogleGenAI());
	const { attrs } = await capture("gemini-stream", async () => {
		for await (const _ of await google.models.generateContentStream({ model: "gemini-2.5-pro", contents: "x" })) {
			/* consume */
		}
	});
	assert.equal(attrs["gen_ai.usage.input_tokens"], 10000);
	assert.equal(attrs["gen_ai.usage.output_tokens"], 1700);
	assert.equal(attrs["gen_ai.usage.reasoning.output_tokens"], 1200);
});

// ------------------------------------------------------------ OpenRouter ---

class OpenAIForOpenRouter {
	baseURL = "https://openrouter.ai/api/v1";
	chat = {
		completions: {
			create: async (req) => ({
				model: "anthropic/claude-sonnet-4.5",
				usage: {
					prompt_tokens: 10000,
					completion_tokens: 500,
					total_tokens: 10500,
					cost: req.byok ? 0.0007 : 0.0139,
					is_byok: !!req.byok,
					prompt_tokens_details: { cached_tokens: 9000, cache_write_tokens: 0 },
					cost_details: { upstream_inference_cost: req.byok ? 0.0132 : null },
				},
			}),
		},
	};
}
Object.defineProperty(OpenAIForOpenRouter, "name", { value: "OpenAI" });

test("OpenRouter: detected by base URL over the OpenAI constructor; usage.cost reported as USD", async () => {
	const openrouter = instrumentLlmClient(new OpenAIForOpenRouter());
	const { attrs, ai } = await capture("openrouter", () =>
		openrouter.chat.completions.create({ model: "anthropic/claude-sonnet-4.5", messages: [] }),
	);
	assert.deepEqual(attrs, {
		"gen_ai.provider.name": "openrouter",
		"autter.llm.usage_convention": "total",
		"gen_ai.usage.input_tokens": 10000,
		"gen_ai.usage.output_tokens": 500,
		"gen_ai.usage.cache_read.input_tokens": 9000,
		"gen_ai.usage.cache_creation.input_tokens": 0,
		"autter.llm.cost_usd": 0.0139,
		"gen_ai.response.model": "anthropic/claude-sonnet-4.5",
	});
	assert.equal(ai.cost_usd, 0.0139);
});

test("OpenRouter BYOK: OpenRouter's fee plus the upstream provider's charge", async () => {
	const openrouter = instrumentLlmClient(new OpenAIForOpenRouter());
	const { attrs } = await capture("openrouter-byok", () =>
		openrouter.chat.completions.create({ model: "anthropic/claude-sonnet-4.5", messages: [], byok: true }),
	);
	assert.ok(Math.abs(attrs["autter.llm.cost_usd"] - 0.0139) < 1e-12);
});

test("a `cost` field from another OpenAI-compatible gateway is not trusted as USD", async () => {
	class Gateway {
		baseURL = "https://llm-gateway.example.test/v1";
		chat = { completions: { create: async () => ({ model: "m", usage: { prompt_tokens: 10, completion_tokens: 1, cost: 5 } }) } };
	}
	const gateway = instrumentLlmClient(new Gateway(), { provider: "openai" });
	const { attrs } = await capture("gateway", () => gateway.chat.completions.create({ model: "m", messages: [] }));
	assert.equal(attrs["autter.llm.cost_usd"], undefined);
	assert.equal(attrs["gen_ai.usage.input_tokens"], 10);
});

// --------------------------------------------------------------- Bedrock ---

class ConverseCommand {
	constructor(input) {
		this.input = input;
	}
}
class ConverseStreamCommand {
	constructor(input) {
		this.input = input;
	}
}
const BEDROCK_USAGE = {
	inputTokens: 1000,
	outputTokens: 500,
	totalTokens: 10500,
	cacheReadInputTokens: 4000,
	cacheWriteInputTokens: 5000,
	cacheDetails: [
		{ ttl: "1h", inputTokens: 2000 },
		{ ttl: "5m", inputTokens: 3000 },
	],
};
class BedrockRuntimeClient {
	async send(command) {
		if (command instanceof ConverseStreamCommand) {
			return {
				$metadata: { httpStatusCode: 200 },
				stream: gen([
					{ messageStart: { role: "assistant" } },
					{ contentBlockDelta: { delta: { text: "hi" } } },
					{ metadata: { usage: BEDROCK_USAGE, metrics: { latencyMs: 10 } } },
				]),
			};
		}
		return { output: { message: { role: "assistant", content: [] } }, usage: BEDROCK_USAGE };
	}
}

test("Bedrock Converse: client.send(ConverseCommand) is traced; inputTokens excludes the cache", async () => {
	const bedrock = instrumentLlmClient(new BedrockRuntimeClient());
	const modelId = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
	const { attrs, ai, span } = await capture("bedrock", () =>
		bedrock.send(new ConverseCommand({ modelId, messages: [] })),
	);
	assert.equal(span.name, `chat ${modelId}`);
	assert.equal(span.attributes["gen_ai.request.model"], modelId);
	assert.deepEqual(attrs, {
		"gen_ai.provider.name": "aws.bedrock",
		"autter.llm.usage_convention": "total",
		"gen_ai.usage.input_tokens": 10000,
		"gen_ai.usage.output_tokens": 500,
		"gen_ai.usage.cache_read.input_tokens": 4000,
		"gen_ai.usage.cache_creation.input_tokens": 5000,
		"autter.llm.cache_creation.long_ttl_tokens": 2000,
	});
	assert.equal(ai.input_tokens, 10000);
});

test("Bedrock ConverseStream: usage from the metadata event", async () => {
	const bedrock = instrumentLlmClient(new BedrockRuntimeClient());
	const { attrs } = await capture("bedrock-stream", async () => {
		const response = await bedrock.send(
			new ConverseStreamCommand({ modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", messages: [] }),
		);
		assert.equal(response.$metadata.httpStatusCode, 200);
		for await (const _ of response.stream) {
			/* consume */
		}
	});
	assert.equal(attrs["gen_ai.usage.input_tokens"], 10000);
	assert.equal(attrs["autter.llm.streamed"], true);
});

test("send() with any other command is not traced", async () => {
	exporter.reset();
	class GetObjectCommand {
		constructor(input) {
			this.input = input;
		}
	}
	const bedrock = instrumentLlmClient(new BedrockRuntimeClient());
	await bedrock.send(new GetObjectCommand({ modelId: "x" }));
	assert.equal(exporter.getFinishedSpans().length, 0);
});

// ------------------------------------------------------- manual helpers ---

test("withLlmCall: the new fields emit the contract and the convention marker", async () => {
	const { attrs, ai } = await capture("manual-with", () =>
		withLlmCall({ provider: "anthropic", model: "claude-sonnet-4-5" }, (llm) => {
			llm.setUsage({
				inputTokens: 10000,
				outputTokens: 500,
				cacheReadTokens: 4000,
				cacheWriteTokens: 5000,
				cacheWriteLongTtlTokens: 2000,
				reasoningTokens: 100,
			});
		}),
	);
	assert.deepEqual(attrs, {
		"gen_ai.provider.name": "anthropic",
		"autter.llm.usage_convention": "total",
		"gen_ai.usage.input_tokens": 10000,
		"gen_ai.usage.output_tokens": 500,
		"gen_ai.usage.cache_read.input_tokens": 4000,
		"gen_ai.usage.cache_creation.input_tokens": 5000,
		"autter.llm.cache_creation.long_ttl_tokens": 2000,
		"gen_ai.usage.reasoning.output_tokens": 100,
	});
	assert.equal(ai.cache_write_tokens, 5000);
});

test("withLlmCall: old callers (inputTokens + cacheReadTokens) keep working", async () => {
	const { attrs, ai } = await capture("manual-old", () =>
		withLlmCall({ provider: "openai", model: "gpt-5-mini" }, (llm) => {
			llm.setUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 });
			llm.setCost(0.0012);
		}),
	);
	assert.equal(attrs["gen_ai.usage.input_tokens"], 100);
	assert.equal(attrs["gen_ai.usage.cache_read.input_tokens"], 50);
	assert.equal(attrs["autter.llm.cost_usd"], 0.0012);
	assert.equal(attrs["autter.llm.usage_convention"], "total");
	assert.deepEqual(
		{ input: ai.input_tokens, cacheRead: ai.cache_read_tokens, cost: ai.cost_usd },
		{ input: 100, cacheRead: 50, cost: 0.0012 },
	);
});

test("trackLlmCall: an uncached Anthropic input_tokens smaller than its cache counts is summed", async () => {
	const { attrs, ai } = await capture("manual-track", () => {
		trackLlmCall({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 9000,
			durationMs: 900,
		});
	});
	assert.equal(attrs["gen_ai.usage.input_tokens"], 10000);
	assert.equal(attrs["gen_ai.usage.cache_read.input_tokens"], 9000);
	assert.equal(attrs["autter.llm.usage_convention"], "total");
	assert.equal(ai.input_tokens, 10000);
});

test("every instrumented span carries the convention marker, even without usage", async () => {
	class Bare {
		chat = { completions: { create: async () => ({ id: "x" }) } };
	}
	const client = instrumentLlmClient(new Bare(), { provider: "openai" });
	const { attrs } = await capture("bare", () => client.chat.completions.create({ model: "m", messages: [] }));
	assert.deepEqual(attrs, { "gen_ai.provider.name": "openai", "autter.llm.usage_convention": "total" });
});
