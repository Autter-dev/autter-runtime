# @autter/runtime-next

One-command Autter Runtime for Next.js: server OTel, browser tracker,
same-origin relay route, and a React error boundary.

## Install

```bash
npm install @autter/runtime-next
```

Set `AUTTER_RUNTIME_KEY` in your environment. Then three small files, and
(recommended) one line of `next.config`.

The package has two entry points — this split is what keeps the Node
OpenTelemetry SDK out of your browser bundle:

- `@autter/runtime-next` (or `@autter/runtime-next/server`) — server only:
  `instrumentation.ts`, route handlers, server components.
- `@autter/runtime-next/client` — client components: browser tracker +
  error boundary. Never imports Node code.
- `@autter/runtime-next/instrumentation` — `onRequestError` for
  `instrumentation.ts`; safe on both the Node and edge runtimes.

**`next.config`** (recommended) — load the Node SDK from `node_modules`
instead of bundling it:

```js
// next.config.mjs
export default {
  serverExternalPackages: ["@autter/runtime-node"],
};
```

Next bundles server dependencies separately into `instrumentation.ts` and
into the route bundles. Since 1.6.1 every copy shares the SDK
`registerAutter` started, so routes, server components and server actions
(`withRuntimeRequest`, `captureServerException`, `runtimeLogger`,
`runtimeContext`, …) export through it, and an error `withRuntimeRequest`
reported is not reported again by `onRequestError`, with or without this
line. The line keeps the SDK and its OpenTelemetry
dependencies out of the route bundles: in our Next 15.5 and 16.4 test app
the server output had 1.1 to 2.3 MB less JavaScript. (1.6.0 needed it:
without it, request summaries went to the console and errors were reported
twice.) Next 14.2:
`experimental: { serverComponentsExternalPackages: ["@autter/runtime-node"] }`.

**1. `instrumentation.ts`** — server tracing/errors:

```ts
import { autterOnRequestError } from "@autter/runtime-next/instrumentation";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerAutter } = await import("@autter/runtime-next");
    registerAutter({
      apiKey: process.env.AUTTER_RUNTIME_KEY!,
      service: "web-app",
      environment: process.env.NODE_ENV,
      release: process.env.GIT_SHA,
    });
  }
}

// Next 15+: errors Next catches in server components, server actions, route
// handlers and middleware, with their stack (otherwise: stackless 500s).
export const onRequestError = autterOnRequestError({
  // Edge runtime only (middleware, edge routes): no tracker runs there, so
  // errors go straight to /v1/logs with these options.
  edge: { apiKey: process.env.AUTTER_RUNTIME_KEY, service: "web-app" },
});
```

`@autter/runtime-next/instrumentation` is safe to import at the top of
`instrumentation.ts`, which Next compiles for both runtimes: on the edge,
bundlers resolve it (through the `edge-light`/`worker` export conditions) to a
build with no Node imports, and the Node build loads `@autter/runtime-node`
only inside a `process.env.NEXT_RUNTIME` branch Next removes from edge
bundles. Without edge errors to report, `export { onRequestError } from
"@autter/runtime-next/instrumentation"` is enough.

Request counts and latency per route come from the `http.server.duration`
metric of every request, under Next's route template (`/blog/[slug]`,
`/api/items/[id]`, `/_not-found` for 404s), since 1.7.0: the SDK reads the
`next.route` Next puts on its own spans while it serves the request. 1.7.0
also instruments Next's server from the first request; before, it was
instrumented only once a later request happened to load `http` again (in
our test app, the first edge-route request), and its metrics had no route.

On Node the error is recorded on the request span through the
`registerAutter` tracker — once, even when `withRuntimeRequest` already
reported it (Next's context is then added to that report). Recorded with
it: `next.route_path` (the route template: `/blog/[slug]`, `/api/orders`;
middleware is `/middleware` on Next 15 and `/proxy` on Next 16),
`next.router_kind`, `next.route_type` (`render`, `route`, `action`,
`middleware` on Next 15, `proxy` on Next 16), `next.render_source`
(`react-server-components`, `react-server-components-payload`,
`server-rendering`), `next.render_type`, `next.revalidate_reason`,
`next.digest` (matches the `digest` your error boundary sees),
`http.request.method` and `url.path` without its query string. Headers and
cookies are never read. Next's control-flow signals (`redirect()`,
`notFound()`, `forbidden()`, `unauthorized()`, dynamic bailouts) are
skipped; `capture: true` or a predicate changes that.

On the edge runtime, Next calls `onRequestError` inside the function for
middleware and edge pages; the record goes out with the `edge` options and
is also handed to the request's `waitUntil`, since Next does not await the
hook for errors raised while rendering. Edge route handlers
(`export const runtime = "edge"` in `route.ts`) are the exception: Next
never calls the hook inside them. Self-hosted (`next start`), the Node
server reports them instead, so the Node tracker records them with their
own stack, `next.router_kind` `Pages Router` and `next.route_path` such as
`/api/orders/route`.

`registerAutter` passes options straight to `initAutterServer`, so the
server SDK's defaults apply out of the box: exporters are flushed on
process exit (`autoFlush`) and custom attributes are scrubbed for PII
before export (`redactAttributes`). The same goes for `sampleRate` and
`ignoreErrors` (1.8.0); in the browser, `@autter/runtime-next/client`
re-exports `withFilters` for `sampleRate`, `ignoreErrors` and `denyUrls`
(`initAutterBrowser(withFilters({ endpoint, service, sampleRate: 0.5 }))`),
and the edge options of `autterOnRequestError` take `ignoreErrors`. See the `@autter/runtime-node` README
for every option; `makeSafeCapture`, `installAutterAutoFlush`, and
`redactAttributes` are also re-exported from this package.

