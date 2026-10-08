# @autter/runtime-edge

Autter Runtime for fetch-only runtimes — **Cloudflare Workers, Vercel Edge
(and Next.js `middleware.ts`), Deno and Bun**. Zero dependencies, no Node APIs,
no AsyncLocalStorage.

Each request emits one wide **request summary** (method, route, status,
outcome, duration, request id, your context, inline messages, coded error),
always kept. Exceptions become issues; errors with the same code group into
one issue across your Node services, edge functions and external providers.

Requires `@autter/otlp-ingester` **1.5.0+** and a **server** ingest key
(`autter_rt_…`) stored as a secret — never a browser/client key.

## Install

```bash
npm install @autter/runtime-edge
```

## Cloudflare Workers

```ts
import { withAutter, defineRuntimeErrors } from "@autter/runtime-edge";

const billing = defineRuntimeErrors("billing", {
  declined: { status: 402, message: "Payment declined", expected: true,
              fix: "Ask the customer for another card" },
});

export default withAutter(
  // Bindings exist per request, so options may be a function of env.
  (env) => ({ apiKey: env.AUTTER_RUNTIME_KEY, service: "edge-api", release: env.GIT_SHA }),
  async (request, env, ctx, rt) => {
    rt.set({ tenant: env.TENANT, colo: request.cf?.colo });
    rt.info("Routing request");                 // folded into the summary
    if (!(await authorise(request))) throw billing.declined();
    return new Response("ok");
  },
);
```

`npx wrangler secret put AUTTER_RUNTIME_KEY`. Delivery runs through
`ctx.waitUntil`, so it never delays the response.

## Vercel Edge / Next.js middleware

```ts
// middleware.ts
import { NextResponse } from "next/server";
import { withAutter } from "@autter/runtime-next/edge";   // or "@autter/runtime-edge"

export default withAutter(
  { apiKey: process.env.AUTTER_RUNTIME_KEY, service: "web-middleware" },
  async (request, _event, _ctx, rt) => NextResponse.next(),
);
```

The `NextFetchEvent` (second argument) supplies `waitUntil`.

## Deno and Bun

```ts
const handler = withAutter({ apiKey: Deno.env.get("AUTTER_RUNTIME_KEY"), service: "deno-api" },
  async (request, _env, _ctx, rt) => new Response("ok"));
Deno.serve(handler);           // Bun: Bun.serve({ fetch: handler })
```

Without `waitUntil`, delivery is fire-and-forget (the process stays up).
`await handler.flush()` delivers everything buffered.

## The `rt` handle

| Member | |
| --- | --- |
| `rt.set(context)` | Deep-merge redacted context into the request summary |
| `rt.outcome(status, message?)` | `succeeded` / `failed` / `degraded` / `cancelled` / `pending` — wins over the automatic rules |
| `rt.info(message, attrs?)` | Folded into the summary timeline (`autter.operation.logs`, max 50) |
| `rt.warn(message, attrs?)` | Folded **and** exported as its own record |
| `rt.error(err, attrs?)` | Like `warn` at error level; attaches the error's code/why/fix to the summary |
| `rt.captureException(err, attrs?)` | Report an exception — becomes an occurrence (`autter.capture.mode = "log"`) |
| `rt.requestId` | Honoured `x-request-id` (`^[\w.-]{8,128}$`) or a fresh UUID; echoed in the response header |

Errors thrown from the handler are captured, recorded on the summary and
rethrown — or answered as `{ error: { message, code?, why?, fix?, link?,
requestId? } }` with `errorResponse: true`. Outcome rules: explicit outcome,
then an `expected` coded error → `degraded`, a thrown error or status ≥ 500 →
`failed`, an aborted request → `cancelled`, else `succeeded`.

## Options

| Option | Default | |
| --- | --- | --- |
| `apiKey` | — | Server key. Without it nothing is exported (one warning). |
| `endpoint` | `https://otlp.autter.dev` | Ingester base URL (`/v1/logs` is appended) |
| `service`, `environment`, `release` | —, `production`, — | Resource attributes |
| `requestIdHeader` | `x-request-id` | Also added to `Access-Control-Expose-Headers` when the response has CORS headers |
| `ignore` | `[]` | Path globs not summarised (`*` one segment, `**` any depth) |
| `routeOf(request)` | pathname with ids → `:id` | Route template for `http.route` and the summary name |
| `errorResponse` | `false` | Answer thrown errors with `toClientError` JSON |
| `minLevel` | `debug` | Drop plain messages below this level (summaries are always kept) |
| `console` | `false` | Also print records as JSON lines |
| `redactAttributes` | `true` | Same redaction as runtime-node (emails, tokens, sensitive keys) |
| `maxQueue` | `200` | Records buffered per isolate (1 MiB cap); overflow is dropped |

Also exported: `RuntimeError`, `defineRuntimeErrors`, `isRuntimeErrorLike`,
`toClientError`, `CODE_PATTERN` — the same coded-error API as
`@autter/runtime-node`, so one catalog module can serve both.

## Limits

No tracing: records carry no trace ids, and there are no steps or child
operations. Each export makes at most two attempts; undelivered records are
dropped with a console warning. Codes must match
`^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$` (≤ 80 chars) — never ids or user data.

See [Requests, coded errors and background work](../../docs/REQUESTS-AND-ERRORS.md).
