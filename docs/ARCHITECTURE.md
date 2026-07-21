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

## Tenancy

Every ClickHouse row is keyed by `(org_id, repository_id)` and every query
must filter on both. One repository = one unit of analysis; the ingest key
carries the mapping, so a key is scoped to exactly one repo.

## ClickHouse tables

| Table | Engine | Order by | TTL |
| --- | --- | --- | --- |
| `runtime_error_occurrences` | MergeTree | `(org_id, repository_id, fingerprint, occurred_at)` | 14 d |
| `runtime_spans` | MergeTree | `(org_id, repository_id, trace_id, started_at)` | 7 d |
| `runtime_metrics_1m` | SummingMergeTree | `(org_id, repository_id, service, environment, release, route, bucket_at)` | 90 d |

`runtime_metrics_1m` is pre-aggregated per minute; readers must
`SUM(...) GROUP BY` because SummingMergeTree collapses rows at merge time,
eventually. Percentiles come from sampled spans at query time — the rollup
table stores only counts and duration sums.

Retention philosophy: raw signal is short-lived; anything worth keeping
long-term (issue summaries, incident history, learnings) is derived and
stored by the sink consumer.

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

Delivery is best-effort fire-and-forget (the ingester is not a queue); the
consumer should treat ClickHouse as the recovery source for missed batches.
