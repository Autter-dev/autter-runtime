# Stack integrations

Autter Runtime uses two key types and portable OTLP endpoints; optional
profile and source-map uploads use the server key.

| Credential | Where it lives | Can |
| --- | --- | --- |
| **Server key** `autter_rt_…` | backend env vars / edge secret bindings only | send OTLP traces/metrics/logs + relay browser events |
| **Client key** `autter_rtc_…` | frontend bundles (publishable) | send browser events only, origin-restricted |

| Endpoint | Format |
| --- | --- |
| `POST /v1/traces`, `POST /v1/metrics`, `POST /v1/logs` | OTLP/HTTP — **protobuf or JSON**, gzip ok |
| `POST /v1/browser` | compact JSON (`@autter/runtime-browser` payload v1) |
| `POST /v1/profiles` | symbolized pprof (server key only) |
| `POST /v1/sourcemaps` | source map JSON keyed by release + path, plus an optional `debugId` (server key only; see [Readable stack traces](SOURCE-MAPS.md)) |
| `POST /v1/sourcemaps/check` | which maps are already stored, so uploads skip them (server key only, 1.6.0+) |
| `POST /v1/platform-events` | ECS/Kubernetes OOM and restart JSON (server key only) |
| `GET /v1/compat` | ingester version, schema level and supported features (public; see [Version compatibility](COMPATIBILITY.md)) |

Any language with an OpenTelemetry SDK can send server telemetry — point
its OTLP/HTTP exporter at the ingester and add the key as a header.
Memory pressure detection uses the same `/v1/metrics` endpoint for every
language. Enable process/runtime metrics or emit the portable RSS/heap gauges
in [Memory pressure incidents](MEMORY-PRESSURE.md), with a unique
`service.instance.id` for each process. Node SDK 1.3.3+ emits these by
default; other language exporters need a process metric instrument or
collector. An OTel trace exporter alone does not measure memory.
The [memory setup and deployment requirements](MEMORY-PRESSURE.md#what-must-be-running)
also include the ingester, detector/UI deployment, application redeploy, and
an ECS/Kubernetes event forwarder for OOM correlation.

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

**Server errors with their stacks.** A framework turns a thrown error into a
500, which on its own reaches Autter as a stackless `HttpServerError` grouped
by route. Add the framework's hook and the error itself is recorded, stack
included, on the request span; the framework then handles it exactly as
before:

| Framework | Hook |
| --- | --- |
| Express / Connect | `app.use(autterErrorHandler())` after your routes, before your own error handlers — calls `next(err)` unchanged |
| Fastify 4/5 | `app.register(autterFastifyErrors)` or `autterFastifyErrors(app)` (`onError` hook; `autterFastify` already includes it) |
| Koa 2/3 | `app.use(autterKoa())` first — records and rethrows |
| Anything else (NestJS filters, hapi, …) | `captureRequestError(err)` from your error hook |

They report errors with status ≥ 500 (or none), RuntimeErrors and coded
errors; pass `{ capture: true }` for every error or a predicate. Each error is
reported once, even if your handler already called `captureException`.

**Unhandled promise rejections** are recorded as errors (severity `error`,
`autter.unhandled_rejection: true`) without changing whether the process
crashes. Adding an `unhandledRejection` listener would normally switch off
Node's default crash, so when Node would have crashed (default
`--unhandled-rejections=throw`, no other listener) the SDK rethrows the
rejection on the next tick: the process still exits with code 1 and the crash
is recorded as fatal, as before (your `uncaughtException` listeners see origin
`"uncaughtException"` instead of `"unhandledRejection"`). With your own
`unhandledRejection` listener, your listener decides. `warn-with-error-code`
keeps its warning and exit code 1; `strict` crashes first and is recorded by
the crash monitor. `captureUnhandledRejections: false` turns this off.

Request summaries and coded errors (1.5.0, ingester 1.5.0 first):

| Framework | Wiring |
| --- | --- |
| Express / Connect | `app.use(autterRequests())` early, `app.use(autterErrorResponse())` last |
| Fastify | `app.register(autterFastify)`; use `toClientError(err, runtimeContext.requestId)` in `setErrorHandler` |
| Koa / Hono on Node / custom fetch handlers | `withRuntimeRequest(handler)` around the fetch-style handler, or `withRuntimeOperation` per request |
| NestJS (Express adapter) | `app.use(autterRequests())` in `main.ts`; an exception filter calling `toClientError` |

