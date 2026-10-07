# Requests, coded errors and background work

Request wide events and coded errors start in `@autter/runtime-node` and
`@autter/runtime-next` **1.5.0** and the new `@autter/runtime-edge` **1.0.0**.
Upgrade the ingester to **1.5.0** first: it stores the new request columns
(`kind`, `request_id`, `route`, `status_code`, `error_code`, AI totals), groups
coded errors by code, and promotes log-captured exceptions to issues. Older
ingesters accept the records but ignore the new fields.

Everything here is additive. 1.4.0 code keeps working unchanged; see
[OPERATION-LOGGING.md](OPERATION-LOGGING.md) for operations, steps and limits.

## Request summaries

One record per HTTP request, emitted when the response finishes (or the
connection closes). It carries the method, route template, status, outcome,
duration, the request id, every context value set during the request, inline
messages, the AI usage rollup and any coded error. Summaries are **always kept**:
there is no sampler. The only volume controls are `ignore`, field budgets and
the ingester's `LOG_TTL_DAYS`.

```ts
import express from "express";
import { initAutterServer, autterRequests, autterErrorResponse } from "@autter/runtime-node";

initAutterServer({ apiKey: process.env.AUTTER_RUNTIME_KEY!, service: "payments-api" });

const app = express();
app.use(autterRequests({ ignore: ["/healthz", "/metrics"] }));   // early, before routers
app.use(express.json());
// … routes …
app.use(autterErrorResponse());                                   // last
```

| Framework | Entry point |
| --- | --- |
| Express / Connect | `app.use(autterRequests(options))` |
| Fastify 4/5 | `app.register(autterFastify, options)` (no fastify dependency; skips encapsulation) |
| fetch-style handlers (Hono on Node, Remix, plain `Request → Response`) | `withRuntimeRequest(handler, { name?, route?, waitUntil? })` |
| Next.js route handlers | `withRuntimeRequest` from `@autter/runtime-next` (wires `after()`) |
| Plain `node:http` | `logging: { requests: true }` — experimental, see below |
| Workers / Vercel Edge / Deno / Bun | `withAutter` from `@autter/runtime-edge` |

Options: `ignore` (path globs; `*` is one segment, `**` any depth),
`requestIdHeader` (default `x-request-id`), `trustRequestId` (default `true`).

**Name and route.** The summary is named `METHOD /route/template`. Express and
Fastify supply the matched template (`/api/users/:id`). Fetch wrappers use
`name`/`route` when given, otherwise the pathname with id-like segments
(numbers, UUIDs, long hex) replaced by `:id` — the ingester's rules.

**Attributes.** `autter.operation.kind = "request"`, `http.request.method`,
`http.route`, `http.response.status_code`, `autter.request.aborted`
(`close` before `finish`), `autter.request.id`, plus everything below.

**Outcome.** An explicit `runtimeContext.outcome()` wins. Otherwise an
**expected** coded error → `degraded`; a thrown error (one that reached the
error middleware or escaped a fetch handler) or status ≥ 500 → `failed`; an
aborted request → `cancelled`; anything else → `succeeded`.

### Request ids

An inbound `x-request-id` matching `^[\w.-]{8,128}$` is honoured; anything else
is replaced with `crypto.randomUUID()`. The id is set on the response header, on
the server span (`autter.request.id`), and on every record inside the request,
including child operations. When the response carries CORS headers, the header
name is appended to `Access-Control-Expose-Headers` so a browser on another
origin can read it — runtime-browser 1.4.0 records it on failed fetch/XHR
calls, linking browser errors to the server request.

Give the id to users: `runtimeContext.requestId` in emails or support pages, and
`autterErrorResponse` puts it in every error body. Autter's "Find request"
looks it up.

## `runtimeContext`

The current request or operation, from anywhere in its async call tree. Outside
one, `set`/`outcome` are no-ops and the log methods behave like `runtimeLogger`.

```ts
import { runtimeContext } from "@autter/runtime-node";

runtimeContext.set({ cart: { items: 3 }, plan: "pro" });   // deep-merged, redacted
runtimeContext.info("Applied coupon", { coupon: "SPRING" });
runtimeContext.warn("Price service slow", { ms: 900 });
runtimeContext.error(err);                                  // logs + attaches code/why/fix
runtimeContext.outcome("degraded", "Used cached prices");
runtimeContext.requestId;   // also .id (operation id)
```

