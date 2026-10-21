# Operation logging

Use `withRuntimeOperation`, `runtimeLogger`, and `createRuntimeLogger` to attach
application context to logs and completed operations. See the full
[operation logging guide](../../docs/OPERATION-LOGGING.md) for initialization,
steps, outcomes, redaction, export lifecycle, and release requirements.

# Requests and coded errors (1.5.0)

Requires ingester 1.5.0. One summary per request (always kept), request ids
echoed to clients, one issue per error code:

```ts
import {
  autterRequests, autterErrorResponse, defineRuntimeErrors, runtimeContext,
} from "@autter/runtime-node";

export const billingErrors = defineRuntimeErrors("billing", {
  declined: { status: 402, message: "Payment declined", expected: true,
              why: "The card issuer rejected the charge", fix: "Ask for another card" },
  limit: ({ plan }: { plan: string }) => ({ status: 429, message: `Plan ${plan} limit reached` }),
});

app.use(autterRequests({ ignore: ["/healthz", "/metrics"] }));
app.post("/checkout", async (req, res) => {
  runtimeContext.set({ cart: { items: req.body.items.length } });
  runtimeContext.info("Applied coupon", { coupon: "SPRING" });   // folded into the summary
  if (overLimit) throw billingErrors.limit({ plan: "free" });     // Express 5 (next(err) on 4)
  res.json({ ok: true, requestId: runtimeContext.requestId });
});
app.use(autterErrorResponse());   // { error: { message, code, why?, fix?, link?, requestId } }
```

Also: `autterFastify`, `withRuntimeRequest` (fetch-style handlers),
`runtimeContext.fork` / `runInBackground` / `carrier()` for background work and
queues, the per-operation AI usage rollup, `waitUntil`, `initAutterLogging`
(no NodeSDK — for apps with their own OTel), enrichers (`enrichUserAgent`,
`enrichRequestSize`, `enrichEdgeGeo`, `enrichDeployment`), sinks (`otlpSink`,
`consoleSink`, `fileSink` → `.autter/runtime/*.jsonl` in development) and test
helpers:

```ts
import { captureRuntime, expectOperation } from "@autter/runtime-node/testing";
const runtime = captureRuntime();
// … exercise the app …
expectOperation(runtime, "POST /checkout").toHaveOutcome("degraded").toHaveErrorCode("billing.declined");
```

Full guide: [Requests, coded errors and background work](../../docs/REQUESTS-AND-ERRORS.md).

# Breadcrumbs (1.6.0)

The steps before an error, scoped to the current request:

```ts
import { addBreadcrumb, runtimeLogger } from "@autter/runtime-node";

app.post("/checkout", async (req, res) => {
  addBreadcrumb({ message: "Loaded cart", data: { items: 3 } });  // type "custom"
  runtimeLogger.info("Charging card", { provider: "stripe" });     // recorded as a "log" breadcrumb
  await charge();                                                  // a throw here carries both
});
```

- Scope: inside `autterRequests()` / `withRuntimeRequest()` /
  `withRuntimeOperation()` the trail belongs to the request and is shared with
  its child operations and forks (AsyncLocalStorage). Inside a traced request
  without the middleware it belongs to the trace; outside both, to the process
  (so a crash outside any request carries what happened before it).
- The last 30 are kept. `captureException`, `captureMessage` and errors thrown
  out of operations attach them to the exception span event as
  `autter.breadcrumbs` (a JSON string, at most 16 KB, or less when
  `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` is lower).
- Every `runtimeLogger` / `runtimeContext.debug|info|warn|error` entry is
  recorded as a `log` breadcrumb with its level and up to 10 primitive
  attributes.
- Messages (≤ 500 characters) and data (≤ 10 keys of strings, numbers,
  booleans or null) are scrubbed with your `redact` settings.
- The browser relay forwards browser breadcrumbs, re-validated and re-scrubbed.
- Needs ingester 1.6.0. Logger-only mode (`initAutterLogging`) and
  `@autter/runtime-edge` don't attach them yet.