App already runs its own OpenTelemetry SDK? Use `initAutterLogging` instead of
`initAutterServer` — requests, operations and coded errors without a second
NodeSDK. Details: [Requests, coded errors and background work](REQUESTS-AND-ERRORS.md).

## Edge runtimes (Cloudflare Workers, Vercel Edge, Deno, Bun)

```bash
npm install @autter/runtime-edge
```

```ts
import { withAutter } from "@autter/runtime-edge";
export default withAutter(
  (env) => ({ apiKey: env.AUTTER_RUNTIME_KEY, service: "edge-api" }),
  async (request, env, ctx, rt) => new Response("ok"),
);
```

Zero dependencies; request summaries, request ids and coded errors over
`/v1/logs`, delivered through `ctx.waitUntil`. Needs a **server** key from a
secret binding. Next.js `middleware.ts`: import from `@autter/runtime-next/edge`.
Each request is counted from its summary (request and failed-request counts,
release health): the records carry `autter.request.counted_by = "summary"`
(`runtime-edge` 1.3.0+, ingester 1.10.0+). Pass `countRequests:
false` where another sender already counts the same requests under the same
service name, e.g. middleware reporting as the Node server's service.

## Next.js

`npm install @autter/runtime-next` — three files (instrumentation.ts, relay
route, client init + boundary). `serverExternalPackages:
["@autter/runtime-node"]` in `next.config` is recommended: it keeps the SDK
out of the route bundles. Without it Next bundles extra copies of the SDK,
which share the one `registerAutter` started (1.6.1+; 1.6.0 needed the line).
See the package README. Route handlers:
`export const POST = withRuntimeRequest(handler)` (flush wired to `after()`);
`middleware.ts`: `@autter/runtime-next/edge`.

Errors Next catches itself (server components, server actions, route
handlers, middleware) need Next 15's `onRequestError` hook, or they arrive as
stackless 500s. In `instrumentation.ts`:

```ts
import { autterOnRequestError } from "@autter/runtime-next/instrumentation";

// Node: recorded on the request span by the registerAutter tracker.
// Edge: sent to /v1/logs with these options (no tracker runs on the edge).
export const onRequestError = autterOnRequestError({
  edge: { apiKey: process.env.AUTTER_RUNTIME_KEY, service: "web-app" },
});
```

Node-only apps can `export { onRequestError } from "@autter/runtime-next/instrumentation"`.
The subpath is safe on both runtimes: bundlers pick an edge-only build (no
Node imports) through the `edge-light`/`worker` export conditions (checked
with Next 15.5 and 16.4, webpack and Turbopack). It records the stack,
`next.route_path` (the route template, `/blog/[slug]`; middleware is
`/middleware` on Next 15, `/proxy` on 16), `next.router_kind`,
`next.route_type`, `next.render_source`, `next.digest`, the method and the path
without its query string — never headers or cookies — and skips
`redirect()`/`notFound()`. Next never calls the hook inside an edge route
handler; under `next start` the Node server reports those errors instead.

## Python (Django, FastAPI, Flask, Celery)

There is no Autter package for Python. Use OpenTelemetry's SDK, its OTLP/HTTP
exporter and its instrumentation for your framework, plus two files from
[`adapters/python`](../adapters/python) that you copy into your project:

- `autter_tracing.py`: always-on error spans (below) and `init_tracing()`,
  which builds the tracer provider from the standard `OTEL_*` variables;
- `redact.py`: the secret and PII scrubbing `@autter/runtime-node` does
  (stdlib only).

Tested recipes: [`examples/python`](../examples/python) has Django
(runserver), FastAPI (uvicorn), Flask (gunicorn) and a Celery prefork
worker, each with pinned requirements and a test that starts the app,
triggers an unhandled and a handled exception, and checks what was exported.

```bash
pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http \
  opentelemetry-instrumentation-django   # or -fastapi, -flask, -celery
curl -fsSO https://raw.githubusercontent.com/Autter-dev/autter-runtime/main/adapters/python/autter_tracing.py
curl -fsSO https://raw.githubusercontent.com/Autter-dev/autter-runtime/main/adapters/python/redact.py
```

