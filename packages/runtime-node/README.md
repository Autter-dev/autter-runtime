# @autter/runtime-node

Autter Runtime for Node.js — two halves in one package:

1. **Same-origin browser relay** for `@autter/runtime-browser`
2. **Curated OpenTelemetry server tracker** exporting OTLP/HTTP JSON

## Install

```bash
npm install @autter/runtime-node
```

## 1. Browser relay

The browser tracker posts to your backend; this handler validates and
whitelist-sanitises the payload, attaches your private ingest key
server-side, and returns 202 only after the ingester accepts the batch. This
lets the browser SDK retry transient end-to-end delivery failures. When the
ingester refuses the batch (bad key, rate limit, …), the relay passes the
ingester's rejection reason back as JSON so the refusal is explainable
browser-side via `onDrop`.

Express / Node http:

```ts
import { createBrowserRelayHandler } from "@autter/runtime-node";

app.post(
  "/api/autter-runtime",
  createBrowserRelayHandler({ apiKey: process.env.AUTTER_RUNTIME_KEY! }),
);
```

Next.js App Router / any fetch-style runtime:

```ts
import { createBrowserRelayFetchHandler } from "@autter/runtime-node";

export const POST = createBrowserRelayFetchHandler({
  apiKey: process.env.AUTTER_RUNTIME_KEY!,
});
```

Options: `endpoint` (default `https://otlp.autter.dev`), `maxBodyBytes`
(default 64 KB), `onError`.

## 2. Server tracker

```ts
// instrument.ts — must run before anything else creates connections
import { initAutterServer } from "@autter/runtime-node";

const autter = initAutterServer({
  apiKey: process.env.AUTTER_RUNTIME_KEY!,
  service: "payments-api",
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,
});

// handled errors — always recorded, never sampled out:
autter.captureException(err, { "order.id": "…" });

// warnings/info without an exception — same grouping+aggregation as
// errors, just a lower severity ("fatal" | "error" | "warning" | "info"):
autter.captureMessage("Legacy /orders lookup used", "warning");

// named process spans — background jobs, queue consumers, cron ticks,
// DB-heavy calls. Always recorded (never head-sampled), so Autter's
// slow-process monitor sees accurate run counts and durations, and can
// flag the process when it is slow and repeating a lot:
await autter.withProcessSpan("invoice.rebuild", async () => {
  await rebuildInvoices();
});

// graceful shutdown flushes exporters:
await autter.shutdown();
```

Run it first: `node --require ./instrument.cjs server.js` (CJS), or for
pure-ESM apps add OTel's loader hook
(`node --import ./instrument.mjs --experimental-loader=@opentelemetry/instrumentation/hook.mjs server.js`)
so `http` auto-instrumentation can patch ESM imports.

Defaults (cheap by construction):

| Signal | Default |
| --- | --- |
| Captured/unhandled exceptions | 100% (dedicated always-on tracer) |
| Traces containing an error | 100% (tail retention, `retainTracesOnError`) |
| `withProcessSpan` spans | 100% (same always-on tracer) |
| LLM/GenAI call spans | 100% (`llmTracing`, on by default) |
| Healthy traces | 1% head sampling (`traceSampleRate`) |
| Request metrics | exported every 60 s |
| Logs | not collected |

**Error-linked trace retention.** Errors export at 100% while traces are
head-sampled — on its own that strands a retained error without the trace
that explains it. So unsampled spans are kept briefly in an in-process
buffer, and the moment a trace shows an error — a 5xx response, a recorded
exception, `captureException`, or an error-severity `captureMessage` — the
whole trace is exported, sampling lottery notwithstanding. The buffer is
bounded (256 spans per trace, 5 000 spans total, dropped as soon as the
request ends healthy, 30 s TTL), degrades to plain head sampling on
overflow, and never blocks. Disable with `retainTracesOnError: false`.

