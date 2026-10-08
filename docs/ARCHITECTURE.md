# Architecture & Data Model

## Signal flow

```
browser app ──tiny JSON──▶ customer's same-origin relay ──▶ /v1/browser ─┐
                                                                          ├─▶ normalise → fingerprint
server app ──OTLP/HTTP────────────────────────────────────▶ /v1/traces ──┤
                                                            /v1/metrics ─┤
                                                            /v1/logs ────┘
                                                                          │
                                              ┌───────────────────────────┤
                                              ▼                           ▼
                                     ClickHouse (raw + rollups)   sink webhook (optional)
                                                                  → issue grouping in
                                                                    the consumer's Postgres
```

The ingester is **stateless**: auth key → `{orgId, repositoryId}` resolution,
normalisation, fingerprinting, ClickHouse writes, optional forward. Anything
stateful (issue lifecycle, incidents, correlation, symbolication) belongs to
the consumer of the sink webhook (Autter cloud, or your own backend).

## Tenancy & key scopes

Every ClickHouse row is keyed by `(org_id, repository_id)` and every query
must filter on both. One repository = one unit of analysis; the ingest key
carries the mapping, so a key is scoped to exactly one repo.

Two key scopes separate frontend and backend credentials:

- **Server keys** (`autter_rt_…`, secret): backends only — OTLP endpoints
  and as the relay's forwarding key. Sent as a bearer header.
- **Client keys** (`autter_rtc_…`, publishable): shipped in frontend
  bundles for direct browser ingest. Restricted to `/v1/browser`, enforced
  against a per-key origin allow-list, tighter rate limits, and carried as
  a `?key=` query param because `sendBeacon` cannot set headers. A leaked
  client key can at worst submit fake browser events for one repo — it can
  never read data or send OTLP.

## ClickHouse tables

| Table | Engine | Order by | TTL |
| --- | --- | --- | --- |
| `runtime_error_occurrences` | MergeTree | `(org_id, repository_id, fingerprint, occurred_at)` | 14 d |
| `runtime_spans` | MergeTree | `(org_id, repository_id, trace_id, started_at)` | 7 d |
| `runtime_logs` | ReplacingMergeTree | `(org_id, repository_id, occurred_at, event_id)` | `LOG_TTL_DAYS` (14 d) |
| `runtime_request_1m` | AggregatingMergeTree (fed by `runtime_request_1m_mv`) | `(org_id, repository_id, service, environment, route, method, bucket_at)` | 90 d |
| `runtime_metrics_1m` | SummingMergeTree | `(org_id, repository_id, service, environment, release, route, bucket_at)` | 90 d |
| `runtime_latency_histograms` | ReplacingMergeTree | `(org_id, repository_id, service, environment, bucket_at, point_id)` | 90 d (`METRICS_TTL_DAYS`) |
| `runtime_memory_samples` | ReplacingMergeTree | `(org_id, repository_id, service, environment, instance_id, metric, observed_at)` | 14 d |
| `runtime_platform_events` | ReplacingMergeTree | `(org_id, repository_id, event_id)` | 30 d |
| `runtime_llm_calls` | MergeTree | `(org_id, repository_id, started_at)` | 90 d |
| `runtime_profile_samples` | MergeTree | `(org_id, repository_id, service, environment, release, observed_at, profile_id)` | 7 d |
| `runtime_source_maps` | ReplacingMergeTree | `(org_id, repository_id, release, filename)` | 30 d |

Profile uploads are server key authenticated, limited to 1 MiB, and decoded
from symbolized pprof into at most 1,000 stack samples. Source map uploads
strip `sourcesContent` and are used only to resolve browser stack positions
for matching releases. See [continuous detection](CONTINUOUS-DETECTION.md).

`runtime_llm_calls` is per-call, not rolled up: LLM traffic is orders of
magnitude smaller than HTTP, spend analysis needs per-call granularity
(model, tokens, `cost_usd`, `cost_source`, user/session, and `error_type`
for failed calls), and SDKs send GenAI spans unsampled (the errors-are-100%
rule applies to money too).

`runtime_latency_histograms` stores per-route OTLP duration histograms
(bucket bounds + counts) so latency percentiles can be computed from
unsampled metrics. `runtime_memory_samples` holds per-instance process
memory/GC gauges and `runtime_platform_events` ECS/Kubernetes OOM kills and
restarts (`POST /v1/platform-events`), which the consumer correlates with
memory incidents.