Configuration is environment variables only:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.autter.dev            # the exporter adds /v1/traces
OTEL_EXPORTER_OTLP_HEADERS=x-autter-key=${AUTTER_RUNTIME_KEY}   # the server key
OTEL_SERVICE_NAME=shop
OTEL_RESOURCE_ATTRIBUTES=service.version=${GIT_SHA},deployment.environment=production
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1   # 10% of healthy traces; errors are always exported
```

`authorization=Bearer%20${AUTTER_RUNTIME_KEY}` works as well: header values
in `OTEL_EXPORTER_OTLP_HEADERS` are URL-encoded, and `x-autter-key` needs no
space. `service.version` is the release.

Call `init_tracing()` once in each process that serves requests or runs
tasks, at startup, before the framework instrumentation:

| Framework | Where | What |
| --- | --- | --- |
| Django | `wsgi.py` / `asgi.py`, before `get_wsgi_application()` | `init_tracing()`, `DjangoInstrumentor().instrument()` |
| FastAPI | the module that creates the app | `init_tracing()` first, then `FastAPIInstrumentor.instrument_app(app)` |
| Flask | the app module | `init_tracing()`, `app = Flask(__name__)`, `FlaskInstrumentor().instrument_app(app)` |
| Celery | the worker's `worker_process_init` signal | `init_tracing()`, `CeleryInstrumentor().instrument()` |

Django, in full:

```python
# shop/wsgi.py: runserver and gunicorn import it in the process that serves requests
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop.settings")

from autter_tracing import init_tracing
from opentelemetry.instrumentation.django import DjangoInstrumentor

init_tracing()
DjangoInstrumentor().instrument()

from django.core.wsgi import get_wsgi_application

application = get_wsgi_application()
```

```python
# shop/settings.py
MIDDLEWARE = [
    # ...your middleware...
    "shop.middleware.ClientErrorResponses",  # from examples/python/django: 404s are not errors
]
```

Prefork servers: gunicorn imports the WSGI module in each worker; with
`--preload` it imports it once before forking, and the exporter thread and
the error buffer restart in each worker. A Celery worker sets up tracing in
each pool child, as OpenTelemetry's Celery instrumentation requires (the
solo pool sends `worker_process_init` once; the threads, gevent and eventlet
pools do not: use `worker_init`):

```python
from celery.signals import worker_process_init
from opentelemetry.instrumentation.celery import CeleryInstrumentor

from autter_tracing import init_tracing


@worker_process_init.connect(weak=False)
def init_worker_tracing(**kwargs):
    init_tracing()
    CeleryInstrumentor().instrument()
```

### Always-on errors

Head sampling decides at a trace's first span, before anything has failed,
and the Python SDK exports sampled spans only: at a 10% ratio, 90% of
exceptions never leave the process. `init_tracing()` keeps them:

- `RecordUnsampled(sampler)` turns the head sampler's "drop" into "record
  only". Unsampled spans still reach the span processors, with the
  attributes they started with, keep the not-sampled flag and propagate it
  downstream.
- `RetainErrorTraces(processor)` holds the unsampled spans of each trace.
  When one of them ends with an `exception` event or ERROR status, the whole
  local trace goes to the batch processor: the spans that already ended (the
  failing child, the queries before it) and those that end later (the request
  span). A trace whose first local span ends without an error is dropped.
  Memory is bounded: 256 spans per trace, 5,000 buffered spans and traces,
  30 s per trace; past that, the oldest traces are plain head-sampled.
- Spans exported this way carry `autter.tail_retained = true`, like the
  traces `@autter/runtime-node` retains after an error. They are not a
  sample of the traffic, so the ingester counts no request from them; each
  error on them counts as one event. Head-sampled traces export unchanged.
- `RedactingSpanExporter` scrubs span names, attributes, status messages,
  exception messages and tracebacks, causes included, with `redact.py`
  before export. `redact.configure(value_patterns=[...], key_patterns=[...])`
  adds your own patterns. The ingester scrubs again.

Every request is recorded as if sampled (instrumentations collect their
attributes), but only sampled and failing traces are exported. To wire the
pieces yourself, for another exporter or more processors:

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

from autter_tracing import RecordUnsampled, RedactingSpanExporter, RetainErrorTraces

provider = TracerProvider(sampler=RecordUnsampled(ParentBased(TraceIdRatioBased(0.1))))
provider.add_span_processor(RetainErrorTraces(BatchSpanProcessor(RedactingSpanExporter(OTLPSpanExporter()))))
trace.set_tracer_provider(provider)
```