Crashes are observed via `process.uncaughtExceptionMonitor`, which does
**not** change your process's exit behaviour; the final flush is
best-effort. Framework instrumentations are opt-in:

```ts
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
initAutterServer({ ..., instrumentations: [new ExpressInstrumentation()] });
```

Note on usage rollups: requests are counted from the `http.server.duration`
metric (100% accurate) and additionally from sampled server spans. At the
default 1% sampling the span contribution is negligible; if you set
`traceSampleRate: 1` in development, expect request counts roughly doubled.
Tail-retained error traces don't distort this: their spans carry
`autter.tail_retained` and the ingester keeps them out of span-fed rollups.

## 3. LLM tracing

`initAutterServer` initialises LLM tracing automatically: any GenAI span —
`gen_ai.*` semconv attributes or the Vercel AI SDK's `ai.*` spans — bypasses
head sampling, so **every** model call is recorded with model, tokens,
latency, and a USD cost. Opt out with `llmTracing: false`.

**Easiest: wrap the client once** — works with the OpenAI, Anthropic, and
Google GenAI SDKs (or anything with the same call shapes), streaming
included; every call through it is traced with no per-call code:

```ts
import { instrumentLlmClient } from "@autter/runtime-node";

const openai = instrumentLlmClient(new OpenAI());
// use it exactly as before — chat, embeddings, streams are all recorded
const out = await openai.chat.completions.create({ model: "gpt-5-mini", ... });
```

Provider is detected from the client (override with
`{ provider, userId, attributes }` as the second argument). For streamed
responses the span closes when the stream is consumed; OpenAI streams only
report token usage when you pass
`stream_options: { include_usage: true }`.

**Vercel AI SDK** — just turn on its telemetry, nothing else:

```ts
const { text } = await generateText({
  model: openai("gpt-5-mini"),
  prompt,
  experimental_telemetry: { isEnabled: true, metadata: { userId: user.id } },
});
```

**Manual control** (raw fetch, unusual clients) — wrap the call:

```ts
import { withLlmCall } from "@autter/runtime-node";

const res = await withLlmCall(
  { provider: "openai", model: "gpt-5-mini", userId: user.id },
  async (llm) => {
    const out = await openai.chat.completions.create({ ... });
    llm.setUsage({
      inputTokens: out.usage?.prompt_tokens,
      outputTokens: out.usage?.completion_tokens,
    });
    return out;
  },
);
```

Errors thrown inside are rethrown after marking the span failed — failing
model calls surface both as error issues and as `status: "error"` LLM calls.
Costs are estimated ingest-side from a built-in price table; report exact
figures with `llm.setCost(usd)` (the `autter.llm.cost_usd` attribute).

Where wrapping is awkward (queues, callbacks, batch results), report after
the fact with
`trackLlmCall({ provider, model, inputTokens, outputTokens, durationMs })`.

To verify the pipe end-to-end without calling a real model:

```ts
import { emitLlmSelftestTrace } from "@autter/runtime-node";

const { traceId } = await emitLlmSelftestTrace();
// one fake "autter-selftest" call is flushed to the ingester; look it up by
// traceId in the dashboard's LLM tab (or runtime_llm_calls when self-hosting)
```

## 4. Process spans (jobs, consumers, crons)

Non-HTTP work is only visible to the slow-process monitor where a span
exists — and regular traces are 1% sampled. `withProcessSpan` records a
span **always**:

```ts
import { withProcessSpan } from "@autter/runtime-node";

await withProcessSpan("invoice.rebuild", async () => {
  await rebuildInvoices();
});
```

Use stable, low-cardinality names; put ids in attributes
(`withProcessSpan("email.digest", fn, { "user.id": id })`).

Note on the slow-process monitor: Autter flags HTTP routes from the
unsampled request metrics, so route detection works out of the box. Non-HTTP
work is only visible where a span exists — relying on 1%-sampled regular
traces there would undercount ~100×, which is why these spans skip head
sampling.