### Inline messages

Inside an operation, `debug`/`info` are folded into the summary as
`autter.operation.logs` (`{ t, level, message, attrs? }`, `t` = ms since start)
instead of becoming separate records. `warn`/`error` are folded **and** emitted.
`autter.operation.level` is the highest level seen. Limits: 50 messages
(then `autter.operation.logs_truncated`), 300-character messages, ~6 KB per
timeline. `logging.minLevel` still applies. Opt out with `logging.inline: false`.

## Coded errors

```ts
import { defineRuntimeErrors, RuntimeError } from "@autter/runtime-node"; // or runtime-edge

export const billingErrors = defineRuntimeErrors("billing", {
  declined: {
    status: 402, message: "Payment declined", expected: true,
    why: "The card issuer rejected the charge",
    fix: "Ask the customer for another card",
    link: "https://docs.example.com/payments#declined",
  },
  limit: ({ plan }: { plan: string }) => ({
    status: 429, message: `Plan ${plan} limit reached`, fix: "Upgrade the plan",
  }),
});

throw billingErrors.limit({ plan: "free" });             // code "billing.limit"
throw billingErrors.declined({ cause: stripeError, internal: { chargeId } });
throw new RuntimeError({ code: "inventory.reservation_timeout", message, why, fix, cause });
```

A code groups every occurrence into **one issue** (fingerprint scheme
`code-v1`: service + code), across message variants, routes and sources
(SDK traces, promoted logs, Sentry/PostHog/Datadog/Loki records carrying the
same code). Route and message remain facets of the issue.

**Code rules** — `^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$`, at most 80 characters:

- namespaced (`billing.declined`, not `declined`), stable across releases;
- low-cardinality: never ids, emails, amounts or anything from user input;
- an invalid code is dropped with a one-time console warning and the error
  groups by message, exactly as before.

Fields: `message` (client-safe), `status`, `expected`, `why` (≤ 1000 chars),
`fix` (≤ 1000), `link` (≤ 500). Per throw: `cause` (chains become
`exception.cause.N.type|message|code`, N ≤ 5), `internal` (debug payload,
redacted and attached to the **span only** as `autter.error.internal`; never in
logs, summaries or client responses; not enumerable, so `JSON.stringify` and
loggers skip it), and `message` to override the catalog text.

**Existing error classes need no rewrite.** `captureException` duck-types
`code`/`why`/`fix`/`link`/`status` (or `statusCode`)/`expected` on any error:

```ts
class AppError extends Error {
  code = "auth.session_expired"; status = 401; expected = true;
}
```

Foreign codes that don't match the pattern (`ECONNREFUSED`, `42P01`) are ignored
silently. `isRuntimeErrorLike(err)` tells you whether an error has any of these
fields.

**Expected errors** (`expected: true`) are business failures — declines,
validation, quota. They are recorded (occurrence with `autter.error.expected`,
summary outcome `degraded`) but never open incidents or trigger auto-fix; Autter
alerts only when their rate jumps. `why`/`fix` are shown in Autter as
"declared by the application" and treated as hypotheses by root-cause analysis,
never as proof.

### `autterErrorResponse` and `toClientError`

```ts
app.use(autterErrorResponse());          // Express error middleware, after routes
// 402 { "error": { "message": "Payment declined", "code": "billing.declined",
//                  "why": "…", "fix": "…", "requestId": "…" } }
```

- Status: the error's own 4xx/5xx `status`, else 500.
- Body: `toClientError(err, requestId)` → `{ error: { message, code?, why?,
  fix?, link?, requestId? } }`. Never `internal`, stacks or causes. The message
  of an unstructured 5xx error (`throw new Error("SELECT … failed")`) is
  replaced with `"Internal Server Error"`.
- Reporting (`capture`, default): errors with status ≥ 500, RuntimeErrors and
  any error with a valid code are reported via `captureException` (once, even
  if the handler already captured it). Pass `capture: false` or a predicate.
- The error is recorded on the request summary either way.

Use `toClientError` directly in Fastify `setErrorHandler`, Next.js route
handlers or anywhere else you build responses. runtime-browser's
`autterErrorFromResponse(res)` turns such a body back into an `Error` with the
same `code`/`why`/`fix`.