**2. `app/api/autter-runtime/route.ts`** — browser relay (key stays server-side):

```ts
import { createAutterRelayRoute } from "@autter/runtime-next";

export const { POST } = createAutterRelayRoute({
  apiKey: process.env.AUTTER_RUNTIME_KEY!,
});
```

**3. A client component** — browser tracker + render-error boundary:

```tsx
"use client";
import { initAutterBrowser, AutterErrorBoundary } from "@autter/runtime-next/client";

initAutterBrowser({
  endpoint: "/api/autter-runtime",
  service: "web-app",
  release: process.env.NEXT_PUBLIC_GIT_SHA,
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AutterErrorBoundary fallback={<p>Something went wrong.</p>}>
      {children}
    </AutterErrorBoundary>
  );
}
```

React render errors don't reach `window.onerror` — the boundary reports
them via `captureException` and then renders your fallback.

**Linking browser errors to server traces** (opt-in): call
`enableTracePropagation` from `@autter/runtime-next/client`, next to
`initAutterBrowser` and before the app sends requests. Same-origin `fetch`
and XHR requests (your route handlers and server actions) then carry a W3C
`traceparent`, which `registerAutter` continues, so a browser error links to
the server trace of the request behind it. Cross-origin APIs get one only
when listed in `tracePropagationTargets`, and must allow the header in CORS.
`disableTracePropagation()` turns it off; the rules are in
`@autter/runtime-browser`'s README ("Trace propagation").

```tsx
"use client";
import { initAutterBrowser, enableTracePropagation } from "@autter/runtime-next/client";

initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" });
enableTracePropagation({ tracePropagationTargets: ["https://api.example.com/"] });
```

Also re-exported for convenience: `captureException`, `captureMessage`,
`trackEvent`, `setUser`, `setContext`, `flush` (from
`@autter/runtime-next/client`) and `captureServerException`,
`captureServerMessage`, `withProcessSpan`, `withLlmCall`, `trackLlmCall`,
`instrumentLlmClient`, `emitLlmSelftestTrace` (from the root /
`@autter/runtime-next/server`), plus the server error hooks for custom
servers: `autterErrorHandler`, `autterFastifyErrors`, `autterKoa` and
`captureRequestError`.

> Importing the root entry from a client component pulls the Node OTel SDK
> into the browser bundle and fails the build (`fs` cannot be resolved).
> Client code must always use `@autter/runtime-next/client`.

LLM tracing is on automatically once `registerAutter` runs: Vercel AI SDK
calls with `experimental_telemetry: { isEnabled: true }` (and anything
wrapped in `withLlmCall` or an `instrumentLlmClient` client) are recorded at
100% — every call, with model, tokens, latency, and cost. See the
[`@autter/runtime-node` README](../runtime-node) for the API.
## Operation logging (1.4.0+)

Import `withRuntimeOperation`, `runtimeLogger`, `createRuntimeLogger`,
`flushRuntimeLogs`, and `runtimeLogStats` from `@autter/runtime-next/server`.
Initialize through the existing `registerAutter` call in `instrumentation.ts`.
These APIs require the Node runtime, a 1.4.0+ ingester, and matching platform
evidence support. Client components keep `@autter/runtime-next/client`.
See the [operation logging guide](../../docs/OPERATION-LOGGING.md) for measured
steps, explicit business outcomes, privacy and flushing. Ordinary error logs
are diagnostics; captured exceptions and declared failed outcomes use tracing
for issue grouping.

## Requests, coded errors and edge middleware (1.5.0+)

Route handlers become request summaries (always kept, request id echoed in
`x-request-id`); the log flush is handed to Next's `after()` automatically
(Next 15+, `unstable_after` on 14.2):

```ts
// app/api/checkout/route.ts
import { withRuntimeRequest, runtimeContext, defineRuntimeErrors, toClientError } from "@autter/runtime-next";

const billing = defineRuntimeErrors("billing", {
  declined: { status: 402, message: "Payment declined", expected: true },
});

export const POST = withRuntimeRequest(async (request) => {
  runtimeContext.set({ plan: "pro" });
  const ok = await charge(await request.json());
  if (!ok) {
    const error = billing.declined();
    return Response.json(toClientError(error, runtimeContext.requestId), { status: 402 });
  }
  return Response.json({ ok: true });
}, { name: "checkout" });
```

Everything new in `@autter/runtime-node` 1.5.0 (`runtimeContext`,
`RuntimeError`, `defineRuntimeErrors`, `runInBackground`, `initAutterLogging`,
enrichers, sinks, …) is re-exported from `@autter/runtime-next` and
`/server`. `@autter/runtime-next/client` adds `autterErrorFromResponse`.

`middleware.ts` runs on the edge runtime — use `@autter/runtime-next/edge`
(re-exports [`@autter/runtime-edge`](../runtime-edge)):

```ts
import { NextResponse } from "next/server";
import { withAutter } from "@autter/runtime-next/edge";

export default withAutter(
  { apiKey: process.env.AUTTER_RUNTIME_KEY, service: "web-middleware" },
  async (request, _event, _ctx, rt) => {
    rt.set({ locale: request.headers.get("accept-language")?.slice(0, 2) });
    return NextResponse.next();
  },
);
```

See [Requests, coded errors and background work](../../docs/REQUESTS-AND-ERRORS.md).
