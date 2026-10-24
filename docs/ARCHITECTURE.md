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
normalisation, stack parsing and browser symbolication (against source maps
uploaded to its own ClickHouse, cached in memory), fingerprinting, ClickHouse
writes, optional forward. Anything stateful (issue lifecycle, which identity
an issue is keyed by, incidents, correlation) belongs to the consumer of the
sink webhook (Autter cloud, or your own backend).

## Tenancy & key scopes

Every ClickHouse row is keyed by `(org_id, repository_id)` and every query
must filter on both. One repository = one unit of analysis; the ingest key
carries the mapping, so a key is scoped to exactly one repo.

Three key scopes separate frontend, backend and CI credentials:

- **Server keys** (`autter_rt_…`, secret): backends only — OTLP endpoints
  and as the relay's forwarding key. Sent as a bearer header.
- **Client keys** (`autter_rtc_…`, publishable): shipped in frontend
  bundles for direct browser ingest. Restricted to `/v1/browser`, enforced
  against a per-key origin allow-list, tighter rate limits, and carried as
  a `?key=` query param because `sendBeacon` cannot set headers. A leaked
  client key can at worst submit fake browser events for one repo — it can
  never read data or send OTLP.
- **Upload keys** (`autter_rtu_…`, secret, ingester 1.7.0+): CI only —
  `/v1/sourcemaps` and `/v1/sourcemaps/check`; every telemetry route answers
  `403 upload_key_not_allowed`. A leaked upload key can at worst upload source
  maps for one repo.