## Background work: `fork`, `runInBackground`, carriers

```ts
// Child linked to the current request even if it finishes later.
await runtimeContext.fork("send-receipt", async (op) => sendReceipt(order));

// Not awaited; errors are recorded on the child, never unhandled rejections.
runInBackground("warm-cache", () => warmCache(user));

// Across a queue or process:
await queue.add("charge", { orderId, autter: runtimeContext.carrier() });
// consumer
await withRuntimeOperation("charge", (op) => charge(job.data), {}, { from: job.data.autter });
```

`fork` captures the parent operation **at call time**, so the link survives
after the parent has sealed (plain `withRuntimeOperation` keeps 1.4.0
behaviour: no link once the parent finished). `carrier()` returns
`{ v: 1, op, req?, traceparent? }` (JSON-safe, ~200 bytes). The consumer's
summary gets `autter.operation.parent_id = op`, the same `autter.request.id`, and
`autter.parent_trace_id`; its span starts in a new trace with an OTel **link**
to the producer span. Malformed carriers are ignored.

## AI usage rollup

`withLlmCall`, `trackLlmCall` and `instrumentLlmClient` also add each call to
the current operation's `autter.operation.ai`:
`{ calls, input_tokens, output_tokens, cache_read_tokens, cost_usd, models[] }`.
`cost_usd` sums the costs you report (`setCost`, `costUsd`); per-call spans still
get the ingester's price-table estimate. Cache reads come from
`setUsage({ cacheReadTokens })` or the provider response (OpenAI
`prompt_tokens_details.cached_tokens`, Anthropic `cache_read_input_tokens`).
The rollup is per operation (not added to ancestors), so totals never double count.

## `waitUntil` (serverless)

```ts
export const handler = withRuntimeRequest(fn, { waitUntil: (p) => ctx.waitUntil(p) });
await withRuntimeOperation("job", fn, {}, { waitUntil });
```

After the summary is emitted, the log flush promise is handed to `waitUntil`
instead of being left to the 2-second timer, so platforms that freeze after
the response (Vercel, Workers, Lambda response streaming) still deliver it.
`@autter/runtime-next`'s `withRuntimeRequest` wires Next's `after()`
automatically (Next 15+, `unstable_after` on 14.2; fails soft elsewhere).

## Logger-only mode: `initAutterLogging`

For apps that already run their own OpenTelemetry SDK (a second NodeSDK would
conflict) or want logs without tracing:

```ts
import { initAutterLogging } from "@autter/runtime-node";

initAutterLogging({
  apiKey: process.env.AUTTER_RUNTIME_KEY,   // omit → console/file only
  service: "api", release: process.env.GIT_SHA,
  logging: { enrich: [enrichDeployment()] },
});
```

Requests, operations, `runtimeContext`, coded errors, sinks and enrichers all
work; NodeSDK is never started (only `@opentelemetry/api` is read). Exceptions
(`captureException`, errors thrown out of operations, uncaught crashes) are
recorded on the app's active recording span when there is one; otherwise they
become error records with `exception.*`, `autter.error.*` and
`autter.capture.mode = "log"`, which ingester 1.5.0 promotes to occurrences
(deduplicated by trace id). Use `exceptions: "log"` when your own spans are not
exported to Autter. Do not call both `initAutterServer` and `initAutterLogging`.

## Enrichers

`logging.enrich` runs on every operation/request summary **before** redaction
and bounding:

```ts
logging: { enrich: [enrichUserAgent(), enrichRequestSize(), enrichEdgeGeo(), enrichDeployment(),
  (event, { req, operation }) => { event.attributes["tenant.tier"] = tierOf(req); }] }
```

| Enricher | Adds |
| --- | --- |
| `enrichUserAgent()` | `user_agent.browser` ("Chrome 120"), `user_agent.os`, `user_agent.device` (desktop/mobile/tablet/bot), `user_agent.bot` — same mapping as runtime-browser; never the raw string |
| `enrichRequestSize()` | `http.request.body.size`, `http.response.body.size` from Content-Length |
| `enrichEdgeGeo()` | `geo.country.iso_code` from Cloudflare/Vercel/CloudFront/Fastly headers — country only |
| `enrichDeployment()` | `deployment.region`, `deployment.commit` from common platform env vars |