# @autter/runtime-node

The server tracker exports per-instance RSS, heap, memory limit, and GC
metrics by default. See [memory pressure incidents](../../docs/MEMORY-PRESSURE.md)
for ECS/Kubernetes OOM event forwarding and optional heap profiles. Set
`memoryMetrics: false` only if another exporter already emits equivalent
process metrics.

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
server-side, forwards asynchronously, and returns 202 immediately.

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

// fingerprint override — every error carrying the same fingerprint is one
// issue, whatever its message or stack (a string or up to 10 strings, each
// ≤200 chars; sent as `autter.fingerprint` on the exception event; needs
// ingester 1.6.0+, older ingesters ignore it):
autter.captureException(err, { fingerprint: ["checkout", "card-timeout"] });

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
| Healthy traces | 1% head sampling (`traceSampleRate`; also for requests whose incoming `traceparent` is unsampled, such as browser fetches from `@autter/runtime-browser`) |
| Request metrics | exported every 60 s |
| Logs | not collected |
| PII in custom attributes | redacted before export (`redactAttributes`) |
| Query strings in span URLs | parameter names only (`keepQueryParams`) |
| Forgotten `shutdown()` | exporters still flushed on exit (`autoFlush`) |

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

### Server errors keep their stacks

When a handler throws, the framework answers 500 — and on its own that 500
is all the tracker sees: a stackless `HttpServerError` grouped by route. Add
your framework's hook and the thrown error is recorded, with its stack, on
the request span; the framework then carries on exactly as before.

```ts
import { autterErrorHandler, autterFastifyErrors, autterKoa, captureRequestError } from "@autter/runtime-node";

// Express / Connect: after your routes, before your own error handlers.
// Records the error, then calls next(err) unchanged.
app.use(autterErrorHandler());

// Fastify 4/5: an onError hook (Fastify's error handler still answers).
// autterFastify (request summaries) already includes it.
app.register(autterFastifyErrors);   // or autterFastifyErrors(app)

// Koa 2/3: mount first; records and rethrows, so app.on("error") still fires.
app.use(autterKoa());

// Anything else (NestJS exception filters, hapi onPreResponse, …):
captureRequestError(err, { "app.handler": "checkout" });
```