A key resolves to its tenant and, from ingester 1.9.0, to the repository's
suppression rules (see [Volume control](#volume-control)): the validator's
answer carries `suppression`, and a static `AUTTER_INGEST_KEYS` entry can
name its own.

## ClickHouse tables

| Table | Engine | Order by | TTL |
| --- | --- | --- | --- |
| `runtime_error_occurrences` | MergeTree (`collapsed_count` since 0021) | `(org_id, repository_id, fingerprint, occurred_at)` | 14 d |
| `runtime_spans` | MergeTree | `(org_id, repository_id, trace_id, started_at)` | 7 d |
| `runtime_logs` | ReplacingMergeTree | `(org_id, repository_id, occurred_at, event_id)` | `LOG_TTL_DAYS` (14 d) |
| `runtime_request_1m` | AggregatingMergeTree (fed by `runtime_request_1m_mv`) | `(org_id, repository_id, service, environment, route, method, bucket_at)` | 90 d |
| `runtime_metrics_1m` | SummingMergeTree | `(org_id, repository_id, service, environment, release, route, bucket_at)` | 90 d |
| `runtime_latency_histograms` | ReplacingMergeTree | `(org_id, repository_id, service, environment, bucket_at, point_id)` | 90 d (`METRICS_TTL_DAYS`) |
| `runtime_memory_samples` | ReplacingMergeTree | `(org_id, repository_id, service, environment, instance_id, metric, observed_at)` | 14 d |
| `runtime_platform_events` | ReplacingMergeTree | `(org_id, repository_id, event_id)` | 30 d |
| `runtime_llm_calls` | MergeTree | `(org_id, repository_id, started_at)` | 90 d |
| `runtime_profile_samples` | MergeTree | `(org_id, repository_id, service, environment, release, observed_at, profile_id)` | 7 d |
| `runtime_source_maps` | ReplacingMergeTree (`debug_id`, `content_hash` since 0016) | `(org_id, repository_id, release, filename)` | 30 d |
| `runtime_sdk_versions` | ReplacingMergeTree(`last_seen`) (`via` since 0019) | `(org_id, repository_id, service, environment, sdk_name, sdk_version)` | 90 d (`METRICS_TTL_DAYS`) |
| `runtime_ingest_drops` | SummingMergeTree(`requests`, `records`) (0018) | `(org_id, repository_id, minute, route, reason, kind, status, key_hash)` | 30 d |

Profile uploads are server key authenticated, limited to 1 MiB, and decoded
from symbolized pprof into at most 1,000 stack samples. Source map uploads
strip `sourcesContent` and are used only to resolve browser stack positions:
by debug id first, then by release + path. See [continuous detection](CONTINUOUS-DETECTION.md)
and [readable stack traces](SOURCE-MAPS.md).

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
`runtime_error_occurrences`, counted in `runtime_metrics_1m` (`error_count`
only: a log record names no request the rollups count) and forwarded to
the sink.

**Requests counted from their summary.** An edge function has no spans and
no `http.server.duration` histogram, so its request summary is the only
record of the request. `@autter/runtime-edge` (after 1.2.0) marks every
record of a request `autter.request.counted_by = "summary"` (unless
`countRequests: false`), and `/v1/logs` (`logRollups`, log-promotion.ts)
counts a marked `kind = request` summary in `runtime_metrics_1m`:
`request_count` 1, its duration, and `error_count` 1 when it failed —
outcome `failed`, status ≥ 500, or `autter.request.error_reported` (an
error the SDK reported in the request, as an error occurrence recorded in a
request fails it on the trace path). A promoted error record carrying the
mark adds no `error_count`: its request's summary counts that failure once.
The decision is per record, so a request whose records an exporter splits
over two batches is counted once. Nothing else sets the mark: Node and
Next.js summaries are counted by the histogram or spans and never by their
summaries, and unmarked summaries and promoted records count exactly as
before. Like the request rollup above, an exporter retry after a lost 2xx
counts twice. A record is skipped when its trace id already produced an
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
| `frames` | structured frames as JSON, innermost first, ≤ 50 (`''` when the stack had none); browser JS frames resolved through source maps (migration 0016) | stack view, RCA without re-symbolicating |
| `fingerprints` (Array) | every identity candidate, highest precedence first: `manual-v1`, `code-v1`, `frames-v3`, `message-v1` (migration 0016) | find an issue's rows whatever scheme keys it: `(fingerprint = X OR has(fingerprints, X))` |
| `in_app_frames_resolved` / `in_app_frames_unresolved` (UInt16) | browser only, after symbolication: in-app frames a source map resolved, and in-app `.js`/`.mjs`/`.cjs` frames it left as parsed (no map, no release or debug id, no mapping there); `0`/`0` for server occurrences and rows before migration 0020 | the share of unresolved frames per release or issue (over 30%: upload source maps) |

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

## Rejections and drops

The ingester counts everything it refuses or does not store, per tenant,
per minute, by route and reason, in `runtime_ingest_drops` (ingester 1.8.0,
migration `0018-runtime-ingest-drops`, compat feature `ingest_drop_counts`),
so a repository's missing telemetry has a reason. Columns: `org_id`,
`repository_id`, `minute`, `route`, `reason`, `kind`, `status` (the HTTP
status answered), `key_hash`, `requests`, `records`. It is a
SummingMergeTree: read it with `sum(requests)`, `sum(records)` and
`GROUP BY`.

`kind` says what was lost:

- `rejected`: the request got a non-2xx answer and nothing from it was
  stored. OTLP exporters retry 429 and 503, so those records usually arrive
  later; 400, 401, 403, 404, 413 and 415 are not retried.
- `dropped`: the request was accepted, but these records were not stored.
  OTLP answers name them in `partial_success` (below).
- `truncated`: the records were stored with attribute values cut or left
  out by the attribute bounds (strings past 2,048 characters, or 32,000 for
  stack keys; lists past 64 items; maps past 128 keys; nesting past 6
  levels; the 512-value budget). `records` counts the values cut. It is
  approximate: an error span's attributes are bounded once for its span row
  and again for its occurrence. Redaction and query-string stripping are
  not truncation.
- `unforwarded`: stored in ClickHouse, but the sink webhook gave up on the
  batch (route `sink`, `records` = occurrences, `requests` = batches). The
  consumer recovers it by replaying ClickHouse (see the sink below).
- `collapsed` (1.9.0): occurrences of a looping error folded into the
  minute's sample; their count is on the sample (`collapsed_count`), their
  payloads were not stored. `records` = payloads not stored.
- `suppressed` (1.9.0): occurrences a suppression rule set by the user
  dropped or sampled out. Not stored, not forwarded, not counted in issues.

`collapsed` and `suppressed` rows have `requests` = 0: no request was
refused (a dashboard older than 1.9.0 that reads an unknown kind as a
rejection finds nothing refused in the last hour).

| Reason | Kind | Status | When |
| --- | --- | --- | --- |
| `missing_key` | rejected | 401 | no key in `Authorization`, `x-autter-key` or `?key=` |
| `unknown_key` | rejected | 401 | not a configured key, and the validator did not accept it (revoked, mistyped, another deployment's) |
| `key_unverified` | rejected | 401 | the key validator could not answer (unreachable, timed out, 5xx) and no earlier answer was cached |
| `upload_key_not_allowed` | rejected | 403 | an upload key (`autter_rtu_…`) on a telemetry route |
| `client_key_not_allowed` | rejected | 403 | a client key (`autter_rtc_…`) on an OTLP or source map route |
| `origin_not_allowed` | rejected | 403 | a client key from an origin missing from its allow-list |
| `key_scope_not_allowed` | rejected | 403 | a key scope this ingester does not know (never yielded today) |
| `rate_limited` | rejected | 429 | past the key's requests a minute |
| `invalid_payload` | rejected | 400 | malformed JSON or protobuf, an invalid browser envelope, platform event, profile or source map, or values the normaliser can't read (a timestamp that is not an integer) |
| `request_aborted` | rejected | 400 | the client went away before its body arrived |
| `payload_too_large` | rejected | 413 | body over `MAX_BODY_BYTES` after gzip is inflated, or a source map over 32 MiB |
| `unsupported_media_type` | rejected | 415 | an OTLP body that is neither `application/json` nor `application/x-protobuf`, a profile that is not `application/x-pprof`, or a `zstd`/`br` content encoding |
| `unknown_route` | rejected | 404 | a POST to a path the ingester does not serve (route `other`), e.g. a collector endpoint ending in `/v1/traces` |
| `internal_error` | rejected | 500 | an unexpected error |
| `storage_unavailable` | rejected | 503 | a ClickHouse write failed |
| `spans_over_limit` | dropped | 200 | spans past 5,000 in one request |
| `log_records_over_limit` | dropped | 200 | log records past 2,000 in one request (1.8.0; before, a 400 for the whole request) |
| `cumulative_histogram` | dropped | 200 | data points of cumulative `http.server.duration` / `http.server.request.duration` histograms: only delta is summable, so request counts come from server spans instead |
| `memory_point_invalid` | dropped | 200 | memory/GC points with a value, timestamp or byte unit out of range, or on a resource without `service.name` and `service.instance.id` |
| `memory_points_over_limit` | dropped | 200 | memory/GC points past 5,000 in one request |
| `invalid_event` | dropped | 202 | browser events that failed validation (an unknown type, a bad timestamp, an oversized field) |
| `events_over_limit` | dropped | 202 | browser events past 50 in one payload |
| `profile_samples_over_limit` | dropped | 202 | profile samples past the first 1,000 |
| `attributes_truncated` | truncated | 200/202 | see above |
| `sink_overflow` | unforwarded | 0 | the sink retry buffer overflowed, or one batch was bigger than all of it |
| `sink_rejected` | unforwarded | 0 | the sink consumer answered a permanent 4xx |
| `sink_gave_up` | unforwarded | 0 | `SINK_MAX_ATTEMPTS` deliveries failed |
| `collapsed` | collapsed | 200/202 | a looping error past `LOOP_COLLAPSE_AFTER` occurrences in its minute (counted on the sample when the minute's sample is stored) |
| `suppressed` | suppressed | 200/202 | a suppression rule's `drop`, or a `sample` rule's sampled-out share |

`route` is the ingest route (`/v1/traces`, `/v1/logs`, `/v1/metrics`,
`/v1/browser`, `/v1/profiles`, `/v1/platform-events`, `/v1/sourcemaps`,
`/v1/sourcemaps/check`), `other` for unknown paths, `sink` for the webhook.
`records` is spans, log records, data points or browser events on those
routes; profile samples on `/v1/profiles` (0 for a refused profile, which
was never decoded); 1 per source map upload or platform event; 0 for a
source map check. For a refused request it is what the body held, where
that can be known: the parsed JSON is walked, a protobuf body is counted
from its wire format without being decoded, and a body that was never read
(413, a bad encoding) or not understood counts 0.

**The null tenant.** A key that does not resolve (401) has no tenant. Those
requests are counted with `org_id = ''` and `repository_id = ''` rather than
skipped: they are the commonest silent failure (a rotated key still
deployed, a validator outage), and skipping them would leave nothing to
show. When the key has an Autter prefix (`autter_rt_`, `autter_rtc_`,
`autter_rtu_`), `key_hash` is its sha256 in hex, the same hash Autter keeps
for every key it issues, revoked ones included, so the platform can tell a
repository that one of its keys is still sending after it was revoked while
the ingester never learns whose key it was. Any other token is never hashed
or stored. Without ClickHouse (the `storage not configured` 503) nothing is
counted: there is nowhere to count it.

**Never at ingest's expense.** Counting is a synchronous in-memory update.
Rows are written in one batch every 5 s; a failed or stalled (30 s) write is
logged (once a minute at most) and its rows dropped, never retried. The
buffer holds at most 10,000 rows and 1,000 distinct key hashes between
writes; past that a new row is not counted (logged at the next write) and a
new key hash is counted without one. Shutdown writes what is buffered.

Not counted, because nothing is lost: metrics the ingester has no use for
(anything but the HTTP server duration histograms and the memory/GC
instruments) are ignored; recordings of one error merged by the trace
dedupe, status-only occurrences it drops, and log records not promoted
because their trace already produced an occurrence are deduplication. The
browser SDK's own 200-events-per-session cap is applied in the browser and
never reaches the ingester.

**OTLP partial success.** When an accepted OTLP request had records
dropped, the answer carries `partial_success` per the OTLP spec, so the
OpenTelemetry Collector (and SDKs that read it) log the loss and why:

```json
{ "partialSuccess": { "rejectedSpans": "3", "errorMessage": "3 spans rejected: one request takes at most 5000 spans; send smaller batches (OTel Collector: batch processor send_batch_max_size)." } }
```

`rejectedLogRecords` and `rejectedDataPoints` for logs and metrics (int64 as
a decimal string, the proto3 JSON form). Protobuf requests get the
`Export*ServiceResponse` message with `partial_success` set; when nothing
was dropped they still get an empty body, and JSON requests
`{"partialSuccess":{}}`. Spans past the limit, log records past the limit,
cumulative HTTP histogram points and invalid or excess memory points are
reported this way; truncation is not (the records were accepted). Browser
answers report dropped events as `{"accepted": n, "rejected": m, "issues":
[…]}`, with the first validation issues and their event index.

**Reading it** (the Autter platform's Runtime coverage panel):

```sql
-- What this repository lost in 24 h, by route and reason
SELECT route, reason, any(kind) AS kind, any(status) AS status,
       sum(requests) AS requests, sum(records) AS records, max(minute) AS last_at
FROM runtime_ingest_drops
WHERE org_id = {org:String} AND repository_id = {repo:String}
  AND minute >= now() - INTERVAL 24 HOUR
GROUP BY route, reason ORDER BY records DESC, requests DESC

-- Its revoked or unknown keys still sending (hashes from the key store)
SELECT key_hash, reason, sum(requests) AS requests, sum(records) AS records, max(minute) AS last_at
FROM runtime_ingest_drops
WHERE org_id = '' AND repository_id = '' AND key_hash IN {hashes:Array(String)}
  AND minute >= now() - INTERVAL 24 HOUR
GROUP BY key_hash, reason
```

## Volume control

Two ways the ingester keeps volume down without losing what an error
count means (1.9.0, EI-38). Both run after fingerprinting and before
anything is stored; the request and error-rate rollups (`runtime_metrics_1m`)
are computed before them and still count every error.

### Loop collapse

An error that repeats in a loop is stored as its first occurrences of the
minute plus one sample with an exact count. Compat feature `loop_collapse`,
migration `0021-occurrence-collapsed-count`.

- **Identical** means the same tenant, ingest route and arrival minute, and
  the same: legacy `fingerprint` and every `fingerprints` candidate;
  service, environment, release, source, severity and `expected`; error
  type and declared code; normalised message (`message_normalized`) and
  normalised top frames (`top_frames`); and session id (an error hitting
  many sessions is volume, not a loop, and each session must still count
  as a user). Trace, request and occurrence ids, route, timestamps,
  attributes and breadcrumbs may differ.
- The first `LOOP_COLLAPSE_AFTER` (default 10; `0` turns collapse off)
  occurrences of each window are stored and forwarded as they arrive. Every
  later one is folded: counted, not stored.
- When the minute is over (checked every 5 s), the window's newest folded
  occurrence is stored and forwarded as the sample with `collapsed_count` =
  folded − 1, so stored rows + Σ `collapsed_count` is exactly the number of
  occurrences accepted. A loop of 10,000 a minute is 11 rows and one sink
  record of `count: 9990`. The folded payloads are counted as `collapsed`
  drops.
- **Exact under retries.** A request's folds count only once its ClickHouse
  writes succeed; a request answered 503 gives them back, so the exporter's
  retry is planned the same. Ids already seen in the window are recognised,
  so a batch retried after a lost 2xx is not counted twice. A window is
  stored once no request still holds it (or four minutes after its minute,
  as a safety net; a fold committed after that is carried into the next
  write). A failed write of the samples is kept and retried every 5 s.
- **Shutdown stores every window** (SIGTERM), the minute in progress too, so
  a deploy loses nothing; the sink is already stopped by then, so the
  consumer picks those samples up from ClickHouse. Only a crash loses the
  folded counts of the minute in progress (the first occurrences of the
  minute are already stored).
- **Bounded memory** (safety, not a work cap): windows live for their
  minute; past 100,000 windows a minute or 5,000 held samples, occurrences of
  new identities pass through uncollapsed (stored as before, never lost),
  and past 500,000 folded ids a minute retry recognition stops for new
  folds. `/healthz` shows `collapse` counters (`windows`, `heldSamples`,
  `folded`, `samplesFlushed`, `overflow`, `failedFlushes`).
- Windows are per ingester process: N replicas behind a load balancer store
  up to N samples (and N × `LOOP_COLLAPSE_AFTER` occurrences) a minute per
  identity; the count stays exact.

Reading an exact count from ClickHouse: per distinct `occurrence_id` (an
exporter retry can store a row twice), `1 + collapsed_count`:

```sql
SELECT sum(1 + c) AS events
FROM (SELECT occurrence_id, max(collapsed_count) AS c
      FROM runtime_error_occurrences
      WHERE org_id = {org:String} AND repository_id = {repo:String} AND fingerprint = {fp:String}
      GROUP BY occurrence_id)
```

### Suppression rules

Rules set by the user per repository in Autter (or on a static key) drop or
sample matching occurrences at ingest. Compat feature `ingest_suppression`.

```json
[
  { "id": "rsr_1", "action": "drop",
    "filters": [{ "key": "errorType", "op": "equals", "value": "AbortError" }] },
  { "id": "rsr_2", "action": "sample", "sampleRate": 0.1,
    "filters": [{ "key": "message", "op": "matches", "value": "ResizeObserver loop*" },
                { "key": "source", "op": "equals", "value": "browser" }] }
]
```

- Filter keys: `errorType`, `message`, `service`, `environment`, `route`,
  `release`, `source` (`browser` or `server`); a missing route or release is
  the empty string. Operators, all case-insensitive: `equals`, `contains`,
  `starts_with`, `matches` (a glob over the whole value, `*` = any run of
  characters, matched segment by segment in linear time: no user pattern can
  stall ingest). Values are at most 500 characters.
- All filters of a rule must match. Rules are tried in order and the first
  match decides: `drop` leaves the occurrence out; `sample` keeps
  `sampleRate` (0 < rate < 1) of them, chosen by occurrence id (so a retried
  batch keeps the same ones) and never samples out a `fatal` one.
- Delivery: the key validator's answer (`POST` to `AUTTER_KEY_VALIDATOR_URL`)
  carries `suppression: [...]`, cached with the key for 60 s, so a change
  applies within a minute. A static key entry takes the same array:
  `{"key": "…", "orgId": "…", "repositoryId": "…", "suppression": [ … ]}`.
  Invalid rules are left out on their own (a static key's are logged at
  startup); older ingesters ignore the field.
- Suppressed occurrences are not stored or forwarded and are counted as
  `suppressed` drops.

## Fingerprinting

Every occurrence carries the **legacy** identity in `fingerprint` /
`fingerprint_scheme` (`code-v1` or `message-v1`, unchanged byte-for-byte) and,
from 1.6.0, **every** applicable identity in `fingerprints`, highest
precedence first:

| Scheme | When | Hash |
| --- | --- | --- |
| `manual-v1` | the SDK sent a fingerprint override | `sha256("manual-v1\0" + service + "\0" + values.join("\u0001"))` |
| `code-v1` | a valid `autter.error.code` (then the list stops here — it is the legacy identity) | below |
| `frames-v3` | every uncoded error | below |
| `message-v1` | every uncoded error (legacy) | below |

The consumer picks the issue: an explicit scheme (`manual-v1`, a platform
grouping rule, `code-v1`) wins outright; among the auto schemes the first one
that already has an issue wins, else a new issue is keyed by the highest one.
Existing `message-v1` issues therefore never regroup, and new bugs group by
`frames-v3`.

**`frames-v3`** — structural, over the parsed (and, in the browser,
symbolicated) frames, innermost first:

1. Take the in-app frames in order (none → only the first frame), at most 5.
2. Token per frame: `fn + "@" + file`. `fn` drops a leading `async `/`new `,
   one leading `Object.`/`Module.`, maps `<anonymous>`/`anonymous` to `""`,
   and drops unresolved names of ≤ 2 characters (minifier output). `file` is
   the lowercased basename of the path (query/hash stripped) with every run
   of 8+ alphanumerics that contains a digit or is all uppercase replaced by
   `*` — `index-5f3a9c1e.js` → `index-*.js`.
3. The normalised message is hashed only when no frame was picked.
4. `sha256(["frames-v3", service, errorType, tokens.join("\u0001"), message].join("\0"))[:32]`.

Line and column numbers, route, source (browser vs server) and release are
never part of it: one bug stays one issue across deploys, chunk hashes,
preview domains, pages and tiers. Shared vectors:
`packages/otlp-ingester/src/fingerprint-v3-vectors.json` (and
`stack-parse-vectors.json` for the parser).

**In-app frames.** Not in-app: paths containing `node_modules/`,
`/site-packages/`, `/dist-packages/`, `/vendor/` or `/.pnpm/`; `node:` and
`internal/` paths; browser extension URLs; sources a source map lists in
`ignoreList`/`x_google_ignoreList`; Go `runtime.` and `/usr/local/go/` frames;
Python standard library frames (`<frozen …>` modules, an installation's
`lib/pythonX.Y/` or `PythonXY\Lib\` directory); JVM
`java.`/`javax.`/`kotlin.`/`jdk.` frames; .NET `System.`/`Microsoft.`
frames. Everything else is in-app.

**Python tracebacks** list the outermost frame first and are reversed. Only
the reported exception's own frames are parsed: the last top-level block of a
chained exception ("During handling of the above exception…", "The above
exception was the direct cause…"), and for an exception group (3.11+) the
group's own `|`-margined block, never its sub-exceptions.

**Symbolication at ingest.** Browser frames in `.js`/`.mjs`/`.cjs` files are
resolved through the map uploaded for the event's release and the script's
path (or its debug id) before fingerprinting. When the map carries function
scopes (`x_autter_scopes`, written by `autter-runtime sourcemaps upload`), a
frame is named after the innermost function containing it, with that
function's original name (`null` when anonymous or in top-level code).
Without scopes, names come from the map's `names` (the name mapped at the
caller's position); a resolved frame without one keeps its parsed name unless
that is an obviously mangled one. See `docs/SOURCE-MAPS.md`.
Parsed maps (compactly decoded mappings and scope tables) are cached per
(org, repository, release, file) in an LRU bounded by `SOURCE_MAP_CACHE_MB`;
a map that would take more than half of it is used without being kept;
misses are remembered for 5 minutes. A failed lookup or a bad map leaves the frames as
parsed — it never fails ingest.

The two legacy schemes; `fingerprint_scheme` records which one produced a row.

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

**Fingerprint override (`manual-v1`, ingester 1.6.0+)** — an SDK can decide
the grouping itself: `captureException(err, { fingerprint })` in every SDK
(browser: the event's `fingerprint` field, also settable in `beforeSend`;
server and edge: the exception event or promoted-log attribute
`autter.fingerprint`, a JSON array of strings). The normalisers carry it as
`fingerprintOverride` — strings only, at most 10, each scrubbed and cut to
200 chars — and `manualFingerprint()` (`fingerprint-override.ts`) hashes it:

```
sha256("manual-v1" + "\0" + service + "\0" + values.join("\u0001")).hex()[:32]
```

It takes precedence over every automatic scheme. Test vector: `web` +
`["chunk-load"]` → `26c6c2e4050d368f56e84b0353dfc5a3`. Grouping rules set on
the Autter platform (`rule-v1`) rank just below it.

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
- One occurrence per thrown error (`trace-dedupe.ts`, per export batch).
  Two `exception` events are one error, merged, when they share trace,
  service, environment and release; sit on different spans, one an ancestor
  of the other in the batch; have the same type (or one is OTel JS's
  `recordException` reporting `error.code` as the type); the same normalised
  message; in-app frames that are equal or a prefix/suffix of each other;
  and are recorded within 5 s. Two events on one span, or on sibling spans,
  stay separate (a retry loop recording each attempt). The merged occurrence
  is the Autter SDK's recording (else the one with runtime-next's
  `onRequestError` context, else the one nearest the root), keeps its id,
  and takes what it lacks from the others (`autter.merged_recordings`
  counts them). A status-only `HttpServerError` / `SpanError` is dropped
  when an unhandled error-severity exception or failed outcome of the same
  service sits on an ancestor or descendant span in the batch. Spans of one
  trace exported in different batches are not compared.
- At most 5,000 spans per request; the rest are dropped, answered in
  `partial_success` and counted (`spans_over_limit`, see
  [Rejections and drops](#rejections-and-drops)).
- `route` from `http.route`, falling back to `url.path` / `http.target`
  (query-stripped).
- `status_code` from `http.response.status_code` / `http.status_code`.
- Usage rollups (`runtime_metrics_1m`, 1-minute buckets). **`request_count`
  counts requests and only requests**: server requests from the span-fed
  and metric-fed feeds below and from edge request summaries marked
  `autter.request.counted_by = "summary"` (see Requests counted from their
  summary), plus the browser's synthetic usage counters
  (`event:<name>` track events, `browser.longtask` and
  `browser.resource:*` timings), which keep their own routes. **`error_count`
  counts failed requests** (a 5xx or errored server span, or an error/fatal
  occurrence recorded in the request: once per request however many) **and
  errors outside any request** (workers, jobs, consumers, browser-only,
  logger-only log promotion, edge errors outside a counted request, a
  `captureException` span exported apart from its request): one per
  error/fatal occurrence. An error never
  adds to `request_count`; warnings and info messages add nothing.
  `duration_sum_ms` sums request latencies, so `duration_sum_ms /
  request_count` is the mean latency. `error_count / request_count` is a
  failed-request rate for a service whose errors all happen in requests;
  errors outside requests can push it past 1 (a worker has errors and no
  requests).
- Rollup rows key on the **normalized** route (id-like path segments →
  `:id`), so span-fed and metric-fed rows for the same endpoint sum
  together and the SummingMergeTree key space stays bounded;
  `runtime_metrics_1m` route values are templates, never raw paths.
  (Metric-fed rollups get their route from `http.route` on
  `http.server.duration` / `http.server.request.duration` data points —
  OTel never puts raw URL paths on metrics, so the SDK must set the route
  template; `@autter/runtime-node` does this for Express, and from 1.7.0
  for Next.js from the `next.route` template Next puts on its own spans.)
- One request is its **outermost** server span (`request-spans.ts`, per
  export batch). Walking up a span's parent links in the batch, its request
  is the highest server span reached in the same process (service,
  environment, release, `service.instance.id`); the walk stops at a parent
  missing from the batch, at another process, and where a server/consumer
  span's parent is a client/producer span (a call over the wire, even from
  a service to itself). A server span nested in another — Next.js's
  `BaseServer.handleRequest` under the HTTP instrumentation's span, some
  NestJS/Fastify setups, gRPC gateways serving in-process — adds no
  request: the request takes the best route among its server spans (an
  `http.route` template over a `url.path` / `http.target` raw path; on a
  tie the outermost span's), the outermost span's latency and minute, and
  fails when any of its server spans does. A server span whose parent is
  not in the batch counts as a request, so when an exporter splits one
  request's spans across batches, each batch counts it once.
- Which feed counts a request. Its spans count it (`request_count` 1, its
  latency, `error_count` 1 if it failed) unless the sender's metric feed
  does, which is when its outermost server span
  - carries `autter.metric_has_route` on a resource with both
    `autter.metrics_wired` and `autter.metrics_routes`
    (`@autter/runtime-node` 1.7.0+: its delta `http.server.duration`
    counts every request, and it marks each request span whose data point
    got the route), or
  - carries `autter.tail_retained` on a resource with
    `autter.metrics_wired` (runtime-node's error-linked tail retention
    ships such spans at ~100% next to its metric feed).
  `adapters/python`'s `init_tracing(count_requests=True)` sends the same
  shape: a delta histogram with a point for every request (recorded from
  every HTTP server span, sampled or not), each HTTP server span marked
  `autter.metric_has_route`, and both resource attributes.
  A request that carries `autter.tail_retained` on a resource without a
  metric feed (the Python retention in `adapters/python` without
  `count_requests`) is counted by neither: it was exported because it failed, so it is no sample of the
  traffic, and adds only its failure, `error_count` 1, on its route.
  A metric-counted request adds no request from its spans; the metric
  already counted a 5xx as a failed request, so an error recorded in it
  adds nothing more, while an error recorded in a request the metric saw
  succeed adds `error_count` 1 (once per request) on the route its data
  point carried. `autter.metrics_wired` without `autter.metrics_routes`
  (runtime-node before 1.7.0, whose Next.js metrics have no route) is not
  enough: its spans keep feeding per-route counts, so a sampled request
  is counted by both feeds, as before. So is a 1.7.0 request whose
  metric got no route (Koa, Fastify or plain `http` without a router
  instrumentation): its span keeps the path. Other OTel senders that
  export delta HTTP duration histograms can opt in the same way (both
  resource attributes, and `autter.metric_has_route=true` on each server
  span whose data point has `http.route`); otherwise their sampled server
  spans add to the metric counts.
- What a batch cannot tell: a `captureException` span (runtime-node's
  always-on exporter) arrives in a different batch from its request, so
  its error counts even when the metric feed counted that request's 5xx;
  an error-only point lands in the minute the request started, the metric
  in the minute it was exported.
- Only **delta**-temporality histograms fold into rollups: cumulative
  points repeat lifetime totals every export, which a SummingMergeTree
  would re-add each minute; cumulative senders are covered by the
  span-fed fallback instead (so they must not set the flags). A resource
  that sends both instruments (OTel's
  `OTEL_SEMCONV_STABILITY_OPT_IN=http/dup`) is counted from
  `http.server.request.duration` only, as the latency histograms are.
  From 1.8.0 cumulative points are answered as rejected in
  `partial_success` and counted (`cumulative_histogram`).
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

runtime-browser ≥1.6.0 with `@autter/runtime-browser/tracing` adds a
per-event `traceId`: the W3C trace id of the `traceparent` its request sent
(`request_failure`), or of the request that just settled (`exception`,
`unhandled_rejection`). It must be 32 lowercase hex and
not all zeros, or it is dropped on its own; it is stored as the occurrence's
`trace_id`, so a browser occurrence joins the server spans of the same trace.
Browser occurrences never count as duplicates in the `/v1/logs` promotion
dedupe (a server error on the same trace is still promoted).

Event types: `exception`, `unhandled_rejection`, `session_start`, and
`track_event` (carries a `name`; counted into `runtime_metrics_1m` as
`request_count` on the synthetic route `event:<name>` — coarse usage
counters, not an analytics event store). Error and fatal events add
`error_count` 1 on their page route and no `request_count` (a browser error
is outside any server request); warnings and info messages add nothing.

Validation (1.8.0): the envelope (`version`, `service`, `environment`, …)
must be valid or the payload gets a 400; each event is then validated on
its own, and one that fails (a type this ingester doesn't know, a bad
timestamp, an oversized field) is dropped alone and counted
(`invalid_event`), so it no longer costs the errors in the same beacon.
Events past 50 are dropped and counted (`events_over_limit`). The 202
answer adds `rejected` and the first `issues` when any were dropped. Before
1.8.0 one invalid event, or more than 50, rejected the whole payload.

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

1.6.0 adds the optional `breadcrumbs`: the steps before the error, oldest
first, at most 30, each `{ type, at, level?, message, data? }` (`type` is
`console` | `request` | `navigation` | `click` | `log` | `custom`). They come
from browser events' `breadcrumbs` or the server exception event's
`autter.breadcrumbs` attribute, are validated, bounded (500-character
messages, 10 primitive data keys, 16 KB) and scrubbed, and are stored under
`autter.breadcrumbs` in the occurrence's `attributes` JSON.

1.6.0 additions, optional and omitted when empty: `frames` (structured
frames, innermost first, ≤ 50: `function`, `module`, `filename`, `lineno`,
`colno`, `inApp`, `resolved`, and context lines only when a map carried
`sourcesContent`), `fingerprints` (`[{ scheme, fingerprint }]`, every
candidate, highest precedence first, always ending with the legacy one) and
`fingerprintRecord` (`{ scheme: "frames-v3", parts }`: what went into the
frames-v3 fingerprint). `fingerprint` and `fingerprintScheme` keep their
legacy meaning, so an older consumer groups exactly as before.

1.9.0 adds `count`: the occurrences the record stands for, sent only when
above 1, on a loop-collapse sample (`1 + collapsed_count`; see
[Loop collapse](#loop-collapse)). Consumers add `count ?? 1` to event counts
(issue counts, rate buckets) and treat the record as one sample for
everything else. A replay from ClickHouse reads it from `collapsed_count`.

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
