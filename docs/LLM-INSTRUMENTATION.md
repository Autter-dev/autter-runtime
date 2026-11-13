# LLM instrumentation

Autter Runtime recognises OpenTelemetry GenAI spans and its own LLM wrappers.
Calls are recorded at 100% by default, even when ordinary traces are sampled.
For Node services, initialise `@autter/runtime-node` once before making model
calls. For other languages, send OTLP spans with the semantic-convention fields
below to the same runtime endpoint.

## Choose an instrumentation method

### Wrap a supported client

`instrumentLlmClient` wraps OpenAI, Anthropic, Google GenAI, AWS Bedrock
Runtime (`client.send(new ConverseCommand(...))` and `ConverseStreamCommand`),
OpenRouter through the OpenAI SDK, and compatible clients. It records model,
provider, duration, token usage (prompt-cache reads and writes and reasoning
tokens included, see [token usage and prompt caching](#token-usage-and-prompt-caching)),
and errors, including streaming calls when usage is present in the stream.
The SDKs' stream helpers (`anthropic.messages.stream()`,
`openai.chat.completions.stream()`, `openai.responses.stream()`) are recorded
whether you iterate them or only `await stream.finalMessage()` /
`finalChatCompletion()` / `finalResponse()`.

```ts
import OpenAI from "openai";
import { instrumentLlmClient } from "@autter/runtime-node";

const openai = instrumentLlmClient(new OpenAI());
const response = await openai.chat.completions.create({
  model: "gpt-5-mini",
  messages: [{ role: "user", content: "Summarise this incident." }],
});
```

For OpenAI Chat Completions streaming usage, set
`stream_options: { include_usage: true }` (the Responses API always sends it,
on `response.completed`). The provider is detected from the client's base URL
first (`openrouter.ai` → `openrouter`, `api.groq.com` → `groq`, …), then from
its class name (`BedrockRuntimeClient` → `aws.bedrock`). Override it with the
wrapper's second argument:
`instrumentLlmClient(client, { provider: "openai", userId: "user-123" })`.

### Wrap a call manually with `withLlmCall`

Use this for raw `fetch`, custom SDKs, or when you need exact usage and cost.
The callback receives a handle; thrown errors are recorded and rethrown.

```ts
import { withLlmCall } from "@autter/runtime-node";

const result = await withLlmCall(
  {
    provider: "openai",
    model: "gpt-5-mini",
    operation: "chat",
    userId: "user-123", // opaque ID; do not use an email
    sessionId: "session-456",
  },
  async (llm) => {
    const response = await fetch("https://example.invalid/model", {
      method: "POST",
    });
    const body = await response.json();
    llm.setUsage({
      inputTokens: body.usage.prompt_tokens, // all prompt tokens, cached ones included
      outputTokens: body.usage.completion_tokens, // reasoning included
      cacheReadTokens: body.usage.prompt_tokens_details?.cached_tokens,
      cacheWriteTokens: body.usage.prompt_tokens_details?.cache_write_tokens,
      reasoningTokens: body.usage.completion_tokens_details?.reasoning_tokens,
    });
    llm.setResponseModel(body.model); // when the provider reports a served model
    llm.setCost(body.cost_usd); // optional exact USD; otherwise ingester estimates
    return body;
  },
);
```

The handle also supports `setModel` (alias of `setResponseModel`) and
`setAttributes` for additional redacted attributes.

### Report a completed call with `trackLlmCall`

Use this when the call already happened elsewhere, such as a queue callback or
batch process. Supply duration in milliseconds when available; thrown errors
can be passed in `error`.

```ts
import { trackLlmCall } from "@autter/runtime-node";

// Anthropic usage: input_tokens leaves the cache out, so add it back.
trackLlmCall({
  provider: "anthropic",
  model: "claude-sonnet-4",
  inputTokens: 820 + 9000 + 0, // input_tokens + cache_read_input_tokens + cache_creation_input_tokens
  cacheReadTokens: 9000,
  cacheWriteTokens: 0,
  outputTokens: 145,
  durationMs: 932,
  userId: "user-123",
  costUsd: 0.0042, // optional exact cost in USD
});
```

`initAutterServer` also recognises Vercel AI SDK telemetry when
`experimental_telemetry.isEnabled` is true. The runtime-next integration uses
the same Node runtime, so these options apply there too.

## Token usage and prompt caching

Prompt caching changes what a call costs: cache reads are billed below the
input price, and cache writes, where the provider charges for them, above it
(Anthropic: 1.25x for the 5-minute TTL, 2x for 1 hour).
Every LLM span from `@autter/runtime-node` 1.14.0 reports the parts, in one
convention whatever the provider, so the ingester can price each part:

| Attribute | Meaning |
| --- | --- |
| `gen_ai.usage.input_tokens` | **All** prompt tokens: uncached, cache reads and cache writes |
| `gen_ai.usage.cache_read.input_tokens` | Prompt tokens read from the cache (part of input) |
| `gen_ai.usage.cache_creation.input_tokens` | Prompt tokens written to the cache (part of input) |
| `autter.llm.cache_creation.long_ttl_tokens` | Cache writes at the long TTL (Anthropic 1 h, OpenAI 12 h), when the provider reports the split (part of the writes) |
| `gen_ai.usage.output_tokens` | **All** output tokens, reasoning included |
| `gen_ai.usage.reasoning.output_tokens` | Reasoning/thinking tokens (part of output) |
| `autter.llm.usage_convention` | `"total"`: the two totals above already include their parts; set on every Autter LLM span |
| `autter.llm.cost_usd` | Cost the provider reported in USD (OpenRouter's `usage.cost`), or yours from `setCost` |

How each provider's response maps to it:

| Provider | Input total | Cache read | Cache write (long TTL) | Output total (reasoning) |
| --- | --- | --- | --- | --- |
| OpenAI Chat Completions, OpenRouter, Groq, Mistral | `prompt_tokens` (already the total) | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` | `completion_tokens` (`completion_tokens_details.reasoning_tokens`) |
| OpenAI Responses (plain and `response.completed`) | `input_tokens` (already the total) | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` (`cache_write_tokens_details.ttl_12h_tokens`) | `output_tokens` (`output_tokens_details.reasoning_tokens`) |
| Anthropic (plain, `message_start` + `message_delta`) | `input_tokens` **+** `cache_read_input_tokens` **+** `cache_creation_input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` (`cache_creation.ephemeral_1h_input_tokens`) | `output_tokens` (`output_tokens_details.thinking_tokens`) |
| Gemini (Google GenAI) | `promptTokenCount` + `toolUsePromptTokenCount` | `cachedContentTokenCount` | not reported | `candidatesTokenCount` **+** `thoughtsTokenCount` (`thoughtsTokenCount`) |
| Bedrock Converse / ConverseStream | `inputTokens` **+** `cacheReadInputTokens` **+** `cacheWriteInputTokens` | `cacheReadInputTokens` | `cacheWriteInputTokens` (`cacheDetails` with `ttl: "1h"`) | `outputTokens` |

OpenRouter's `usage.cost` is in credits, whose base currency is the US
dollar ([OpenRouter FAQ](https://openrouter.ai/docs/faq)), so it is reported
as `autter.llm.cost_usd`. For a BYOK request (`is_byok: true`) `cost` is only
OpenRouter's fee, so `cost_details.upstream_inference_cost` is added
([usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting)).
A `cost` field from any other gateway is ignored: its unit is unknown.

With `withLlmCall` / `trackLlmCall`, pass the same convention:
`inputTokens` is the total including cache reads and writes, `outputTokens`
the total including reasoning, and `cacheReadTokens`, `cacheWriteTokens`,
`cacheWriteLongTtlTokens` and `reasoningTokens` the parts. Code written
before these fields existed keeps working; an `inputTokens` smaller than its
own `cacheReadTokens + cacheWriteTokens` cannot be a total, so it is read as
Anthropic's uncached count and the cache counts are added to it.

### Costs change after upgrading

Before 1.14.0 the SDK sent one input count and the ingester priced all of it
at the full input rate:

- **Anthropic and Bedrock costs go up.** Their `input_tokens` leave the cache
  out, so cache reads and writes were not counted at all. They are now in
  `input_tokens` and priced at the cache rates.
- **OpenAI and Gemini costs go down.** Their input already included cached
  tokens, which were priced at the full input rate; they are now priced at
  the cache-read rate. OpenRouter calls use the cost OpenRouter reports.
- **Gemini output goes up** by the thinking tokens, which are billed as
  output but were missing from `candidatesTokenCount`.

The old numbers were wrong in both directions; history is not rewritten.

### Upgrade the ingester first

Upgrade `@autter/otlp-ingester` before `@autter/runtime-node` 1.14.0. An
older ingester does not read the cache counts or the convention marker: it
prices the whole Anthropic and Bedrock input, cache reads and writes
included, at the full input rate, overstating those calls until it is
upgraded. The SDK's compatibility check (`llm_cache_tokens`) and
`npx @autter/runtime-node doctor` warn when the ingester is too old.

## Semantic-convention fields

The Node helpers emit the fields below. The ingester also recognises common
legacy aliases from other OTel libraries, shown in the final column.

| Attribute | Meaning | Source |
| --- | --- | --- |
| `gen_ai.operation.name` | Operation, such as `chat` or `embeddings` | `operation`, defaults to `chat` |
| `gen_ai.provider.name` | Provider, such as `openai`, `anthropic`, or `google` | `provider` |
| `gen_ai.system` | Compatibility alias for provider | `provider` |
| `gen_ai.request.model` | Requested model | `model` |
| `gen_ai.response.model` | Model actually served, when reported | `setResponseModel` / `setModel` |
| `gen_ai.usage.input_tokens` | All input tokens, cache reads and writes included | `inputTokens`; ingester also accepts `gen_ai.usage.prompt_tokens` |
| `gen_ai.usage.output_tokens` | All output tokens, reasoning included | `outputTokens`; ingester also accepts `gen_ai.usage.completion_tokens` |
| `gen_ai.usage.cache_read.input_tokens` | Input tokens read from the provider cache | `cacheReadTokens` |
| `gen_ai.usage.cache_creation.input_tokens` | Input tokens written to the provider cache | `cacheWriteTokens` |
| `autter.llm.cache_creation.long_ttl_tokens` | Cache writes at the long TTL | `cacheWriteLongTtlTokens` |
| `gen_ai.usage.reasoning.output_tokens` | Reasoning tokens | `reasoningTokens` |
| `autter.llm.usage_convention` | `"total"` on every Autter LLM span | Set by the SDK |
| `autter.llm.cost_usd` | Exact call cost in USD, if known | `costUsd` / `setCost` |
| `autter.user_id` | Opaque user identifier for attribution | `userId` |
| `autter.session_id` | Opaque session identifier | `sessionId` |
| `gen_ai.usage.cost` | Reported cost in USD, accepted from other OTel exporters | Other instrumentation |
| `ai.*` | Vercel AI SDK provider/model/usage fields | Vercel AI SDK telemetry |

Custom attributes are redacted before export. Avoid prompts, secrets, email
addresses, and other sensitive values; `userId` and `sessionId` should be
opaque identifiers.

For Python, Go, and other runtimes, any OTel GenAI instrumentation that emits
`gen_ai.*` spans through OTLP is recognised. Token and cost extraction depends
on the attributes that instrumentation emits. See [OTLP setup](WITHOUT-NPM.md)
for sending data without an Autter package.

## Prompt and completion content

Every LLM call is exported, whatever `traceSampleRate` is, with its model,
provider, token counts, cost, latency and status. From `@autter/runtime-node`
1.12.0, the prompt and completion content on those spans is exported only for
calls that failed or were slow:

| Call | Exported | `autter.llm.content` |
| --- | --- | --- |
| Failed (ERROR status or an `exception` event) | Everything | `error` |
| Slow: see below | Everything | `slow` |
| Any other call | Everything except the content | `omitted` |
| A span with no content attributes | Unchanged | not set |

Slow means longer than 20 s until the process has seen about 50 recent calls
of that span name and model; from then on, longer than both 500 ms and that
model's p95 baseline (an estimate the process keeps from every call, older
calls counting half every 15 minutes). The absolute 20 s threshold keeps a
low-volume model, whose few calls all take seconds, from keeping the content
of nearly every call. Content kept for being slow shares the
`retainSlowTracesPerMinute` budget (default 60 a minute per process, a sixth
of it per model). Failed calls always keep their content.

The policy covers LLM call spans (Vercel AI SDK, OTel GenAI, OpenInference
`openinference.span.kind` `LLM` / `EMBEDDING`, OpenLLMetry `llm.request.type`)
and the AI framework spans around them that carry the same inputs and
outputs: any OpenInference span (chains, agents, tools, retrievers,
rerankers), Traceloop `traceloop.span.kind` workflows, tasks, agents and
tools, and any span with `llm.*` or `gen_ai.*` attributes. Only LLM call
spans skip head sampling.

Content is these attributes (key lists checked against
`@opentelemetry/semantic-conventions` 1.43, `@arizeai/openinference-semantic-conventions`
and `@traceloop/ai-semantic-conventions`), the GenAI message events
(`gen_ai.system.message`, `gen_ai.user.message`, `gen_ai.assistant.message`,
`gen_ai.tool.message`, `gen_ai.choice`, `gen_ai.content.prompt`,
`gen_ai.content.completion`, `gen_ai.client.inference.operation.details`, and
any other `gen_ai.*` event except `gen_ai.evaluation.result` and
`gen_ai.client.operation.exception`), OpenLLMetry's `db.query.result` event,
content keys on span links, and generic content keys (`content`, `body`,
`text`, `message`, `input`, `output`, `prompt`, `completion`, `arguments`,
`result`, `tool_calls`) on any other event of such a span:

- Vercel AI SDK: `ai.prompt`, `ai.prompt.messages`, `ai.prompt.tools`,
  `ai.prompt.system`, `ai.response.text`, `ai.response.toolCalls`,
  `ai.response.object`, `ai.response.reasoning`,
  `ai.response.reasoningDetails`, `ai.response.files`, `ai.response.sources`,
  `ai.result.text` / `toolCalls` / `object`, `ai.toolCall.args` / `result` /
  `input` / `output`, `ai.value`, `ai.values`, `ai.embedding`,
  `ai.embeddings`.
- OTel GenAI: `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.input.messages`,
  `gen_ai.output.messages`, `gen_ai.system_instructions`,
  `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`,
  `gen_ai.tool.call.result`, `gen_ai.retrieval.query.text`,
  `gen_ai.retrieval.documents`, `gen_ai.evaluation.explanation`.
- OpenLLMetry / Traceloop: `gen_ai.prompt.N.*` and `gen_ai.completion.N.*`
  except their `role` and `finish_reason`, `llm.request.functions.*`,
  `traceloop.entity.input`, `traceloop.entity.output`,
  `gen_ai.guardrail.input`, `gen_ai.guardrail.output`, `mcp.response.value`,
  `db.query.result.document`, `db.vector.query.result.N.*` except ids and
  scores.
- OpenInference: `input.value`, `output.value`, `input.documents` /
  `images`, `output.documents` / `images`, `llm.input_messages.*`,
  `llm.output_messages.*` (except message roles), `llm.prompts`,
  `llm.prompt_template.template`, `llm.prompt_template.variables`,
  `llm.function_call`, `llm.invocation_parameters`, `llm.tools.*`,
  `tool.parameters`, `tool.json_schema`, `retrieval.documents.*` and
  `reranker.input_documents.*` / `output_documents.*` (except document ids
  and scores), `reranker.query`, `embedding.embeddings.*` (except the model
  name), `embedding.text`, `embedding.vector`, `document.content`,
  `message.content`, `message.contents`, `message.tool_calls`,
  `message.function_call_arguments_json`, `tool_call.function.arguments`,
  `message_content.*` content, `audio.transcript`.

Usage (`ai.usage.*`, `gen_ai.usage.*`, `llm.token_count.*`), cost
(`llm.cost.*`), model and provider, finish reasons, roles, the prompt
template version, settings, ids and `ai.telemetry.metadata.*` always stay, so
the ingester's usage and cost rows are the same for a call with or without
its content.

With `llmContent: "never"`, a failed call keeps its ERROR status and its
exception events, but its status message and the exceptions' messages (and
the message lines of their stack traces), which can quote the completion,
become `[omitted]`; the exception type and stack frames stay. A span the
policy cannot read is exported without content; one that cannot even be
stripped is dropped, never the rest of its batch. The policy never changes
the span object other processors hold: it exports a copy.

`llmContent` changes this:

```ts
initAutterServer({ ..., llmContent: "always" }); // every call keeps its content (1.11 behaviour)
initAutterServer({ ..., llmContent: "never" });  // no call does, failed ones included
```

The decision is made per LLM span when it is exported, from the span alone. A
call that was fast inside a request that later failed or was slow has already
been exported without its content.

## Verify without making a model call

```ts
import { emitLlmSelftestTrace } from "@autter/runtime-node";

const { traceId, ok, errors } = await emitLlmSelftestTrace();
console.log(traceId); // find the fake call in the Runtime LLM view
// Never rejects (safe in an Express 4 route): when the trace was not
// delivered, ok is false and errors says why, e.g. kind "unauthorized" (401)
// for a wrong ingest key.
if (!ok) console.warn(errors.map((error) => error.message).join("
"));
```
