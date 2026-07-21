# Getting started

Autter Runtime tracks **runtime errors and usage** from your frontend and
backend with two small packages and one ingest endpoint. This guide takes
you from zero to seeing data in ClickHouse.

- [1. Concepts (2 minutes)](#1-concepts)
- [2. Run the ingester](#2-run-the-ingester)
- [3. Instrument your backend](#3-instrument-your-backend)
- [4. Instrument your frontend](#4-instrument-your-frontend)
- [5. Next.js: both in one package](#5-nextjs-both-in-one-package)
- [6. Other languages (Go, Rust, Python, …)](#6-other-languages)
- [7. Verify data is flowing](#7-verify-data-is-flowing)
- [8. Production checklist](#8-production-checklist)

## 1. Concepts

**Two kinds of keys.** Never mix them up:

| | Server key | Client key |
| --- | --- | --- |
| Looks like | `autter_rt_…` | `autter_rtc_…` |
| Secrecy | **secret** — env vars only, never in a browser bundle | **publishable** — safe to ship in frontend JS |
| Can send | OTLP traces + metrics, browser events | browser events only (`/v1/browser`) |
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
| Traces | — (by design; no OTel in the browser) | ~1% sampled (configurable) |

**What is never sent:** cookies, DOM content, form values, request/response
bodies, headers, emails, full URLs with query strings.

## 2. Run the ingester

The ingester is a small stateless service that receives everything and
writes ClickHouse. For a local try-out:

```bash
git clone https://github.com/Autter-dev/autter-runtime
cd autter-runtime
docker compose up   # ClickHouse + ingester on :4318, key "dev-key"
```

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

```bash
npm install @autter/runtime-node
```

Create `instrument.cjs` — it must load **before** your app:

```js
const { initAutterServer } = require("@autter/runtime-node");

initAutterServer({
  apiKey: process.env.AUTTER_RUNTIME_KEY,        // server key
  endpoint: process.env.AUTTER_ENDPOINT,          // your ingester URL
  service: "payments-api",
  environment: process.env.NODE_ENV,
  release: process.env.GIT_SHA,                   // enables "broke in release X"
});
```

```bash
node --require ./instrument.cjs server.js
```

That alone gives you: every incoming HTTP request traced-and-sampled,
request/error/duration rollups per route, and crashes captured. For
handled errors:

```js
const { captureException } = require("@autter/runtime-node");

try {
  await chargeCard(order);
} catch (err) {
  captureException(err, { "order.id": order.id });
  throw err;
}
```

ESM-only app? Use `--import` plus OTel's loader hook (see the
[package README](../packages/runtime-node)). Express route timings can be
enriched with `@opentelemetry/instrumentation-express` via the
`instrumentations` option.

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
(exported from `@autter/runtime-next`, works in any React app):

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
client component).

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
`ERROR` status. Per-language snippets: [INTEGRATIONS.md](INTEGRATIONS.md).

## 7. Verify data is flowing

Trigger a test error, then query ClickHouse:

```sql
SELECT service, error_type, message, route, occurred_at
FROM autter_runtime.runtime_error_occurrences
ORDER BY occurred_at DESC LIMIT 10;

SELECT service, route, sum(request_count) AS requests, sum(error_count) AS errors
FROM autter_runtime.runtime_metrics_1m
WHERE bucket_at > now() - INTERVAL 1 HOUR
GROUP BY service, route;
```

With the local compose setup: `docker compose exec clickhouse
clickhouse-client --password dev`.

## 8. Production checklist

- [ ] Server keys only in backend env vars; client keys only where a relay
      is genuinely impossible.
- [ ] Client keys have `allowedOrigins` set to your exact app origins.
- [ ] `release` is wired to your git SHA in **both** frontend and backend —
      it's what powers regression detection ("broke in release X").
- [ ] Keep trace sampling at ~1% (`traceSampleRate`) — errors are always
      captured regardless.
- [ ] The relay route keeps its built-in per-IP rate limit (or your WAF
      covers it: `perIpRateLimit: false`).
- [ ] Direct browser ingest: your CSP includes
      `connect-src https://your-ingester…`, and you accept that ad-blockers
      may drop some events (the relay avoids this).
- [ ] The ingester's `/healthz` is wired to your load-balancer health check.