### Request counts (opt-in)

Without a metric feed, the ingester counts the requests of the traces head
sampling kept, while retention keeps every error: at a 10% ratio, request
counts read a tenth of the traffic and error rates (release health, the
post-deploy fix watch) read ten times too high. A Python meter provider's
default **cumulative** `http.server.duration` is not counted at all.
`init_tracing(count_requests=True)`, or `AUTTER_COUNT_REQUESTS=true`, counts
every request once:

```bash
AUTTER_COUNT_REQUESTS=true   # with the OTEL_* variables above; needs opentelemetry-exporter-otlp-proto-http
```

- `CountRequests` sees every HTTP server span, sampled or not
  (`RecordUnsampled` records them all), and records one point per request
  (each local-root span with `http.request.method` / `http.method`) in a
  **delta** `http.server.duration` histogram (ms, with the span's
  `http.route`, method and status code), exported to `/v1/metrics` through
  `OTLPMetricExporter` and the same `OTEL_EXPORTER_OTLP_*` variables every
  `OTEL_METRIC_EXPORT_INTERVAL` (default 60 s).
- The HTTP server spans it counted are exported with
  `autter.metric_has_route = true`, and the resource carries
  `autter.metrics_wired` and `autter.metrics_routes`, so the ingester
  (1.8.0+) adds no request from those spans: a head-sampled request is
  counted by the histogram only, a retained error trace adds its failure
  once (a 5xx is the histogram's; an error in a request answered below 500
  adds one error from its span), and an unsampled healthy request is
  counted though never exported.
- Its meter provider is registered as the global one, with the framework
  instrumentations' own `http.server.duration` / `http.server.request.duration`
  dropped (they would count every request again). Add your own instruments,
  such as a memory gauge, to it with `metrics.get_meter(...)`; do not
  register another meter provider. If one is already registered when
  `init_tracing()` runs, counting stays off with a warning, and so it does
  with a metric exporter that does not prefer delta histograms: the flags
  are only set next to the histogram that honours them.
- Non-HTTP server spans (gRPC) are not counted by it and keep their
  span-fed counts.

Wiring the pieces yourself: build the meter provider with
`request_meter_provider(resource)`, add `REQUEST_COUNT_RESOURCE_ATTRIBUTES`
to the tracer provider's resource, and wrap the exporting processor:
`CountRequests(RetainErrorTraces(BatchSpanProcessor(...)), meter_provider)`.
The Flask recipe tests it under gunicorn.

