# Continuous runtime detection

For process memory growth, OOM kills, and restart correlation, see
[Memory pressure incidents](MEMORY-PRESSURE.md).

Autter already ingests OTLP traces and metrics. The ingester now also makes an
issue from a server or dependency span with `ERROR` status, an `exception`
event, or an HTTP 5xx status, even when the application has no log statement.
HTTP 4xx responses remain ordinary outcomes. Browser fetch and XHR failures, 5xx
responses, long tasks, and slow resources are observed without request bodies,
headers, query strings, or DOM content.

Existing OTLP exporters benefit from server-side detection without an SDK
upgrade when the ingester is 1.3.2 or later. Install
`@autter/runtime-node`, `@autter/runtime-browser`, or `@autter/runtime-next`
version 1.3.2 or later to use the new outcome helpers
and browser network and timing capture in an application.

## Report a failed outcome without throwing

Use a stable operation name when code returns normally but the result is wrong:

```ts
import { reportOutcome } from "@autter/runtime-node";
reportOutcome("checkout.payment", "Provider rejected a valid payment");
```

```ts
import { captureOutcome } from "@autter/runtime-browser";
captureOutcome("checkout.payment", "Checkout could not complete");
```

Other OTel languages emit an event named `autter.outcome` on the current span
with `autter.outcome.status=error`, `autter.outcome.name=<stable name>`, and
`autter.outcome.message=<short reason>`. Set the span status to `ERROR` and
ensure failed traces are retained by the exporter. Autter groups the event as
an `OutcomeFailure`; no exception or log is required.

## Coded errors and expected failures

Ingester 1.5.0 groups an error by its **code** when it carries a valid
`autter.error.code` (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$`, at most 80
characters): one code in one service is one issue, whatever the message,
stack, route or source (server spans, logger-only and edge log records,
the browser, and external connectors all use the same `code-v1`
fingerprint). Uncoded errors keep message-based grouping unchanged.

```ts
import { defineRuntimeErrors } from "@autter/runtime-node";

export const billingErrors = defineRuntimeErrors("billing", {
  declined: { status: 402, message: "Payment declined", expected: true,
              why: "The card issuer rejected the charge", fix: "Ask the customer for another card" },
});
throw billingErrors.declined();                       // code "billing.declined"
```

Any error with a `code` property in that shape benefits without a rewrite:
`captureException` in the Node, edge and browser SDKs reads
`code/why/fix/link/expected` from the error. Other OTel languages set the
attributes on the `exception` event (or its span):

| Attribute | Meaning |
| --- | --- |
| `autter.error.code` | Grouping key (invalid values are ignored) |
| `autter.error.why` / `autter.error.fix` | Declared cause and remedy, up to 1,000 characters each |
| `autter.error.link` | http(s) docs link, up to 500 characters |
| `autter.error.expected` | `true` for an expected business failure |
| `autter.request.id` | Request id; links the error to its request summary |

The declared `why` and `fix` are shown on the issue and handed to root-cause
analysis **as declared**: the analysis confirms or contradicts them with
evidence rather than repeating them.

**Expected failures** (`expected: true` — declines, validation, quota) are
still recorded and counted, but they never open incidents or trigger
automatic fixes. They are hidden from the default issues view; include them
with the "expected" filter. Use them for outcomes your product handles on
purpose, not to silence real defects.

In the browser, `autterErrorFromResponse(res)` turns a failed `fetch`
response with an `{ "error": { "code", … } }` body into an error carrying
the server's code, and automatically observed 5xx responses carry their
`x-request-id` so the browser failure links to the server request.

Services without a trace pipeline (logger-only mode and
`@autter/runtime-edge`) send errors as log records marked
`autter.capture.mode=log`; the ingester promotes those into issues, skipping
any whose trace already produced one in the last minute.

## Traces and profiles

Install framework, database, HTTP client, and queue instrumentations so a slow
request has useful child spans. Send request histograms for accurate endpoint
regression detection. Server profilers that export symbolized pprof protobuf
can POST to `/v1/profiles` with a **server** Runtime key and headers
`x-autter-service`, `x-autter-environment`, `x-autter-release`, and optional
`x-autter-trace-id` (32 lowercase hex characters). Use
`Content-Type: application/x-pprof`. Raw or gzip encoded pprof is accepted.
Uploads are capped at 1 MiB compressed and decoded and 1,000
samples; sampled stacks are stored in ClickHouse for seven days. The same
service, environment, release, and time link profiles to incident traces.

Browser timing signals identify slow tasks and resources; portable browser
APIs do not identify arbitrary JavaScript function CPU time. A server profiler
must be installed and configured separately from OTLP tracing.

## Optional caught exception sampling

Intentionally handled throws are usually normal control flow. Do not enable
these hooks by default. Node services can call
`startCaughtExceptionSampler({ sampleRate: 0.01, maxPerMinute: 10 })` from
`@autter/runtime-node` and call `stop()` on shutdown. This uses V8 Inspector
and briefly pauses at **every** throw, even when only one percent are sent.
The optional Python adapter is at
`adapters/python/caught_exceptions.py`; pass a callback that sends a standard
OTel `exception` event with `autter.handled=true` and
`autter.sampled=true` on an always-on span. Python tracing also has material
overhead, applies to the current and newly created threads, and should be
enabled only for targeted diagnosis. Other languages can send the same event.

```python
from opentelemetry import trace
from caught_exceptions import install_caught_sampler

tracer = trace.get_tracer("autter-caught-exceptions")

def emit(exception_type: str, stack: str) -> None:
    with tracer.start_as_current_span("caught.exception") as span:
        span.add_event("exception", {
            "exception.type": exception_type,
            "exception.stacktrace": stack,
            "autter.handled": True,
            "autter.sampled": True,
        })

stop = install_caught_sampler(emit, sample_rate=0.01, max_per_minute=10)
```

Configure this tracer to export every sampled hook event; an additional head
sampler may otherwise discard it.

## Browser source maps

CI can upload each production JavaScript source map to `/v1/sourcemaps` with
a server key and JSON `{ "release": "<commit SHA>", "filename": "/assets/app.js",
"map": <source map object> }`. The `release` must match the browser SDK
release. Autter strips `sourcesContent`, stores the mapping for 30 days, and
uses it to resolve minified stack positions before proposing a browser fix.
Without a matching source map, the issue still appears but Autter may lack
enough evidence to prepare a PR. Never put a server key in the browser bundle.

All automatically prepared fixes are draft PRs. Repository owners can turn
expanded detection or automatic drafts off in Runtime Overview.

## Rollout order

Deploy the ingester first so it creates the profile and source map ClickHouse
tables (including migrations for existing databases). For coded errors and
request summaries, ingester 1.5.0 must be deployed before runtime-node/next
1.5.0, runtime-browser 1.4.0 or runtime-edge 1.0.0 send them; older ingesters
keep codes only inside the attributes JSON and group by message. Then deploy the backend
and frontend; their organization tables are created for new organizations and
upgraded on first use for existing ones. Finally publish the SDKs and enable
profilers or the optional caught exception hooks service by service. Profiles
only contain the sampled CPU frames supplied by a configured profiler; they
cannot reconstruct CPU time from a trace alone.