### Wide events: `runtime_logs` and `runtime_request_1m`

`runtime_logs` holds plain log records, operation summaries and (from
runtime-node 1.5.0) **request summaries** — one row per HTTP request or job,
always kept (no sampling; `LOG_TTL_DAYS` is the volume knob). Migration
0012 lifts the attributes every query filters on into columns:

| Column | Source attribute | Notes |
| --- | --- | --- |
| `kind` | `autter.operation.kind` | `request` / `operation` (1.4.0 operation summaries without it → `operation`); `''` for plain logs |
| `request_id` | `autter.request.id` | bloom-filter skip index `idx_logs_request_id` — "everything for request X" |
| `route` | `http.route` | query-stripped, id-normalised (`/orders/:id`) |
| `status_code` | `http.response.status_code` | `0` when absent |
| `error_code` | `autter.error.code` | only when it matches `CODE_PATTERN` |
| `ai_cost_usd` / `ai_calls` | `autter.operation.ai` (`cost_usd`, `calls`) or the flattened `autter.operation.ai.*` keys | AI rollup per summary |

The full event (context, steps, inline `autter.operation.logs`) stays in the
`attributes` JSON. `runtime_request_1m_mv` aggregates `kind = 'request'` rows
into `runtime_request_1m` per route/method/minute (`method` comes from the
`http.request.method` attribute). Read it with `sum(request_count)`,
`sum(failed_count)` (`outcome = 'failed'`), `sum(duration_sum_ms)` and
`quantilesMerge(0.5, 0.95)(duration_quantiles)`. The view only sees rows
inserted after it exists, and it counts every insert: a batch retried by an
exporter (after a 503 or a lost 2xx) is collapsed in `runtime_logs` by
`event_id` but counted twice in the rollup — route stats are approximate
under retries; exact per-request answers come from `runtime_logs`.

**Log promotion.** Logger-only mode and `@autter/runtime-edge` have no span
to record an exception on; they send error log records with `exception.*`
and `autter.capture.mode = "log"`. `/v1/logs` promotes such records (severity
≥ error) to server occurrences — fingerprinted, written to
`runtime_error_occurrences`, counted in `runtime_metrics_1m` and forwarded to
the sink. A record is skipped when its trace id already produced an
occurrence in the same batch or, per a ClickHouse lookup, within ±60 s for
the same org/repo (the lookup ignores the candidates' own deterministic
ids, so a retried batch never dedupes against itself). A failed lookup
promotes anyway. Records without a trace id are always promoted.

`runtime_metrics_1m` is pre-aggregated per minute; readers must
`SUM(...) GROUP BY` because SummingMergeTree collapses rows at merge time,
eventually. Percentiles come from sampled spans at query time — the rollup
table stores only counts and duration sums.

These tables also feed the dashboard's **slow-process monitor** (in the
Autter backend, not this repo): it flags processes that are slow AND
repeating a lot, then runs an automated optimization analysis that can
open a fix PR. Because regular traces are head-sampled upstream (1% by
default), the monitor takes run counts for HTTP routes from
`runtime_metrics_1m` (metric-fed, unsampled) and uses `runtime_spans`
only for percentiles and trace breakdowns. Non-HTTP work is detected
from spans alone — which is why `withProcessSpan` in
`@autter/runtime-node` exports through the always-on pipe: manual
process spans arrive unsampled, giving the monitor accurate counts.

### Occurrences are aggregation-ready at write time

`runtime_error_occurrences` holds errors **and** warnings/info
(`severity` column: `fatal | error | warning | info`) — one dataset,
sliceable by severity, rather than separate pipelines. Alongside the raw
fields, the ingester stores derived columns computed by the same
normalisers the fingerprint hashes, so aggregations never re-parse
stacks or routes in SQL:

