# @autter/runtime-next

One-command Autter Runtime for Next.js: server OTel, browser tracker,
same-origin relay route, and a React error boundary.

## Install

```bash
npm install @autter/runtime-next
```

Set `AUTTER_RUNTIME_KEY` in your environment. Then three small files.

The package has two entry points — this split is what keeps the Node
OpenTelemetry SDK out of your browser bundle:

- `@autter/runtime-next` (or `@autter/runtime-next/server`) — server only:
  `instrumentation.ts`, route handlers, server components.
- `@autter/runtime-next/client` — client components: browser tracker +
  error boundary. Never imports Node code.
- `@autter/runtime-next/instrumentation` — `onRequestError` for
  `instrumentation.ts`; safe on both the Node and edge runtimes.

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

On Node the error is recorded on the request span through the
`registerAutter` tracker — once, even when `withRuntimeRequest` already
reported it. Recorded with it: `next.route_path` (`/blog/[slug]`),
`next.router_kind`, `next.route_type` (`render`, `route`, `action`,
`middleware`), `next.render_source`, `next.render_type`,
`next.revalidate_reason`, `next.digest` (matches the `digest` your error
boundary sees), `http.request.method` and `url.path` without its query
string. Headers and cookies are never read. Next's control-flow signals
(`redirect()`, `notFound()`, `forbidden()`, `unauthorized()`, dynamic
bailouts) are skipped; `capture: true` or a predicate changes that.

`registerAutter` passes options straight to `initAutterServer`, so the
server SDK's defaults apply out of the box: exporters are flushed on
process exit (`autoFlush`) and custom attributes are scrubbed for PII
before export (`redactAttributes`). See the `@autter/runtime-node` README
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
