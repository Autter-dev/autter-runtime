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

## Prompt caching and cost

From `@autter/otlp-ingester` 1.16.0 every LLM cost accounts for prompt
caching: cache reads are priced at the model's cache-read rate and cache
writes at its cache-write rate, not at the full input rate.

### How the ingester reads usage

Input is the **total** prompt, cache reads and cache writes included; the
cache counts are parts of it. Output is the total, reasoning included. The
ingester reads, first match wins:

| Part | Attributes |
| --- | --- |
| Input total | `gen_ai.usage.input_tokens`, `gen_ai.usage.prompt_tokens`, `ai.usage.inputTokens`, `ai.usage.promptTokens`, `llm.token_count.prompt` |
| Cache reads | `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_read_input_tokens` (OpenLLMetry), `ai.usage.cachedInputTokens` (Vercel AI SDK), `llm.token_count.prompt_details.cache_read` (OpenInference) |
| Cache writes | `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.cache_creation_input_tokens` (OpenLLMetry), `llm.token_count.prompt_details.cache_write` (OpenInference) |
| Long-TTL cache writes | `autter.llm.cache_creation.long_ttl_tokens` (Anthropic 1 h, OpenAI 12 h; part of the writes) |
| Output total | `gen_ai.usage.output_tokens`, `gen_ai.usage.completion_tokens`, `ai.usage.outputTokens`, `ai.usage.completionTokens`, `llm.token_count.completion` |
| Reasoning | `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.reasoning_tokens`, `ai.usage.reasoningTokens`, `llm.token_count.completion_details.reasoning` |
| Reported cost (USD) | `autter.llm.cost_usd`, then `gen_ai.usage.cost`, `ai.usage.cost`, `llm.cost.total` |

Spans marked `autter.llm.usage_convention = "total"` (every Autter SDK LLM
span) are taken as they are. Other senders differ: the OTel GenAI semconv,
OpenAI and Gemini report input including cached tokens, while Anthropic's API
reports uncached input apart from cache reads and writes. Without the
marker the ingester reads input as inclusive, unless cache reads plus
cache writes exceed it, which only an exclusive count can produce; then the
total is input + reads + writes.

**Known limitation.** An exclusive count whose cache tokens do not exceed
its uncached input (say 5,000 uncached and 3,000 cache reads, reported as
input 5,000) looks like an inclusive one and is read as 5,000 total: the
call is under-counted and under-priced. Instrumentations that report
Anthropic usage this way (some OpenLLMetry and Vercel AI SDK versions)
should report the total, or set `autter.llm.usage_convention = "total"`
once they do. Output is not adjusted: a sender that leaves reasoning
tokens out of output (Gemini's `candidatesTokenCount`) under-counts output.

OpenInference `LLM` and `EMBEDDING` spans are LLM calls (`llm.model_name`,
`llm.provider`); OpenInference agent, chain, tool and retriever spans are
not, since they wrap those calls. An in-process `invoke_agent` (or
`invoke_workflow`) span of kind INTERNAL is not counted either: its usage
sums its own `chat` child spans. A CLIENT `invoke_agent` span, a call to a
remote agent service whose model calls are not in the trace, is counted.
An in-process agent span that an older instrumentation marks CLIENT is
still counted along with its children.

### How a cost is estimated

When the span reports no cost, the ingester estimates one from its price
table:

```
uncached = max(0, input − cache reads − cache writes)
cost     = uncached × input rate
         + cache reads × cache-read rate
         + (cache writes − long-TTL writes) × cache-write rate
         + long-TTL writes × long-TTL write rate
         + output × output rate
```

A model without a cache-read or cache-write rate is charged the input rate
for those tokens (OpenAI before GPT-5.6 and Gemini charge no write premium);
without a long-TTL rate, the short write rate. A model the table does not
list is **not priced** (`cost_source = 'none'`, cost 0, tokens kept): it is
never priced like a sibling or a family. Model ids match on a version
boundary: `gpt-5` prices `gpt-5-2025-08-07` but not `gpt-5.5`, `gpt-5-pro`
or `gpt-5-mini`, and `claude-sonnet-4-5` prices
`global.anthropic.claude-sonnet-4-5-20250929-v1:0`. Router and cloud
prefixes (`openai/`, `models/`, `us.` / `eu.` / `global.` Bedrock inference
profiles, `anthropic.`) are stripped first.

Each estimated row records the price table that produced it in
`pricing_version` (its as-of day, or `override:<asOf>`). Rows are never
re-priced. An `estimated` row with an empty `pricing_version` was priced by
an ingester before 1.16.0, which charged cached input at the full input
rate; the local dashboard labels those "estimated before cache pricing".

### The price table

`packages/otlp-ingester/src/llm-prices.ts`, read from the providers'
pricing pages on 2026-11-14:

- Anthropic ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)):
  Fable / Mythos 5–5.2, Opus 4–5.5, Sonnet 4–5.5, Haiku 4.5 and 5.5. Cache
  writes 1.25x (5 minutes) and 2x (1 hour); cache reads 0.1x, except 0.05x
  on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable / Mythos 5.1–5.2.