## Sinks and local files

`logging.sinks` replaces the default `[otlpSink(), consoleSink()]`:

- `otlpSink({ endpoint?, apiKey? })` — `/v1/logs` with the 1.4.0 buffering and retry limits.
- `consoleSink({ format?: "pretty" | "json" })` — `json` (1.4.0 lines) when
  `NODE_ENV=production`, otherwise a one-line summary plus an indented tree of
  context, steps, error and inline messages. ANSI colour only on a TTY
  (`NO_COLOR` respected).
- `fileSink({ dir = ".autter/runtime", maxFiles = 7, maxBytes = 10 MiB })` —
  NDJSON, one record per line, files `YYYY-MM-DD.jsonl` (UTC) then
  `YYYY-MM-DD.N.jsonl` past `maxBytes`, oldest deleted beyond `maxFiles`. On by
  default **only when `NODE_ENV=development`** (or `logging.file: true | {…}`);
  disables itself with one warning on read-only or permission-denied
  filesystems. Add `.autter/` to `.gitignore`. Coding agents read these files
  (or `autter logs --local`) to answer "why did that request fail?".

Records are redacted and bounded before any sink sees them.

## Testing — `@autter/runtime-node/testing`

```ts
import { captureRuntime, expectOperation } from "@autter/runtime-node/testing";

const runtime = captureRuntime();          // in-memory; no ingester, no network
await request(app).post("/checkout?declined").expect(402);
expectOperation(runtime, "POST /checkout")
  .toHaveKind("request")
  .toHaveOutcome("degraded")
  .toHaveErrorCode("billing.declined")
  .toHaveContext({ cart: { items: 3 } })
  .toHaveLog("Validating cart");
runtime.byRequestId(id); runtime.exceptions; runtime.clear(); runtime.stop();
```

`memorySink()` is also exported for custom sink lists. Capture works with or
without `initAutterServer`; before init it replaces console output.

## Zero-code hook mode (experimental)

`initAutterServer({ logging: { requests: true } })` creates request summaries for
every incoming `node:http` request from the HTTP instrumentation hook — no
middleware. It enters the request context with `AsyncLocalStorage.enterWith`,
which can leak into later work on the same socket under keep-alive or
pipelining, so it is **off by default** until a leak test proves it safe. Prefer
`autterRequests()`; when both are present the middleware reuses the hook's
summary. Express route templates are still captured.

## Edge: `@autter/runtime-edge`

```ts
import { withAutter, defineRuntimeErrors } from "@autter/runtime-edge";

export default withAutter(
  (env) => ({ apiKey: env.AUTTER_RUNTIME_KEY, service: "edge-api" }),
  async (request, env, ctx, rt) => {
    rt.set({ tenant: env.TENANT });
    rt.info("Routing");
    if (!ok) throw billingErrors.declined();   // same catalogs as Node
    return new Response("ok");
  },
);
```

Zero dependencies, fetch-only, no AsyncLocalStorage — `rt` is the request
context (`set`, `outcome`, `info`, `warn`, `error`, `requestId`,
`captureException`). Same request summary, request-id and coded-error semantics
as Node; exceptions are promoted log records. Delivery uses `ctx.waitUntil`
(Workers) or `event.waitUntil` (Next middleware) and needs a **server** key —
never ship it to a browser. Next.js `middleware.ts` imports it as
`@autter/runtime-next/edge`. See [packages/runtime-edge](../packages/runtime-edge/README.md).

## Wire reference

| Attribute | Where |
| --- | --- |
| `autter.request.id` | request summaries, every record inside a request, server span |
| `autter.operation.kind` | every summary (`request` or `operation`) |
| `autter.operation.logs`, `.logs_truncated`, `.level` | summaries |
| `autter.operation.ai` | summaries with LLM calls |
| `http.request.method`, `http.route`, `http.response.status_code`, `autter.request.aborted` | request summaries |
| `autter.error.code` / `.why` / `.fix` / `.link` / `.status` / `.expected` | span, exception event, summaries, error records |
| `autter.error.internal` | span only (redacted JSON) |
| `exception.cause.N.type` / `.message` / `.code` | exception event, summaries, error records |
| `autter.capture.mode = "log"` | promoted error records (logger-only, edge) |
| `autter.parent_trace_id` | consumer operations started from a carrier |
