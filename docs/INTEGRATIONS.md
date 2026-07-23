# Stack integrations

Autter Runtime is two credentials and three endpoints; everything else is
per-stack sugar.

| Credential | Where it lives | Can |
| --- | --- | --- |
| **Server key** `autter_rt_…` | backend env vars only | send OTLP traces/metrics + relay browser events |
| **Client key** `autter_rtc_…` | frontend bundles (publishable) | send browser events only, origin-restricted |

| Endpoint | Format |
| --- | --- |
| `POST /v1/traces`, `POST /v1/metrics` | OTLP/HTTP — **protobuf or JSON**, gzip ok |
| `POST /v1/browser` | compact JSON (`@autter/runtime-browser` payload v1) |

Any language with an OpenTelemetry SDK can send server telemetry — point
its OTLP/HTTP exporter at the ingester and add the key as a header.

## Client-side React / SPA / static sites

```bash
npm install @autter/runtime-browser
```

With a backend (recommended — relay, no key in the bundle):

```ts
initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" });
```

Without a backend (publishable client key, origin-restricted):

```ts
initAutterBrowser({
  endpoint: "https://otlp.autter.dev/v1/browser",
  clientKey: "autter_rtc_xxxxxxxx",
  service: "marketing-site",
});
```

React render errors: wrap with `<AutterErrorBoundary>` (from
`@autter/runtime-next/client`, works in any React app). Vue/Svelte/Angular: call
`captureException(err)` from the framework's error hook
(`app.config.errorHandler`, `handleError`, `ErrorHandler`).

## Node.js (Express, Fastify, Koa, NestJS)

```bash
npm install @autter/runtime-node
```

```ts
// instrument.cjs — load first: node --require ./instrument.cjs server.js
const { initAutterServer } = require("@autter/runtime-node");
initAutterServer({
  apiKey: process.env.AUTTER_RUNTIME_KEY,
  service: "payments-api",
  release: process.env.GIT_SHA,
});
```

Relay for your frontend: `app.post("/api/autter-runtime", createBrowserRelayHandler({ apiKey }))`.
ESM-only apps need OTel's loader hook (see the package README).

## Next.js

`npm install @autter/runtime-next` — three files (instrumentation.ts, relay
route, client init + boundary). See the package README.

## Go

```go
import (
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
)

exp, _ := otlptracehttp.New(ctx,
    otlptracehttp.WithEndpointURL("https://otlp.autter.dev/v1/traces"),
    otlptracehttp.WithHeaders(map[string]string{
        "authorization": "Bearer " + os.Getenv("AUTTER_RUNTIME_KEY"),
    }),
)
// resource: service.name, service.version (release), deployment.environment
// errors: span.RecordError(err); span.SetStatus(codes.Error, err.Error())
```

## Rust

```rust
// opentelemetry-otlp with the "http-proto" (default) or "http-json" feature
let exporter = opentelemetry_otlp::SpanExporter::builder()
    .with_http()
    .with_endpoint("https://otlp.autter.dev/v1/traces")
    .with_headers(HashMap::from([(
        "authorization".into(),
        format!("Bearer {}", std::env::var("AUTTER_RUNTIME_KEY")?),
    )]))
    .build()?;
```

## Python / Java / .NET / anything else

Standard OTel env vars work with every SDK:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.autter.dev
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${AUTTER_RUNTIME_KEY}"
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=payments-api
OTEL_RESOURCE_ATTRIBUTES=service.version=${GIT_SHA},deployment.environment=production
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.01
```

Errors surface as issues when spans carry `exception` events (every SDK's
`record_exception` / `RecordError` does this) or `ERROR` status.

**Warnings** (any language): add an `autter.severity` attribute to the
exception event — `"fatal" | "error" | "warning" | "info"` (default
`error`; the Node SDK's crash marker `autter.unhandled: true` implies
`fatal`). Warnings share the errors table with a `severity` column, so
they group and aggregate identically:

```python
span.record_exception(err)  # or add_event("exception", {...})
span.set_attribute("autter.severity", "warning")
```

## Sampling guidance (all stacks)

Errors are always worth sending; keep successful-trace sampling at ~1%
(`OTEL_TRACES_SAMPLER_ARG=0.01`). Request/usage metrics are derived
server-side from spans and the `http.server.duration` histogram — no extra
setup.