- OpenAI ([pricing](https://developers.openai.com/api/docs/pricing)):
  GPT-6 / 6.1, GPT-5.6, GPT-5 to 5.5 (with mini, nano, pro and
  `gpt-5.3-codex`), GPT-4.1, GPT-4o, o3, o3-pro, embeddings. Cached input
  per model (0.5x on GPT-4o, 0.25x on GPT-4.1, 0.1x on GPT-5.x, 0.05x on
  `gpt-6.1-sol` / `gpt-6.1-terra`); cache writes, from GPT-5.6, 1.25x for
  30 minutes and 2.5x for 12 hours.
- Google Gemini API ([pricing](https://aistudio.google.com/docs/pricing)):
  Gemini 4 (Carbon, Argon, Hydrogen), 3.x and 2.5, with per-model cached
  input prices and dated changes (Gemini 4 Carbon and Argon double on
  2026-12-01, Gemini 3.6 and 3.8 Flash on 2027-01-01; a call is priced at
  the rate in force on its start day).
- A few older models no longer on those pages (`claude-3-5-haiku`,
  `gpt-4.1-nano`, `o3-mini`, `o4-mini`, `gemini-2.0-flash`) and the
  DeepSeek, Mistral, Llama and Grok entries are carried over from the
  previous table without cache rates and were not re-checked.

Not modelled: long-context tiers (Haiku 5.5 over 100K prompt tokens, OpenAI
over 272K, Gemini Pro over 200K are priced at the short-context rate),
batch, flex, fast and priority tiers, regional and data-residency uplifts,
Bedrock and Vertex partner prices (priced at the first-party rate), audio
input rates, and Gemini context-cache storage (billed per hour, not per
call). GPT-5.6 Sol's rates are promotional until 2026-11-30 and the page
does not give the rate after it. Correct any of these with an override
file.

### Your own prices (self-hosted)

Set `AUTTER_LLM_PRICES_FILE` to a JSON file to merge prices over the
built-in table: negotiated rates, fine-tuned or self-hosted models, partner
prices, or a price change before the next ingester release.

```json
{
  "asOf": "2026-12-01",
  "models": [
    { "match": "gpt-5.6-sol", "inputPerMTok": 5, "outputPerMTok": 25,
      "cacheReadPerMTok": 0.5, "cacheWritePerMTok": 6.25, "cacheWriteLongPerMTok": 12.5 },
    { "match": "acme-support-ft", "inputPerMTok": 1.2, "outputPerMTok": 4.8 },
    { "match": "gemini-4-carbon", "inputPerMTok": 3, "outputPerMTok": 15,
      "cacheReadPerMTok": 0.15, "effectiveFrom": "2026-12-01" }
  ]
}
```

- Rates are USD per 1M tokens. `match`, `inputPerMTok` and `outputPerMTok`
  are required; `cacheReadPerMTok`, `cacheWritePerMTok`,
  `cacheWriteLongPerMTok`, `effectiveFrom` (`YYYY-MM-DD`, the first day the
  price applies) and `source` are optional.
- An entry replaces every built-in entry with the same `match`, dated ones
  included, and adds models the table lacks. `match` follows the same
  matching rules as the table.
- Rows priced from the file record `pricing_version = 'override:<asOf>'`.
- The file is read once, at startup. A file that is not JSON, an unknown
  key (a typo such as `inputPerMtok`), a negative or non-numeric rate, a bad
  date or a model listed twice stops the ingester with every problem and its
  path, for example `models.0.inputPerMTok: must be 0 or more`.

### Why costs move after upgrading

Before 1.16.0 every input token was priced at the full input rate, and the
Autter SDK sent Anthropic input without its cache tokens. With the ingester
1.16.0 and `@autter/runtime-node` 1.14.0:

- **OpenAI and Gemini costs go down.** Their input already included cached
  tokens, which are now priced at the cache-read rate instead of the input
  rate.
- **Anthropic (and Bedrock) costs go up.** Cache reads and writes were left
  out of the input count, so they were not priced at all; they now are, at
  their cache rates.

The old numbers were wrong in both directions. History is not recomputed:
earlier rows keep their cost and show as "estimated before cache pricing".
Upgrade the ingester first, then the SDK.

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
