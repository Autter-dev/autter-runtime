import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ClickHouseStore } from "./clickhouse.js";
import type { IngesterConfig } from "./config.js";
import { LLM_CACHE_COLUMNS, MIGRATIONS } from "./migrations.js";
import { normalizeTraces } from "./normalize-otlp.js";
import { SinkForwarder } from "./sink.js";
import type { IngestContext, RuntimeLlmCall } from "./types.js";

/**
 * Cache-aware LLM cost, storage side (1.16.0): migration 0024 and the
 * baseline, inserts of old- and new-shape calls, the sink payload, and the
 * OTLP path end to end.
 */

function config(overrides: Partial<IngesterConfig> = {}): IngesterConfig {
	return {
		port: 0,
		clickhouseUrl: null,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: null,
		sinkToken: null,
		sinkMaxAttempts: 1,
		sinkMaxBufferedBatches: 10,
		sinkMaxBufferedMb: 2,
		maxBodyBytes: 1024 * 1024,
		rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
		logTtlDays: 14,
		...overrides,
	};
}

const CTX: IngestContext = { orgId: "org-1", repositoryId: "repo-1", scope: "server", allowedOrigins: [] };

/** A call as ingesters before 1.16.0 built it: no cache fields. */
const OLD_SHAPE: RuntimeLlmCall = {
	service: "api",
	environment: "production",
	release: null,
	traceId: "t".repeat(32),
	spanId: "s".repeat(16),
	provider: "openai",
	model: "gpt-4o",
	operation: "chat",
	inputTokens: 10,
	outputTokens: 3,
	costUsd: 0.000055,
	costSource: "estimated",
	durationMs: 12,
	status: "ok",
	errorType: "",
	userId: "",
	sessionId: "",
	attributes: null,
	startedAt: new Date("2026-11-14T10:00:00Z"),
};

const NEW_SHAPE: RuntimeLlmCall = {
	...OLD_SHAPE,
	inputTokens: 10_000,
	outputTokens: 500,
	cacheReadTokens: 9_000,
	cacheWriteTokens: 600,
	cacheWriteLongTokens: 100,
	reasoningTokens: 200,
	pricingVersion: "2026-11-14",
};

interface StubCall { sql: string; body: string }

async function startStub(): Promise<{ server: Server; url: string; calls: StubCall[] }> {
	const calls: StubCall[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const params = new URL(req.url!, "http://localhost").searchParams;
			calls.push({ sql: `${params.get("query") ?? ""}\n${body}`, body });
			res.writeHead(200).end("");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const close = (server: Server) =>
	new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});

test("migration 0024 adds the cache columns idempotently, with defaults, after every earlier migration", () => {
	const last = MIGRATIONS.at(-1)!;
	assert.equal(last.id, "0024-llm-cache-tokens");
	assert.deepEqual(LLM_CACHE_COLUMNS, [
		"cache_read_tokens UInt64 DEFAULT 0",
		"cache_write_tokens UInt64 DEFAULT 0",
		"cache_write_long_tokens UInt64 DEFAULT 0",
		"reasoning_tokens UInt64 DEFAULT 0",
		"pricing_version LowCardinality(String) DEFAULT ''",
	]);
	assert.equal(last.statements.length, LLM_CACHE_COLUMNS.length);
	for (const [i, statement] of last.statements.entries()) {
		assert.equal(statement, `ALTER TABLE {db}.runtime_llm_calls ADD COLUMN IF NOT EXISTS ${LLM_CACHE_COLUMNS[i]}`);
		assert.match(statement, / DEFAULT /, "a rolling deploy's old replicas insert without naming it");
	}
});

test("fresh databases get the cache columns from the baseline; old- and new-shape calls insert with every column", async (t) => {
	t.mock.method(console, "log", () => {});
	const stub = await startStub();
	try {
		const store = new ClickHouseStore(config({ clickhouseUrl: stub.url }));
		await store.ensureSchema();
		const create = stub.calls.find((c) => /CREATE TABLE IF NOT EXISTS autter_runtime\.runtime_llm_calls/.test(c.sql));
		assert.ok(create, "baseline CREATE for runtime_llm_calls");
		for (const column of LLM_CACHE_COLUMNS) assert.ok(create.sql.includes(column), `baseline lacks ${column}`);

		await store.insertLlmCalls(CTX, [OLD_SHAPE, NEW_SHAPE]);
		const insert = stub.calls.find((c) => /INSERT INTO autter_runtime\.runtime_llm_calls/.test(c.sql));
		assert.ok(insert, "an INSERT was sent");
		const rows = insert.body.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		const pick = (row: Record<string, unknown>) => [
			row.input_tokens,
			row.cache_read_tokens,
			row.cache_write_tokens,
			row.cache_write_long_tokens,
			row.output_tokens,
			row.reasoning_tokens,
			row.pricing_version,
			row.cost_source,
		];
		assert.deepEqual(pick(rows[0]!), [10, 0, 0, 0, 3, 0, "", "estimated"], "an old-shape call reads 0 and ''");
		assert.deepEqual(pick(rows[1]!), [10_000, 9_000, 600, 100, 500, 200, "2026-11-14", "estimated"]);
	} finally {
		await close(stub.server);
	}
});

