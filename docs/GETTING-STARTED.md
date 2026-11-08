# Operation logging

For structured messages, completed operation summaries, and explicit outcomes,
see [Operation logging and diagnostic context](OPERATION-LOGGING.md). These APIs
require the updated Node/Next.js SDK and ingester described in that guide.

# Getting started

Already collecting logs in an external provider? See [External sources](EXTERNAL-SOURCES.md) for repository connectors. The SDK/OTel setup below applies when you instrument application code.

Autter Runtime tracks **runtime errors and usage** from your frontend and
backend with two small packages and one ingest endpoint. This guide takes
you from zero to seeing data in ClickHouse.

- [1. Concepts (2 minutes)](#1-concepts)
- [2. Run the ingester](#2-run-the-ingester), then [check it in one command](#check-it-before-you-instrument-anything)
- [3. Instrument your backend](#3-instrument-your-backend)
- [LLM instrumentation guide](LLM-INSTRUMENTATION.md)
- [4. Instrument your frontend](#4-instrument-your-frontend)
- [5. Next.js: both in one package](#5-nextjs-both-in-one-package)
- [6. Other languages (Go, Rust, Python, …)](#6-other-languages)
- [7. See your own events](#7-see-your-own-events)
- [8. Production checklist](#8-production-checklist)

## 1. Concepts

**Two kinds of keys.** Never mix them up:

| | Server key | Client key |
| --- | --- | --- |
| Looks like | `autter_rt_…` | `autter_rtc_…` |
| Secrecy | **secret** — env vars only, never in a browser bundle | **publishable** — safe to ship in frontend JS |
| Can send | OTLP traces + metrics + logs, browser events | browser events only (`/v1/browser`) |
| Extra protection | — | per-key origin allow-list, tighter rate limit |

**Two ways to send browser events:**

- **Relay (recommended when you have a backend):** the browser posts to a
  route on *your* server; that route forwards to the ingester using your
  server key. No key in the browser, immune to ad-blockers, no CSP changes,
  and you can inspect every payload before it leaves your infrastructure.
- **Direct (static sites / no backend):** the browser posts straight to the
  ingester with a client key. One-line setup; the key is origin-restricted
  and write-only.

**What gets captured:**

| Signal | Frontend | Backend |
| --- | --- | --- |
| Unhandled errors / rejections | ✅ automatic | ✅ automatic |
| Handled errors | `captureException(err)` | `captureException(err)` |
| Usage | session pings + `trackEvent()` | request counts/durations per route (automatic) |
| Traces | — (by design; no OTel in the browser) | ~1% sampled, plus **every erroring trace kept in full** |
| Request summaries | request id on failed fetch/XHR (links to the server request) | one record per request with route, status, outcome, context, inline messages — **always kept** (`autterRequests`, 1.5.0) |
| Coded errors | `code`/`why`/`fix` duck-typed by `captureException` | `defineRuntimeErrors` / any error with `code` — **one issue per code** |
| LLM usage & cost | — | `withLlmCall()` / Vercel AI SDK telemetry / GenAI semconv — always 100% (model, tokens, cost) |

**What is never sent:** cookies, DOM content, form values, request/response
bodies, headers, emails, full URLs with query strings. On the backend,
custom attributes are additionally scrubbed before export: values that look
like emails/tokens/credentials and attributes with sensitive keys
(`password`, `api_key`, …) are masked by default (`redactAttributes`), so a
stray `captureException(err, { "user.email": … })` doesn't leak PII.

## 2. Run the ingester

The ingester is a small stateless service that receives everything and
writes ClickHouse. For a local try-out:

```bash
git clone https://github.com/Autter-dev/autter-runtime
cd autter-runtime
docker compose up   # ClickHouse + ingester on http://localhost:4318
```

No key step: the compose file starts the ingester in local dev mode, which
accepts the built-in key `autter_rt_local_dev_only` from your own machine.
Use these two values in your app while you try it out:

```bash
AUTTER_ENDPOINT=http://localhost:4318
AUTTER_RUNTIME_KEY=autter_rt_local_dev_only
```

The local key is not a secret and works nowhere else. The ingester refuses
it from other networks, and only accepts it when `AUTTER_LOCAL_DEV=1` is set,
which only the repo's `docker-compose.yml` does. A deployed ingester
(`deploy/single-server`, `deploy/aws`, or Autter cloud at
`https://otlp.autter.dev`) needs a real key. To use your own key locally as
well, put its mapping in the git-ignored `.env` file before `docker compose up`;
both keys then work:

```bash
export AUTTER_RUNTIME_KEY="autter_rt_$(openssl rand -hex 16)"
(umask 077 && printf 'AUTTER_INGEST_KEYS=[{"key":"%s","orgId":"local","repositoryId":"local"}]\n' "$AUTTER_RUNTIME_KEY" > .env)
```

### Check it before you instrument anything

From any directory with Node 20+ (no install needed), with the two values
above exported:

```bash
npx @autter/runtime-node doctor    # versions, storage, key: sends nothing
npx @autter/runtime-node verify    # sends a test event and reads it back
```

`verify` goes through key, network, ingester, storage, auth, ingest,
stored, trace, release and logs, and stops at the first step that fails with
what to do. Its test event never opens an issue. Run it again whenever
events don't show up: it is the first thing to check. Python services:
`python3 adapters/python/compat.py verify`. Details, sampling and arrival
times: [Is my data arriving?](DELIVERY.md).

> **That's all the clone is for.** It runs the ingester — you never add
> code to this checkout. Every step from here on (installing packages,
> creating `instrument.cjs`, …) happens in **your application's
> repository**, the app you want to monitor.

For real deployments, configure keys via env (or point
`AUTTER_KEY_VALIDATOR_URL` at your own key service):

```bash
AUTTER_INGEST_KEYS='[
  {"key":"autter_rt_REPLACE_ME","orgId":"my-org","repositoryId":"my-app"},
  {"key":"autter_rtc_REPLACE_ME","orgId":"my-org","repositoryId":"my-app",
   "scope":"client","allowedOrigins":["https://app.example.com"]}
]'
CLICKHOUSE_URL=https://your-clickhouse:8443
CLICKHOUSE_PASSWORD=…
```

Generate keys with anything random enough, e.g.
`echo "autter_rt_$(openssl rand -hex 16)"`. One key pair per
app/repository — the `repositoryId` is how data is grouped for analysis.
Full config reference: [`packages/otlp-ingester`](../packages/otlp-ingester).

## 3. Instrument your backend

In **your app's repository** (not the `autter-runtime` checkout from
step 2):

```bash
npm install @autter/runtime-node
```

In **your application's repository** — a separate codebase from the
`autter-runtime` repo you cloned in step 2 — create `instrument.cjs` next to
the entry point of the service you are instrumenting (one file per service in
a monorepo). It must load **before** your app:

```js
const { initAutterServer } = require("@autter/runtime-node");

initAutterServer({
  apiKey: process.env.AUTTER_RUNTIME_KEY,        // server key
  endpoint: process.env.AUTTER_ENDPOINT,          // your ingester URL (below)
  service: "payments-api",
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,                   // enables "broke in release X"
});
```

```bash
# Local try-out, against the compose ingester from step 2:
AUTTER_ENDPOINT=http://localhost:4318 AUTTER_RUNTIME_KEY=autter_rt_local_dev_only \
  node --require ./instrument.cjs server.js

# Autter cloud: https://otlp.autter.dev and the server key from your
# repository's Runtime settings. Self-hosted: your ingester's URL, e.g.
# https://ingest.example.com, and a key from its AUTTER_INGEST_KEYS.
```

`AUTTER_ENDPOINT` is the ingester's base URL, without `/v1/...`. If you
leave `endpoint` out, the SDK sends to Autter cloud (`https://otlp.autter.dev`).

That alone gives you: every incoming HTTP request traced-and-sampled,
request/error/duration rollups per route, crashes and unhandled promise
rejections captured (without changing whether your process crashes, and
with the route and request id of the request that started the promise), the
error behind every Express 5xx with its type, message and stack, and the
full trace of any request that errors — erroring traces are retained even
when the sampler wouldn't have kept them, so every issue keeps the trace that
explains it.

Then add request summaries and your framework's error hook:

```js
const { autterRequests, autterErrorHandler, autterFastifyErrors, autterKoa } = require("@autter/runtime-node");

// Express
app.use(autterRequests());            // first: request ids (x-request-id) and one summary per request
// ... your routes and routers ...
app.use(autterErrorHandler());        // after your routes, before your own error handlers

app.register(autterFastifyErrors);    // Fastify (without it, a thrown error is only a stackless 500)
app.use(autterKoa());                 // Koa: first (same)
```

Each records the error on the request span and lets the framework handle it
as before. On Express the SDK already records the error behind a 5xx without
the hook, in any router, nested ones with their own error handler included;
`autterErrorHandler()` adds coded errors that end in a 4xx, and it never
reports an error twice. One at app level is enough. For handled errors:

```js
const { captureException } = require("@autter/runtime-node");

try {
  await chargeCard(order);
} catch (err) {
  captureException(err, { "order.id": order.id });
  throw err;
}
```

A run that returns normally but did not do its job (a declined payment, an
empty import) is not an exception. Declare it, so it becomes an issue:

```js
const { reportOutcome } = require("@autter/runtime-node");

if (!payment.confirmed) reportOutcome("checkout", "payment was not confirmed");
```

Inside `withRuntimeOperation(name, fn)`, `operation.outcome("failed", message)`
does the same with the operation's steps and context attached
([Operation logging](OPERATION-LOGGING.md)).

Test it without an ingester: `@autter/runtime-node/testing` keeps every
record in memory, so a unit test can assert what would be sent:

```js
const { captureRuntime, expectOperation } = require("@autter/runtime-node/testing");

const runtime = captureRuntime();
await request(app).post("/checkout").expect(402);
expectOperation(runtime, "POST /checkout").toHaveOutcome("degraded");
runtime.stop();
```

Then check the real path: `npx @autter/runtime-node verify --service payments-api`.

ESM-only app? Use `--import` plus OTel's loader hook (see the
[package README](../packages/runtime-node)). Express route timings can be
enriched with `@opentelemetry/instrumentation-express` via the
`instrumentations` option.

### Request summaries and coded errors (1.5.0)

Requires ingester 1.5.0. One record per request, always kept, with the request
id echoed to the client:

```js
const { autterRequests, autterErrorResponse, defineRuntimeErrors, runtimeContext } =
  require("@autter/runtime-node");

const billingErrors = defineRuntimeErrors("billing", {
  declined: { status: 402, message: "Payment declined", expected: true,
              fix: "Ask the customer for another card" },
});

app.use(autterRequests({ ignore: ["/healthz"] }));   // before your routes
app.post("/checkout", async (req, res) => {
  runtimeContext.set({ cart: { items: req.body.items.length } });
  if (!(await charge(req.body))) throw billingErrors.declined();  // Express 5; next(err) on 4
  res.json({ ok: true });
});
app.use(autterErrorResponse());                       // after your routes
```

Errors with the same code become one issue; `expected` ones are recorded but
never open incidents. Already running your own OpenTelemetry SDK? Use
`initAutterLogging` instead of `initAutterServer`. In development, records are
also written to `.autter/runtime/*.jsonl` (add `.autter/` to `.gitignore`).
Everything else — `runtimeContext`, background work and queues, AI usage per
request, testing helpers, edge runtimes:
[Requests, coded errors and background work](REQUESTS-AND-ERRORS.md).

### Track LLM usage & cost

For the complete `withLlmCall` / `trackLlmCall` API, emitted `gen_ai.*`
attributes, and cross-language OTLP conventions, see the
[LLM instrumentation guide](LLM-INSTRUMENTATION.md).

`initAutterServer` initialises LLM tracing too: every recognised LLM call
is recorded 100% (an LLM-aware sampler keeps GenAI spans even at 1% trace
sampling) with model, tokens, latency, and a USD cost — estimated from a
built-in price table unless you report the exact figure. Three ways to emit
calls, easiest first:

```ts
// 1. Wrap the client once — OpenAI/Anthropic/Google SDKs, streaming included:
import { instrumentLlmClient } from "@autter/runtime-node";
const openai = instrumentLlmClient(new OpenAI());

// 2. Vercel AI SDK — turn on its telemetry, nothing else:
const { text } = await generateText({
  model: openai("gpt-5-mini"),
  prompt,
  experimental_telemetry: {
    isEnabled: true,
    metadata: { userId: user.id },   // → per-user cost attribution
  },
});

// 3. Raw fetch / anything else — wrap the call manually:
import { withLlmCall } from "@autter/runtime-node";
const res = await withLlmCall(
  { provider: "openai", model: "gpt-5-mini", userId: user.id },
  async (llm) => {
    const out = await openai.chat.completions.create({ ... });
    llm.setUsage({ inputTokens: out.usage?.prompt_tokens,
                   outputTokens: out.usage?.completion_tokens });
    return out;
  },
);
```

Or report after the fact with
`trackLlmCall({ provider, model, inputTokens, outputTokens, durationMs })`.
Python/Go/etc. need no Autter package: any OTel GenAI instrumentation
(OpenLLMetry, OpenLIT, the official contrib packages) emitting `gen_ai.*`
spans through the OTLP endpoint is recognised the same way.

Verify the pipe without spending a token — `emitLlmSelftestTrace()` sends
one clearly-named fake call, flushes it, and returns the `traceId` to look
up:

```ts
import { emitLlmSelftestTrace } from "@autter/runtime-node";
console.log(await emitLlmSelftestTrace()); // { traceId: "…", ok: true, errors: [] }
// Never rejects: ok: false with errors (e.g. kind "unauthorized", status 401
// for a key the ingester does not accept) when the trace was not delivered.
```

## 4. Instrument your frontend

```bash
npm install @autter/runtime-browser
```

### Option A — relay (recommended with a backend)

Add one route to your backend (the key stays server-side):

```js
// Express
const { createBrowserRelayHandler } = require("@autter/runtime-node");
app.post("/api/autter-runtime",
  createBrowserRelayHandler({ apiKey: process.env.AUTTER_RUNTIME_KEY,
                              endpoint: process.env.AUTTER_ENDPOINT }));
```

Then in your frontend entry point:

```ts
import { initAutterBrowser } from "@autter/runtime-browser";

initAutterBrowser({
  endpoint: "/api/autter-runtime",   // same-origin — no key here
  service: "web-app",
  release: import.meta.env.VITE_GIT_SHA,
});
```

### Option B — direct (static sites, no backend)

```ts
initAutterBrowser({
  endpoint: "https://your-ingester.example.com/v1/browser",
  clientKey: "autter_rtc_…",         // publishable client key
  service: "marketing-site",
});
```

### Using it

Unhandled errors and promise rejections are captured automatically. Then:

```ts
import { captureException, trackEvent, setUser } from "@autter/runtime-browser";

captureException(err, { operation: "start-checkout" }); // handled errors
trackEvent("clicked_upgrade");                          // usage counters
setUser("u_8f2k1");                                     // opaque id — never an email
```

React render errors don't reach `window.onerror` — add the boundary
(exported from `@autter/runtime-next/client`, works in any React app):

```tsx
<AutterErrorBoundary fallback={<ErrorPage />}>
  <App />
</AutterErrorBoundary>
```

## 5. Next.js: both in one package

```bash
npm install @autter/runtime-next
```

Three files and you have server tracing, browser tracking, the relay, and
the error boundary — see the
[`@autter/runtime-next` README](../packages/runtime-next) for the exact
snippets (`instrumentation.ts`, `app/api/autter-runtime/route.ts`, and a
client component). `serverExternalPackages: ["@autter/runtime-node"]` in
`next.config` is recommended to keep the SDK out of your route bundles;
routes share the SDK that `registerAutter` starts either way (1.6.1+).
Wrap route handlers in `withRuntimeRequest` for request summaries;
`middleware.ts` uses `@autter/runtime-next/edge`.

Errors Next catches itself — in server components, server actions, route
handlers and middleware — reach Autter with their stack through Next 15's
`onRequestError`. Add it to `instrumentation.ts`, next to `register()`:

```ts
import { autterOnRequestError } from "@autter/runtime-next/instrumentation";

export const onRequestError = autterOnRequestError({
  // Only for errors on the edge runtime (middleware, edge routes):
  edge: { apiKey: process.env.AUTTER_RUNTIME_KEY, service: "web-app" },
});
```

Cloudflare Workers, Vercel Edge, Deno or Bun without Next.js:
`npm install @autter/runtime-edge` and wrap the fetch handler in `withAutter`
(see [the package README](../packages/runtime-edge)).

## 6. Other languages

The OTLP endpoints accept standard OpenTelemetry over HTTP (protobuf or
JSON, gzip ok), so Go, Rust, Python, Java, .NET etc. need no Autter
package at all — configure the SDK you already use:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-ingester.example.com
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${AUTTER_RUNTIME_KEY}"
OTEL_SERVICE_NAME=payments-api
OTEL_RESOURCE_ATTRIBUTES=service.version=${GIT_SHA},deployment.environment=production
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.01
```

Errors become issues when spans record exceptions
(`span.RecordError(err)` in Go, `record_exception` in Python, …) or carry
`ERROR` status. The ratio sampler above drops the errors of the traces it
drops; Python services keep them with `adapters/python/autter_tracing.py`
([Python](INTEGRATIONS.md#python-django-fastapi-flask-celery)), other SDKs as
described in [INTEGRATIONS.md](INTEGRATIONS.md#java--ruby--net--anything-else).
Per-language snippets: [INTEGRATIONS.md](INTEGRATIONS.md).

LLM calls need no Autter package either: any OTel GenAI instrumentation
(`gen_ai.*` spans — e.g. `opentelemetry-instrumentation-openai-v2` in
Python) is recognised automatically. One caveat: make sure your sampler
doesn't drop them — the 1% ratio above applies to everything, so either
exempt GenAI spans in a custom sampler or route them through an always-on
tracer provider. See
[INTEGRATIONS.md § LLM / GenAI calls](INTEGRATIONS.md#llm--genai-calls-any-language).

## 7. See your own events

`verify` (step 2) proves the path works. From your app's directory it also
compares your installed SDK versions with the ingester's:

```bash
npx @autter/runtime-node verify --endpoint http://localhost:4318 --key autter_rt_local_dev_only --service payments-api
```

Every line should say `ok` (or `warn` for no release) and it exits 0.
Against another ingester, pass its URL and leave out `--key` (it reads
`AUTTER_RUNTIME_KEY`). If a step fails, it says which and what to do; your
app also prints one line the first time the ingester refuses its key or a
route ([what the SDKs tell you](DELIVERY.md#what-the-sdks-tell-you)).

Then see your app's own event. Trigger an error in your app (a route that throws, or
`captureException(new Error("hello from my app"))`), wait a few seconds for
the batch to flush, and read it back from the local ClickHouse:

```bash
docker compose exec clickhouse clickhouse-client --password dev --query "
  SELECT service, error_type, message, occurred_at
  FROM autter_runtime.runtime_error_occurrences
  ORDER BY occurred_at DESC LIMIT 5"
```

Run it in the `autter-runtime` checkout from step 2. A row with your
service name means your app's path works. No row while `verify` passes:
your app sends somewhere else or with another key. Check its logs for the
endpoint it prints and for an `[autter-runtime]` warning. Server errors take
up to 2 s, sampled traces 5 s and request counts up to 60 s to arrive
([arrival times](DELIVERY.md#when-it-arrives)).

More queries:

```sql
SELECT service, error_type, message, route, occurred_at
FROM autter_runtime.runtime_error_occurrences
ORDER BY occurred_at DESC LIMIT 10;

SELECT service, route, sum(request_count) AS requests, sum(error_count) AS errors
FROM autter_runtime.runtime_metrics_1m
WHERE bucket_at > now() - INTERVAL 1 HOUR
GROUP BY service, route;

-- Request summaries (runtime-node 1.5.0 + autterRequests)
SELECT occurred_at, operation, route, status_code, outcome, request_id, error_code
FROM autter_runtime.runtime_logs
WHERE kind = 'request'
ORDER BY occurred_at DESC LIMIT 10;

-- LLM calls (after emitLlmSelftestTrace() or a real traced model call)
SELECT service, provider, model, input_tokens, output_tokens,
       cost_usd, cost_source, status, started_at
FROM autter_runtime.runtime_llm_calls
ORDER BY started_at DESC LIMIT 10;
```

With the local compose setup: `docker compose exec clickhouse
clickhouse-client --password dev`.

## 8. Production checklist

- [ ] Server keys only in backend env vars; client keys only where a relay
      is genuinely impossible.
- [ ] Client keys have `allowedOrigins` set to your exact app origins (a
      client key with none accepts no origin; add your dev origin, e.g.
      `http://localhost:3000`, if you test locally with it).
- [ ] `release` is wired to your git SHA in **both** frontend and backend —
      it's what powers regression detection ("broke in release X").
- [ ] Request summaries are always kept: `ignore` health checks and metrics
      scrapes in `autterRequests`, and size `LOG_TTL_DAYS` at the ingester.
- [ ] Error codes are stable and low-cardinality — never ids or user data.
- [ ] Keep trace sampling at ~1% (`traceSampleRate`) — errors are always
      captured regardless, and the full trace of an erroring request is
      retained (`retainTracesOnError`, on by default), so cheap sampling
      doesn't cost you debugging context.
- [ ] The relay route keeps its built-in per-IP rate limit (or your WAF
      covers it: `perIpRateLimit: false`).
- [ ] The relay's default `trustProxy: "auto"` keys each visitor behind
      load balancers, CDNs and hosting platforms. Set a hop count only for a
      Node origin behind a public CDN with no load balancer (`trustProxy: 1`
      behind Cloudflare), and `trustProxy: false` or `clientIp` for a fetch
      handler exposed with no proxy at all.
- [ ] Direct browser ingest: your CSP includes
      `connect-src https://your-ingester…`, and you accept that ad-blockers
      may drop some events (the relay avoids this).
- [ ] The ingester's `/healthz` is wired to your load-balancer health check.