**Zero-code (`opentelemetry-instrument`).** The `opentelemetry-distro`
wrapper takes its sampler from `OTEL_TRACES_SAMPLER`, and no standard
sampler keeps the errors of unsampled traces. Either run it at full sampling
(`OTEL_TRACES_SAMPLER=parentbased_always_on`, plus
`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, since the distro defaults to
gRPC), sample in an OpenTelemetry Collector (see
[Sampling guidance](#sampling-guidance-all-stacks)), or start the app without
the wrapper and call `init_tracing()`. Under the wrapper, `init_tracing()`
leaves the wrapper's provider in place and warns when its sampler drops
errors. The Django recipe tests the full-sampling variant.

### Unhandled and handled exceptions

| Framework | Unhandled exceptions | Not recorded |
| --- | --- | --- |
| Django | OpenTelemetry's middleware, first in `MIDDLEWARE`, records the exception on the request span (`process_exception`), with ERROR status and the 500 | It also records `Http404`, `PermissionDenied`, `BadRequest` and `SuspiciousOperation`: add `ClientErrorResponses` so 404s are not issues. An exception another middleware's `process_exception` answers never reaches it |
| FastAPI | The ASGI middleware records what escapes the app (Starlette's 500) on the request span | `HTTPException` (a response), exceptions an `@app.exception_handler` answers |
| Flask | Recorded on the request span when the request is torn down (Flask's 500) | `abort()` / `HTTPException`, exceptions an `@app.errorhandler` answers |
| Celery | Recorded on the task's `run/<task name>` span, ERROR status | Nothing: every exception that fails a task is recorded, `throws=(...)` ones included |

Record handled exceptions, and the ones your own error handlers answer, on
the current span: in a request that is the request span, in a task the task
span.

```python
from opentelemetry import trace

try:
    refund_card(order_id)
except RefundPending as exc:
    trace.get_current_span().record_exception(exc, attributes={"autter.handled": True})
    return JsonResponse({"status": "pending"}, status=202)
```

`record_exception` sends `exception.type` (`module.Class`, as in
`shop.payments.RefundPending`; builtins bare, as in `KeyError`),
`exception.message` and `exception.stacktrace`: the whole formatted
traceback, chained exceptions included. A handled exception's traceback
starts at the function that caught it. Add `"autter.severity": "warning"`
to the attributes for one that should not count as an error.

What the ingester makes of a Python traceback: frames innermost first, with
their line numbers. A chained exception ("During handling of the above
exception…", "The above exception was the direct cause…") contributes the
frames of the exception that was reported, and an exception group (3.11+)
its own frames, not its sub-exceptions'. In-app frames are your files:
`site-packages`, `dist-packages` and the standard library (`<frozen …>`,
`lib/python3.X/`) are not. The `frames-v3` issue identity hashes the error
type and up to five in-app `function@file` tokens, so line numbers and ids
in messages (`card declined for order 4821`) do not split an issue, while
two Celery tasks failing in one helper are two issues. An error recorded on
two spans of a request (the instrumentation's request span and a span of
your own around the call) is one occurrence when both arrive in the same
export batch.

### Troubleshooting

- **Nothing arrives.** The exporter logs failed exports: a 401 is a missing
  or wrong key, a connection error the endpoint or egress.
  `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL;
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` takes the full `…/v1/traces` URL.
- **Errors arrive, healthy requests rarely.** That is the sampler at work.
- **No errors either.** `init_tracing()` did not run in the process that
  serves the requests: a module only a parent process imports, or a Celery
  pool child without the `worker_process_init` hook.
- **`init_tracing(): an OpenTelemetry TracerProvider is already registered`.**
  The app runs under `opentelemetry-instrument`: see Zero-code.
- **Every Django 404 is an issue.** Add `ClientErrorResponses`.
- **A stackless `HttpServerError` for a 500.** The framework or your error
  handler answered the exception before the instrumentation saw it: record
  it there. FastAPI's errored `http send` span of a 500 is folded into the
  request's error when both reach the ingester in one export batch;
  `FastAPIInstrumentor.instrument_app(app, exclude_spans=["send", "receive"])`
  drops those spans. Keep `OTEL_BSP_SCHEDULE_DELAY` at its default.
- **macOS development only.** `gunicorn --preload` workers die with
  `objc[…]: … fork() was called` (set `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES`;
  plain OpenTelemetry fails the same way), and Celery's prefork pool needs
  `FORKED_BY_MULTIPROCESSING=1`, since billiard spawns its children on macOS.

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

With a ratio sampler, keep errors as in
[Java / Ruby / .NET / anything else](#java--ruby--net--anything-else).

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

## Java / Ruby / .NET / anything else

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

**Always-on errors.** With a ratio sampler, an error on an unsampled trace is
dropped with it. The pieces the Python recipe uses are defined by the
[SDK specification](https://opentelemetry.io/docs/specs/otel/trace/sdk/#sampling),
so an SDK that implements it can be wired the same way: a sampler may answer
*record only*, span processors receive every recorded span, and exporters
receive sampled spans only. Wrap the head sampler so that its *drop* becomes
*record only*, and add a span processor
that, when a recorded but unsampled span ends with an `exception` event or
ERROR status, passes that span and the rest of its local trace to the
exporting processor with the sampled flag set and `autter.tail_retained =
true` on each span. [`adapters/python/autter_tracing.py`](../adapters/python/autter_tracing.py)
is the reference (buffering, bounds, local roots); only the Python version is
tested here. See your SDK's sampler and span processor docs:
[Go](https://pkg.go.dev/go.opentelemetry.io/otel/sdk/trace),
[Java](https://opentelemetry.io/docs/languages/java/sdk/),
[Ruby](https://opentelemetry.io/docs/languages/ruby/),
[.NET](https://opentelemetry.io/docs/languages/dotnet/). Without code changes,
sample at 100% in the SDK and let an OpenTelemetry Collector decide instead
(see [Sampling guidance](#sampling-guidance-all-stacks)).

**Coded errors** (any language): add `autter.error.code` (matching
`^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$`, ≤ 80 chars) and optionally
`autter.error.why`, `autter.error.fix`, `autter.error.link` and
`autter.error.expected` (boolean) to the exception event or the span. Coded
errors group by service + code across messages and sources; `expected` errors
never open incidents. Request summaries from other languages are OTLP log
records with `autter.event.type=operation`, `autter.operation.kind=request`,
`autter.request.id`, `http.route` and `http.response.status_code`.

**Warnings** (any language): add an `autter.severity` attribute to the
exception event — `"fatal" | "error" | "warning" | "info"` (default
`error`; the Node SDK's crash marker `autter.unhandled: true` implies
`fatal`). Warnings share the errors table with a `severity` column, so
they group and aggregate identically:

```python
span.record_exception(err)  # or add_event("exception", {...})
span.set_attribute("autter.severity", "warning")
```

## LLM / GenAI calls (any language)

Any span following the [OTel GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
is recognised automatically and stored per call with model, tokens,
latency, and a USD cost — no Autter package required. The attributes that
matter:

| Attribute | Meaning |
| --- | --- |
| `gen_ai.provider.name` (or legacy `gen_ai.system`) | "openai", "anthropic", … |
| `gen_ai.request.model` / `gen_ai.response.model` | model id |
| `gen_ai.operation.name` | "chat", "embeddings", … |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | token counts |
| `autter.llm.cost_usd` | optional exact cost — otherwise estimated from a built-in price table |
| `autter.user_id` | optional opaque end-user id (never an email) |

- **Node**: automatic — `initAutterServer` exempts GenAI spans from
  sampling. Use the Vercel AI SDK's `experimental_telemetry:
  { isEnabled: true }`, or wrap other clients with `withLlmCall` (see the
  [`@autter/runtime-node` README](../packages/runtime-node)).
- **Python**: `pip install opentelemetry-instrumentation-openai-v2` (or the
  anthropic/bedrock equivalents) and instrument as usual.
- **Go / Rust / others**: emit a client span with the attributes above
  around each model call.

**Sampling caveat (non-Node stacks):** the ~1% ratio sampler below applies
to all spans, GenAI included — at 1% your cost numbers are meaningless.
Exempt them, e.g. a custom sampler that always samples spans whose name
starts with `chat`/`gen_ai`/`ai.` or that carry `gen_ai.*` attributes, or
emit LLM spans through a second, always-on tracer provider pointed at the
same exporter. (The Node package does this exemption for you.)

## Sampling guidance (all stacks)

Errors are always worth sending; keep successful-trace sampling at ~1%
(`OTEL_TRACES_SAMPLER_ARG=0.01`). Request/usage metrics are derived
server-side from server spans (one count per request) and the
`http.server.request.duration` / `http.server.duration` histogram — no extra
setup. A sampled request reaches both feeds, so at ~1% sampling request
counts read ~1% high. To count it from the histogram alone (delta
temporality, `http.route` on the data point), add
`autter.metrics_wired=true,autter.metrics_routes=true` to
`OTEL_RESOURCE_ATTRIBUTES` and set `autter.metric_has_route=true` on each
server span whose data point carries `http.route` (`@autter/runtime-node`
1.7.0+ does all of this for you, and so does `adapters/python`'s
`init_tracing(count_requests=True)`: see
[Request counts](#request-counts-opt-in)). Cumulative histograms are not
counted, so leave the flags off with them. LLM/GenAI spans are the exception — send
them at 100% (see above).

One consequence of plain head sampling to know about: an error recorded on
an unsampled trace is dropped with it, and even when the error survives
through a separate path, the trace explaining it usually doesn't.
`@autter/runtime-node` handles both automatically — errors ride a dedicated
always-on tracer, and the full trace around an error is tail-retained even
when head sampling said no (`retainTracesOnError`, on by default). Python
services get the same from `adapters/python/autter_tracing.py`
([Always-on errors](#always-on-errors)), and other SDKs can be wired the same
way ([Java / Ruby / .NET](#java--ruby--net--anything-else)). Alternatively,
sample at 100% in the SDK and put an OTel Collector with the
`tail_sampling` processor (a `status_code = ERROR` policy plus a small
`probabilistic` one) in front of the ingester.