test("sink payload: llmCalls carry the cache fields (0 / '' for an old-shape call), payload version stays 1", async () => {
	const bodies: string[] = [];
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		bodies.push(String(init?.body));
		return new Response("", { status: 200 });
	}) as typeof fetch;
	const sink = new SinkForwarder(config({ sinkUrl: "http://sink.local/hook", sinkToken: "t", sinkMaxAttempts: 3 }), fetchImpl, {
		retryBaseMs: 4,
		retryCapMs: 8,
		requestTimeoutMs: 500,
		healthyConcurrency: 4,
	});
	try {
		sink.enqueue(CTX, [], [], [OLD_SHAPE, NEW_SHAPE]);
		const deadline = Date.now() + 2000;
		while (bodies.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
		const body = JSON.parse(bodies[0]!) as { version: number; llmCalls: Array<Record<string, unknown>> };
		assert.equal(body.version, 1);
		const pick = (c: Record<string, unknown>) => [c.inputTokens, c.cacheReadTokens, c.cacheWriteTokens, c.cacheWriteLongTokens, c.reasoningTokens, c.pricingVersion, c.startedAt];
		assert.deepEqual(pick(body.llmCalls[0]!), [10, 0, 0, 0, 0, "", "2026-11-14T10:00:00.000Z"]);
		assert.deepEqual(pick(body.llmCalls[1]!), [10_000, 9_000, 600, 100, 200, "2026-11-14", "2026-11-14T10:00:00.000Z"]);
	} finally {
		sink.stop();
	}
});

/** One OTLP/JSON span. */
function span(name: string, kind: number, spanId: string, attrs: Record<string, string | number>, parentSpanId?: string) {
	const start = BigInt(Date.parse("2026-11-14T10:00:00Z")) * 1_000_000n;
	return {
		traceId: "a".repeat(32),
		spanId,
		...(parentSpanId ? { parentSpanId } : {}),
		name,
		kind,
		startTimeUnixNano: String(start),
		endTimeUnixNano: String(start + 1_500_000_000n),
		attributes: Object.entries(attrs).map(([key, value]) =>
			typeof value === "number" ? { key, value: { intValue: String(value) } } : { key, value: { stringValue: value } },
		),
	};
}

test("OTLP end to end: an OpenInference LLM span is a row; an agent umbrella and its chat child count once", () => {
	const usage = { "gen_ai.provider.name": "openai", "gen_ai.request.model": "gpt-4o", "gen_ai.usage.input_tokens": 10_000, "gen_ai.usage.output_tokens": 500 };
	const { llmCalls } = normalizeTraces({
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "agents" } }] },
				scopeSpans: [
					{
						spans: [
							span("invoke_agent support", 1, "1".repeat(16), { ...usage, "gen_ai.operation.name": "invoke_agent" }),
							span("chat gpt-4o", 3, "2".repeat(16), { ...usage, "gen_ai.operation.name": "chat", "gen_ai.usage.cache_read.input_tokens": 9_000 }, "1".repeat(16)),
							span("ChatCompletion", 1, "3".repeat(16), {
								"openinference.span.kind": "LLM",
								"llm.model_name": "gpt-4o",
								"llm.token_count.prompt": 2_000,
								"llm.token_count.completion": 100,
								"llm.token_count.prompt_details.cache_read": 1_500,
							}),
							span("Agent", 1, "4".repeat(16), { "openinference.span.kind": "AGENT", "llm.model_name": "gpt-4o", "llm.token_count.prompt": 2_000 }),
						],
					},
				],
			},
		],
	});
	assert.deepEqual(
		llmCalls.map((c) => [c.operation, c.inputTokens, c.cacheReadTokens, c.costSource]),
		[
			["chat", 10_000, 9_000, "estimated"],
			["llm", 2_000, 1_500, "estimated"],
		],
	);
});
