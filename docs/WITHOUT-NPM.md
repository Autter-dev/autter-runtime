# Using Autter Runtime without npm

The `@autter/*` npm packages are convenience wrappers, not requirements.
Autter Runtime's ingest API is built on open standards — **OTLP/HTTP** for
servers and a small **documented JSON payload** for browsers — so any
codebase in any language can send telemetry with nothing but its own
ecosystem's OpenTelemetry SDK, or a plain HTTP request.

There are two integration surfaces. Pick per service:

| Surface | For | Wire format |
| --- | --- | --- |
| `POST /v1/traces`, `POST /v1/metrics` | anything server-side | OTLP/HTTP (protobuf **or** JSON), gzip ok |
| `POST /v1/browser` | anything browser-side without the npm tracker | compact JSON, documented below |

The default endpoint is `https://otlp.autter.dev`; self-hosters substitute
their own domain. Auth on every request: `Authorization: Bearer <key>` (or
`x-autter-key: <key>`), using a **server key** (`autter_rt_…`) for OTLP and
either key kind for `/v1/browser`.

---

## Servers: any language with an OpenTelemetry SDK

OTLP/HTTP is OpenTelemetry's standard export protocol. Every official OTel
SDK — Python, Ruby, Go, Rust, Java, .NET, PHP, Erlang/Elixir, Swift, C++ —
can export to Autter with **configuration only**, usually just environment
variables:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.autter.dev
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${AUTTER_RUNTIME_KEY}"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=payments-api
OTEL_RESOURCE_ATTRIBUTES=service.version=${GIT_SHA},deployment.environment=production
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.01
```

Install that language's OTel SDK + OTLP exporter from its own package
manager (`pip`, `gem`, `go get`, `cargo`, Maven/Gradle, NuGet, Composer, …)
and enable its auto-instrumentation. Per-language snippets for Go, Rust,
Python and friends live in [INTEGRATIONS.md](INTEGRATIONS.md).

How the signals map:

- **Errors** — a span with an `exception` event (`record_exception` /
  `RecordError` in every SDK) or `ERROR` status becomes an error
  occurrence, fingerprinted and grouped server-side.
- **Warnings/info** — add an `autter.severity` attribute
  (`"fatal" | "error" | "warning" | "info"`) to the exception event; the
  occurrence is stored with that severity instead of `error`.
- **Usage** — HTTP-server spans and the standard
  `http.server.request.duration` histogram fold into per-minute
  request/error/latency rollups automatically.

### No OTel SDK at all?

If a language/environment has no OTel SDK (or you can't add dependencies),
you have two options:

1. **Run an OpenTelemetry Collector** next to your app (it's a single
   static binary) speaking whatever you *can* emit — syslog, Prometheus,
   Jaeger, Zipkin, file logs — and point its OTLP/HTTP exporter at Autter
   with the bearer-token header. No app changes beyond what you already
   emit.
2. **POST OTLP/JSON directly.** OTLP has a JSON encoding, so a hand-rolled
   HTTP request works from anything that can speak HTTPS — curl included:

```bash
curl -X POST https://otlp.autter.dev/v1/traces \
  -H "Authorization: Bearer $AUTTER_RUNTIME_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "resourceSpans": [{
      "resource": { "attributes": [
        { "key": "service.name", "value": { "stringValue": "cron-job" } }
      ]},
      "scopeSpans": [{ "spans": [{
        "traceId": "'"$(openssl rand -hex 16)"'",
        "spanId":  "'"$(openssl rand -hex 8)"'",
        "name": "nightly-backup",
        "kind": 1,
        "startTimeUnixNano": "'"$(date +%s)"'000000000",
        "endTimeUnixNano":   "'"$(date +%s)"'000000000",
        "status": { "code": 2, "message": "backup failed" },
        "events": [{
          "name": "exception",
          "attributes": [
            { "key": "exception.type",    "value": { "stringValue": "BackupError" } },
            { "key": "exception.message", "value": { "stringValue": "disk full on /var/backups" } }
          ]
        }]
      }]}]
    }]
  }'
```

That's a complete error report from a shell script. Swap `curl` for your
language's HTTP client and you have an integration in ~30 lines with zero
dependencies.

---

## Browsers: without `@autter/runtime-browser`

The tiny tracker is just a convenience around `POST /v1/browser`. The
payload contract (`version: 1`) is stable and small enough to hand-roll —
from vanilla JS, a browser extension, a WebView, or any non-npm frontend
toolchain:

```js
function reportError(err) {
  const body = JSON.stringify({
    version: 1,
    service: "marketing-site",
    environment: "production",
    events: [{
      type: "exception",                       // exception | unhandled_rejection |
                                               //   message | session_start | track_event
      timestamp: new Date().toISOString(),
      message: err.message,
      errorType: err.name,
      stack: err.stack,
      route: location.pathname,
      // severity: "warning",                  // for type: "message"
    }],
  });
  // Client keys can't set headers via sendBeacon — use the ?key= param:
  navigator.sendBeacon(
    "https://otlp.autter.dev/v1/browser?key=" + AUTTER_CLIENT_KEY,
    new Blob([body], { type: "text/plain" }),
  );
}

window.addEventListener("error", (e) => reportError(e.error ?? e));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason ?? e));
```

Rules the hand-rolled path must respect (the ingester enforces them):

- ≤ 50 events per request, ≤ 1 MB body, `message` ≤ 4000 chars, `stack`
  ≤ 32000 chars.
- `route` is a path only — never include query strings (they're stripped
  defensively, but don't send them).
- Client keys (`autter_rtc_…`) are origin-restricted; the `Origin` your
  page sends must be on the key's allow-list.
- Never put a server key (`autter_rt_…`) in browser code. If your site has
  a backend, prefer relaying through it (any language — the relay is just
  an authenticated proxy that forwards this same JSON with the server key).

The full schema is `browserPayloadSchema` in
[`packages/otlp-ingester/src/normalize-browser.ts`](../packages/otlp-ingester/src/normalize-browser.ts)
— the code is the contract.

---

## AI-assisted setup works for non-npm codebases too

The agent skills are not npm-specific — `npx` is only the *installer* for
the skill files (any machine with Node can run it once; the target codebase
doesn't need Node at all). The skills include Python, Go, Rust, and a
generic any-OTel-language guide:

```bash
npx skills add Autter-dev/autter-skills --all
```

Then tell your coding agent: *"install Autter Runtime in this project"* —
it inventories the services, picks the right per-language approach from
above, and wires it up.
