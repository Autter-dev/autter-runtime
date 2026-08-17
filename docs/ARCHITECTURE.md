# Architecture & Data Model

## Signal flow

```
browser app ──tiny JSON──▶ customer's same-origin relay ──▶ /v1/browser ─┐
                                                                          ├─▶ normalise → fingerprint
server app ──OTLP/HTTP────────────────────────────────────▶ /v1/traces ──┤
                                                            /v1/metrics ─┘
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
| `runtime_metrics_1m` | SummingMergeTree | `(org_id, repository_id, service, environment, release, route, bucket_at)` | 90 d |
| `runtime_llm_calls` | MergeTree | `(org_id, repository_id, started_at)` | 90 d |

`runtime_llm_calls` is per-call, not rolled up: LLM traffic is orders of
magnitude smaller than HTTP, spend analysis needs per-call granularity
(model, tokens, `cost_usd`, `cost_source`, user/session, and `error_type`
for failed calls), and SDKs send GenAI spans unsampled (the errors-are-100%
rule applies to money too).

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
| `fingerprint` | hash of source+service+type+normalised message+top frames+normalised route | the issue group key |
| `severity` | SDK-declared (`autter.severity`); `autter.unhandled` ⇒ `fatal` | errors vs warnings, alert thresholds |
| `message_normalized` | ids/numbers/quoted strings templated out | "what is this group" label |
| `route_normalized` | `/users/8812` → `/users/:id` | errors-by-endpoint, low-cardinality |
| `top_frames` (Array) | top ≤5 normalised stack frames | "point of error" drill-down |
| `first_frame` | `top_frames[1]` | single-column GROUP BY for hotspot files |
| `method` | `http.request.method` | split GET vs POST failures |

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
  `error_count` (status ≥ 500 or span error), `duration_sum_ms`.
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

Event types: `exception`, `unhandled_rejection`, `session_start`, and
`track_event` (carries a `name`; counted into `runtime_metrics_1m` as
`request_count` on the synthetic route `event:<name>` — coarse usage
counters, not an analytics event store).

Forbidden at the schema level (rejected/stripped): full URLs with query
strings, cookies, DOM content, form values, request headers/bodies, emails.

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
      "occurredAt": "2026-07-21T11:22:00.123Z"
    }
  ]
}
```

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
