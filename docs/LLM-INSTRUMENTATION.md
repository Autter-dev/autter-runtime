# LLM instrumentation

Autter Runtime recognises OpenTelemetry GenAI spans and its own LLM wrappers.
Calls are recorded at 100% by default, even when ordinary traces are sampled.
For Node services, initialise `@autter/runtime-node` once before making model
calls. For other languages, send OTLP spans with the semantic-convention fields
below to the same runtime endpoint.

## Choose an instrumentation method

### Wrap a supported client

`instrumentLlmClient` wraps OpenAI, Anthropic, Google GenAI, and compatible
clients. It records model, provider, duration, token usage, and errors, including
streaming calls when usage is present in the final stream chunks.

```ts
import OpenAI from "openai";
import { instrumentLlmClient } from "@autter/runtime-node";

const openai = instrumentLlmClient(new OpenAI());
const response = await openai.chat.completions.create({
  model: "gpt-5-mini",
  messages: [{ role: "user", content: "Summarise this incident." }],
});
```

For OpenAI streaming usage, set `stream_options: { include_usage: true }`.
Provider detection can be overridden with the wrapper's second argument:
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
    llm.setUsage({ inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens });
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

trackLlmCall({
  provider: "anthropic",
  model: "claude-sonnet-4",
  inputTokens: 820,
  outputTokens: 145,
  durationMs: 932,
  userId: "user-123",
  costUsd: 0.0042, // optional exact cost in USD
});
```

`initAutterServer` also recognises Vercel AI SDK telemetry when
`experimental_telemetry.isEnabled` is true. The runtime-next integration uses
the same Node runtime, so these options apply there too.

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
| `gen_ai.usage.input_tokens` | Input token count | `inputTokens`; ingester also accepts `gen_ai.usage.prompt_tokens` |
| `gen_ai.usage.output_tokens` | Output token count | `outputTokens`; ingester also accepts `gen_ai.usage.completion_tokens` |
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
| Slow: longer than 500 ms and that model's rolling p95 | Everything | `slow` |
| Any other call | Everything except the content | `omitted` |
| A span with no content attributes | Unchanged | not set |

"That model's rolling p95" is an estimate the process keeps per span name and
model from every call it made in the last few minutes. Content kept for being
slow shares the `retainSlowTracesPerMinute` budget (default 60 a minute per
process, a sixth of it per model). Failed calls always keep their content.

Content is these attributes, and the GenAI message events
(`gen_ai.system.message`, `gen_ai.user.message`, `gen_ai.assistant.message`,
`gen_ai.tool.message`, `gen_ai.choice`, `gen_ai.content.prompt`,
`gen_ai.content.completion`, `gen_ai.client.inference.operation.details`):

- Vercel AI SDK: `ai.prompt`, `ai.prompt.messages`, `ai.prompt.tools`,
  `ai.prompt.system`, `ai.response.text`, `ai.response.toolCalls`,
  `ai.response.object`, `ai.response.reasoning`,
  `ai.response.reasoningDetails`, `ai.response.files`, `ai.response.sources`,
  `ai.result.text` / `toolCalls` / `object`, `ai.toolCall.args` / `result` /
  `input` / `output`, `ai.value`, `ai.values`, `ai.embedding`,
  `ai.embeddings`.
- OTel GenAI: `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.prompt.*`,
  `gen_ai.completion.*` (OpenLLMetry's indexed form), `gen_ai.input.messages`,
  `gen_ai.output.messages`, `gen_ai.system_instructions`,
  `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`,
  `gen_ai.tool.call.result`.
- OpenInference: `input.value`, `output.value`, `llm.input_messages.*`,
  `llm.output_messages.*`, `llm.prompts`.

Usage (`ai.usage.*`, `gen_ai.usage.*`), cost, model and provider, finish
reasons, settings, ids and `ai.telemetry.metadata.*` always stay, so the
ingester's usage and cost rows are the same for a call with or without its
content.

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