| Column | Derivation | Aggregation use |
| --- | --- | --- |
| `fingerprint` | `code-v1`: hash of service+error code; `message-v1`: hash of source+service+type+normalised message+top frames+normalised route (see [Fingerprinting](#fingerprinting)) | the issue group key |
| `severity` | SDK-declared (`autter.severity`); `autter.unhandled` ⇒ `fatal` | errors vs warnings, alert thresholds |
| `message_normalized` | ids/numbers/quoted strings templated out | "what is this group" label |
| `route_normalized` | `/users/8812` → `/users/:id` | errors-by-endpoint, low-cardinality |
| `top_frames` (Array) | top ≤5 normalised stack frames | "point of error" drill-down |
| `first_frame` | `top_frames[1]` | single-column GROUP BY for hotspot files |
| `method` | `http.request.method` | split GET vs POST failures |
| `fingerprint_scheme` | `code-v1` when grouped by a valid error code, else `message-v1` | tell coded issues from message-grouped ones |
| `error_code` | `autter.error.code` (validated) | errors-by-code |
| `error_why` / `error_fix` / `error_link` | `autter.error.why` / `.fix` / `.link` (scrubbed; ≤1000 / ≤1000 / ≤500 chars, http(s) links only) | declared cause/remedy for triage and RCA |
| `expected` (UInt8) | `autter.error.expected` | expected business failures — recorded, never paged |
| `request_id` | `autter.request.id` (exception spans inherit it from their server span; browser failures read `x-request-id`) | join to the request summary; bloom index `idx_occ_request_id` |

Severity is deliberately **not** part of the fingerprint: the same defect
reported as a warning in one code path and an error in another stays one
group.

Retention philosophy: raw signal is short-lived; anything worth keeping
long-term (issue summaries, incident history, learnings) is derived and
stored by the sink consumer.

**Schema evolution:** the ingester migrates the database itself at boot —
baseline `CREATE IF NOT EXISTS` for fresh databases plus versioned,
idempotent migrations (`packages/otlp-ingester/src/migrations.ts`) tracked
in `<db>.schema_migrations` for existing ones. Deploying a new ingester
version *is* the schema deployment. Readers (dashboards, the Autter
backend) should treat columns as additive-only within a major version.

## Fingerprinting

Two schemes; `fingerprint_scheme` records which one produced a row.

**`code-v1`** — when the occurrence carries a valid `autter.error.code`
(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$`, ≤80 chars):

```
sha256("code-v1" + "\0" + service + "\0" + code).hex()[:32]
```

Source, error type, message, stack and route are deliberately left out, so
the same code from the trace path, log promotion, the browser or an external
connector (Sentry, PostHog, Datadog, Loki, generic webhook — mapped by the
Autter backend) lands in **one issue**. Route and message stay as facets on
the occurrence rows. Test vector: `payments-api` + `billing.declined` →
`1692d304df5e4edbd3a0bbac5d7658bb`. Invalid codes (`ECONNRESET`, ids, free
text) are ignored and the error falls back to `message-v1`.

**`message-v1`** — every uncoded error, unchanged byte-for-byte from
pre-1.5.0 so existing issues never regroup:

`sha256(source + service + error_type + normalised_message + top_5_frames + normalised_route)`,
truncated to 32 hex chars.

- Message normalisation: quoted strings → `<str>`, UUIDs → `<uuid>`, long hex
  → `<hex>`, numbers → `<n>`.
- Frame normalisation: query strings and line/column offsets stripped —
  minified bundle offsets shift every deploy; file + function name are stable.
- Route normalisation: id-like path segments → `:id`
  (`/orders/812` → `/orders/:id`).

The same algorithm runs in the Autter backend so browser-relay and OTLP
occurrences group identically.

## OTLP mapping (traces)

Resource attributes:

| OTel attribute | Field |
| --- | --- |
| `service.name` | `service` |
| `deployment.environment` / `deployment.environment.name` | `environment` |
| `service.version` | `release` |

Span-level:

- Error occurrence emitted when span status is `ERROR`, or per `exception`
  event (`exception.type`, `exception.message`, `exception.stacktrace`).
- `route` from `http.route`, falling back to `url.path` / `http.target`
  (query-stripped).
- `status_code` from `http.response.status_code` / `http.status_code`.
- Server spans aggregate into 1-minute usage rollups: `request_count`,
  `error_count` (status ≥ 500 or span error), `duration_sum_ms`. Rollup
  rows key on the **normalized** route (id-like path segments → `:id`), so
  span-fed and metric-fed rows for the same endpoint sum together and the
  SummingMergeTree key space stays bounded; `runtime_metrics_1m` route
  values are templates, never raw paths. (Metric-fed rollups get their
  route from `http.route` on `http.server.duration` /
  `http.server.request.duration` data points — OTel never puts raw URL
  paths on metrics, so the SDK must set the route template;
  `@autter/runtime-node` does this for Express out of the box.)
- Double-count guards on `runtime_metrics_1m`: resources marked
  `autter.metrics_wired` (set by `@autter/runtime-node`, which always
  exports request metrics) do NOT get span-fed rollups — their spans are
  head-sampled, the metric feed is exact. And only **delta**-temporality
  histograms fold into rollups: cumulative points repeat lifetime totals
  every export, which a SummingMergeTree would re-add each minute;
  cumulative senders are covered by the span-fed fallback instead.
- GenAI spans (`gen_ai.*` attributes; Vercel AI SDK inner `.doGenerate` /
  `.doStream` / `.doEmbed` spans) additionally produce a `runtime_llm_calls`
  row — provider, model, operation, token counts, and cost
  (`autter.llm.cost_usd` if reported, else estimated from the built-in
  price table). Outer AI SDK spans are skipped to avoid double counting.

## OTLP mapping (LLM calls)

Spans that identify an LLM provider call become one `runtime_llm_calls`
row each — no Autter-specific code required. Three attribute families are
recognised (first match wins per field):

| Field | Attributes checked |
| --- | --- |
| `provider` | `gen_ai.system`, `ai.model.provider` |
| `model` | `gen_ai.response.model`, `gen_ai.request.model`, `ai.response.model`, `ai.model.id` |
| `operation` | `gen_ai.operation.name`, derived from Vercel span names |
| `input_tokens` | `gen_ai.usage.input_tokens`, `gen_ai.usage.prompt_tokens`, `ai.usage.promptTokens`, `ai.usage.inputTokens` |
| `output_tokens` | `gen_ai.usage.output_tokens`, `gen_ai.usage.completion_tokens`, `ai.usage.completionTokens`, `ai.usage.outputTokens` |
| `cost_usd` | `autter.llm.cost_usd` / `gen_ai.usage.cost` (reported), else estimated from a built-in per-model price table (`cost_source` records which) |
| `user_id` | `autter.user_id`, `ai.telemetry.metadata.userId`, `enduser.id`, `user.id` |
| `session_id` | `autter.session_id`, `ai.telemetry.metadata.sessionId`, `session.id` |

A span qualifies when it carries a model or provider attribute. Vercel AI
SDK umbrella spans (`ai.generateText`, `ai.streamText`, …) are skipped —
only their provider-level `.doGenerate`/`.doStream`/`.doEmbed` children
count, so retries are counted individually and nothing double-counts.
Failed calls keep `status = 'error'` (+ `error.type`), and any `exception`
events on the span still produce regular error occurrences, so LLM
failures group into issues like any other error.

## Browser payload (v1)

```json
{
  "version": 1,
  "sessionId": "s_48ba12",
  "service": "web-app",
  "environment": "production",
  "release": "e4a218f",
  "events": [
    {
      "type": "exception",
      "timestamp": "2026-07-21T11:22:00Z",
      "message": "Cannot read properties of undefined",
      "stack": "TypeError: ...",
      "filename": "/assets/checkout.js",
      "line": 127,
      "column": 18,
      "route": "/checkout"
    }
  ]
}
```

Declared-error context keys (runtime-browser ≥1.4.0) are lifted into the
occurrence fields above: `autter.error.code|why|fix|link|expected` (from coded
errors and `autterErrorFromResponse`) and `autter.request.id` (the
`x-request-id` header of a failed fetch/XHR). Each is validated on its own; a
malformed value is dropped without rejecting the payload.

Event types: `exception`, `unhandled_rejection`, `session_start`, and
`track_event` (carries a `name`; counted into `runtime_metrics_1m` as
`request_count` on the synthetic route `event:<name>` — coarse usage
counters, not an analytics event store).

Forbidden at the schema level (rejected/stripped): full URLs with query
strings, cookies, DOM content, form values, request headers/bodies, emails.

Server-side telemetry is guarded at the source instead: the Node SDK masks
secret/PII-shaped values (tokens, keys, credentials in connection strings
and URLs, emails, card numbers) and sensitive-keyed attributes in
attributes, exception messages, stack traces and status messages, and
re-scrubs every span at export (`redactAttributes`, on by default). The
browser SDK, the relay and the Python adapter apply the same patterns.

Because old SDKs and plain OTel senders scrub nothing, the ingester scrubs
again before storage and before the sink webhook (which feeds downstream
LLM-assisted fixing): occurrence message/stack/route, span names, all
attribute bags, and LLM-call attributes (`src/redact.ts`; extend with
`AUTTER_REDACT_VALUE_PATTERNS` / `AUTTER_REDACT_KEY_PATTERNS`, JSON arrays
of regex sources). Messages containing secrets therefore fingerprint on
their scrubbed form.

## Sink webhook (v1)

When `AUTTER_SINK_URL` is set, each ingest batch POSTs:

```json
{
  "version": 1,
  "batchId": "5f0c9e7a-…",
  "orgId": "...",
  "repositoryId": "...",
  "occurrences": [
    {
      "occurrenceId": "...",
      "fingerprint": "...",
      "source": "server",
      "service": "payments-api",
      "environment": "production",
      "release": "e4a218f",
      "errorType": "TypeError",
      "message": "...",
      "stack": "...",
      "route": "/orders/:id",
      "statusCode": 500,
      "traceId": "...",
      "sessionId": "",
      "occurredAt": "2026-07-21T11:22:00.123Z",
      "method": "POST",
      "fingerprintScheme": "code-v1",
      "errorCode": "billing.declined",
      "why": "The card issuer rejected the charge",
      "fix": "Ask the customer for another card",
      "link": "https://docs.example.com/payments#declined",
      "expected": true,
      "requestId": "req_3f9a…"
    }
  ]
}
```

1.5.0 additions to occurrences, all optional and omitted when absent (the
payload stays `version: 1`; older consumers ignore unknown keys):
`errorCode`, `why`, `fix`, `link`, `expected`, `requestId`, `traceId`,
`route`, `method`, `statusCode`, `fingerprintScheme` (`message-v1` |
`code-v1`). `traceId`/`route`/`method`/`statusCode` used to be sent as `null`
when unknown; they are now left out instead. Occurrences promoted from
`/v1/logs` arrive through the same payload.

Batches also carry `metrics` (1-minute usage rollup points) and `llmCalls`
(per-call LLM usage — provider, model, tokens, `costUsd`, `costSource`,
`userId`, `status`, `startedAt`) whenever the ingest produced them — same
shapes as their ClickHouse rows, additive to the v1 payload.

### Delivery semantics

Delivery is **at-least-once within a process lifetime**: batches queue in
memory and retry with exponential backoff (1 s → 60 s, `SINK_MAX_ATTEMPTS`
tries, ~8 min by default) on network errors, timeouts, 408/429, and 5xx.
Other 4xx responses mean the consumer rejected the batch — those drop
immediately and are logged. The retry buffer is bounded
(`SINK_MAX_BUFFERED_BATCHES` / `SINK_MAX_BUFFERED_MB`); on overflow the
oldest batch of the tenant holding the most buffered bytes drops first —
one flooding org cannot evict everyone else — and every drop is logged
with its signal time range. A single batch larger than the whole buffer
is dropped alone rather than flushing the queue. Retrying batches keep
their enqueue-age position, so eviction order stays oldest-first even
under sustained failure.

Consequences for consumers:

- **Deduplicate on `batchId`** (and per-occurrence on `occurrenceId`):
  a batch can arrive more than once — e.g. the consumer processed it but
  the 2xx response was lost, so the ingester retried.
- **`occurrenceId` is content-derived, not random.** An OTLP exporter
  that retries an export (after a 503 from a partially-failed ClickHouse
  write, or a lost 2xx) reproduces the same ids, so per-occurrence dedupe
  holds across transport retries too — and duplicated ClickHouse rows
  share an id, so replays and row counts should use distinct ids.
- **ClickHouse is the recovery source.** Every forwarded signal was
  written to ClickHouse before it was queued (ingest returns 503
  otherwise), so a crashed ingester, an exhausted retry budget, or a
  buffer overflow never loses data — the consumer reconciles by replaying
  the affected time range from `runtime_error_occurrences` /
  `runtime_metrics_1m`. Occurrence rows carry the same `occurrence_id`
  the sink payload does, so replays deduplicate exactly.
- `/healthz` exposes delivery counters (`sink.queued`, `sink.delivered`,
  `sink.retried`, `sink.droppedOverflow`, `sink.droppedPermanent`,
  `sink.lastFailureAt`, …) for missed-batch monitoring and alerting.
  Failure detail is a fixed category (`sink.lastFailureReason`:
  `timeout`, `connection_error`, `http_<status>`, `error`) — raw
  transport errors stay in server logs, never in the unauthenticated
  health response.