All three report errors with status ≥ 500 (or none), RuntimeErrors and coded
errors — `ctx.throw(404)` and validation failures stay out of your issues.
Pass `{ capture: true }` to report every error, or a predicate. An error is
reported once, even if your handler already called `captureException`, and it
lands on the request's HTTP server span even when an instrumentation's child
span is active (`captureRequestError` still adds its attributes to that span
when the error was already reported). Errors from another JavaScript realm
(a `vm` context, Next's edge sandbox under `next start`) keep their own type,
message and stack. `autterErrorResponse()` reports the same way and also
answers the request.

### Unhandled promise rejections

Recorded as errors (severity `error`, `autter.unhandled_rejection: true`, not
fatal) — without changing whether your process crashes. Any
`unhandledRejection` listener switches off Node's default crash, so the SDK
does what Node would have done when its listener is the only one:

| `--unhandled-rejections` | Your own listener? | What happens | Recorded as |
| --- | --- | --- | --- |
| `throw` (default) | no | rethrown on the next tick: exit code 1, as before | fatal crash (`autter.unhandled`) |
| `throw` (default) | yes | your listener decides | error |
| `strict` | either | Node crashes first, as before | fatal crash |
| `warn`, `none` | either | no crash, as before | error |
| `warn-with-error-code` | no | Node's warning and exit code 1, as before | error |

The one visible difference: after the rethrow, `uncaughtException` listeners
receive origin `"uncaughtException"` rather than `"unhandledRejection"`.
`captureUnhandledRejections: false` (or `captureGlobalErrors: false`) restores
the 1.5.0 behaviour, where a rejection is seen only when it crashes the
process.

### Version compatibility: checked for you

Some features need a minimum ingester version: operation logging needs
1.4.0, memory metrics 1.3.3, endpoint latency 1.3.1. After
`initAutterServer`, the SDK checks the ingester once in the background
(`GET /v1/compat`, unref'd, 3 s timeout). For each feature in use that the
ingester can't store, it prints one warning:

```text
[autter-runtime] Operation logging needs ingester >= 1.4.0; yours is 1.3.4. Upgrade the ingester: docker pull ghcr.io/autter-dev/otlp-ingester:latest and restart it (ClickHouse migrations run at boot). See …/docs/COMPATIBILITY.md
```

The check never throws, never delays startup or exit, and is silent when
versions match or are unknown. `debug: true` logs the result. Turn it off
with `compatCheck: false` or `AUTTER_COMPAT_CHECK=0`. The browser relay does
the same for browser features such as CSP violation capture. The SDK reports
itself through the OTLP resource attributes `telemetry.distro.name` and
`telemetry.distro.version`, so the Autter dashboard shows the SDK version
each service runs.

For a full report (for example in CI or after a deploy):

```bash
npx @autter/runtime-node doctor --endpoint https://ingest.example.com [--key "$AUTTER_RUNTIME_KEY"] [--json]
```

Exit codes: 0 compatible, 1 mismatch or rejected key, 2 ingester unreachable.
See [docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

### Lifecycle: never lose telemetry to a forgotten shutdown()

Telemetry is batched (errors every ~2 s, healthy traces every ~5 s, metrics
every 60 s) — so exiting without flushing loses whatever is still buffered.
`initAutterServer` therefore installs an exit flush **by default**: on
`beforeExit`, SIGINT, and SIGTERM it force-flushes every exporter, then lets
your process die as it would have (conventional 130/143 codes). If your own
code also handles those signals, Autter only flushes alongside it and never
touches your exit path. Opt out with `autoFlush: false`.

Prefer explicit control? Do the same yourself and get a handle back:

```ts
import { installAutterAutoFlush } from "@autter/runtime-node";

const handle = installAutterAutoFlush(); // uses the active server's exporters
// …later: handle.flush("deploy-drain") or handle.dispose()
```

If the process still exits with captures that were never confirmed
exported (e.g. a flush timed out), you get a one-line stderr warning — not
silent loss. While wiring things up, set `debug: true` (or `AUTTER_DEBUG=1`)
to see `[autter] exported N span(s)` lines on stderr as batches leave.

Note on usage rollups: requests are counted from the `http.server.duration`
metric (100% accurate), never from sampled server spans: the SDK marks its
resource `autter.metrics_wired` and the ingester keeps its spans out of the
span-fed rollups, whatever `traceSampleRate` is. Ingesters up to 1.7.0
ignored the mark and also counted sampled server spans (at
`traceSampleRate: 1`, about twice the requests); they did skip
tail-retained error traces, whose spans carry `autter.tail_retained`.

### Privacy: secrets and PII are scrubbed before they leave the process

Error context is where secrets leak: `connect ECONNREFUSED
postgres://admin:hunter2@db…` in an exception message, a provider error
echoing an API key, a `?token=` in a request URL, a stray
`captureException(err, { "user.email": … })`. Everything the SDK exports is
therefore scrubbed by default — custom attributes, exception messages and
stack traces, span status messages, LLM call attributes and errors,
structured logs, and the browser events the relay forwards. A final pass at
export time scrubs every span regardless of who created it (HTTP
instrumentation URLs, third-party instrumentations, `recordException` in
your own code).

- secrets inside any string are masked in place, keeping the rest of the
  message/stack readable: JWTs, `Bearer`/`Basic` credentials,
  `Authorization:`/`Cookie:`/`Set-Cookie:` header text,
  `scheme://user:pass@host` connection strings (postgres, mysql,
  mongodb+srv, redis, …), vendor keys (`sk-…`, `sk_live_…`, `ghp_…`,
  `github_pat_…`, `xox?-…`, `AIza…`, `AKIA…`, …), PEM private keys,
  `password=`/`?token=`/`?api_key=`-style assignments, emails, and
  Luhn-valid card numbers;
- attributes whose **key** looks sensitive (`password`, `token`, `secret`,
  `api_key`, `authorization`, `cookie`, `session`, `ssn`, `card_number`, …)
  are masked wholesale, at any nesting depth;
- non-sensitive keys, numbers (including LLM token counts) and booleans pass
  through untouched, so grouping, dashboards and cost tracking keep working.

The same patterns run in the browser SDK, the relay, the Python adapter,
and again in the ingester before storage (shared test vectors in
`test-vectors/redaction.json`).

Extend it (applies to messages, stacks and URLs too) or disable it per
service:

```ts
initAutterServer({
  ...,
  // redactAttributes: false,            // opt out entirely
  redactAttributes: {
    additionalKeyPatterns: ["employee_id"],
    additionalValuePatterns: [/^ACC-\d+$/],
  },
});
```

Libraries that must never forward PII regardless of host configuration can
wrap once:

```ts
import { makeSafeCapture } from "@autter/runtime-node";
const safe = makeSafeCapture();
safe.captureException(err, { "user.email": email }); // masked before export
```

The raw primitives are exported too (`redactAttributes(attrs, options)`,
`redactText(text, options)`). The browser relay takes the same options as
`createBrowserRelayHandler({ ..., redact })`.
This closes the server-side gap to match the browser relay's payload
whitelist; it is best-effort scrubbing of obvious PII shapes, not a DLP
engine — keep secrets out of attributes in the first place.

**Query strings (1.6.1+).** Query strings carry what a path never should:
emails, one-time codes, API keys, session ids, search terms. So no span
leaves the process with query values, whichever instrumentation made it
(HTTP server and client spans, undici/fetch, Express, Fastify, Next.js's own
spans):

- `http.target`, `http.url`, `url.full` and `url.original` are cut at the `?`
  (and `#`): `/search?email=jane@example.com&page=2` becomes `/search`;
- `url.query` keeps only the parameter names, `email=[redacted]&page=[redacted]`.
  It is added from the URL when the instrumentation did not set it, so you
  still see which parameters a request used. A parameter without `=`
  (`/verify?<token>`) may itself be the secret and is masked whole;
- span names lose their query too (Next.js names a request span
  `GET /search?q=…` until it knows the route).

List the parameters whose values are safe to keep, such as pagination or
sorting (exact names, after percent-decoding; kept values are still scrubbed
by `redactAttributes`):

```ts
initAutterServer({ ..., keepQueryParams: ["page", "sort"] });
// url.query: "email=[redacted]&page=2"
```

This runs at export, like the scrubbing above, and also with
`redactAttributes: false`. Route templates (`http.route`) and request
summaries never contained a query.

### One SDK per process, however many copies are loaded

Bundlers can load this package more than once: Next.js bundles one copy
into `instrumentation.ts` and another into each route (unless it is in
`serverExternalPackages`), and a process can load both the ESM and the CJS
build. Since 1.6.1 every copy shares one process-wide state
(`globalThis[Symbol.for("@autter/runtime-node")]`): the copy that ran
`initAutterServer` (or `initAutterLogging`) is the SDK for all of them, so
`withRuntimeRequest`, `captureException`, `runtimeLogger` and the rest export
through it from any copy, and an error one copy reported is never reported
again by another. Before any copy starts, and after `shutdown()`, every copy
behaves as before: records go to the console. The shared object is
versioned; a copy that finds a layout it does not know keeps its own state.

## 3. LLM tracing

For the field contract, manual reporting patterns, and provider-agnostic
OpenTelemetry setup, see the dedicated [LLM instrumentation guide](../../docs/LLM-INSTRUMENTATION.md).

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