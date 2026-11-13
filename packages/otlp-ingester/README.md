# @autter/otlp-ingester

Self-hostable ingest service for Autter Runtime. Receives OTLP/HTTP (protobuf or JSON)
traces and metrics plus compact browser error payloads, normalises them into
one per-repo signal model, fingerprints errors, and writes ClickHouse.

## Endpoints

| Route | Payload | Purpose |
| --- | --- | --- |
| `POST /v1/traces` | OTLP/JSON `ExportTraceServiceRequest` | Error spans → occurrences; all spans → `runtime_spans`; server spans → usage rollups; GenAI spans → `runtime_llm_calls` |
| `POST /v1/logs` | OTLP `ExportLogsServiceRequest`, server key | Wide events (request/operation summaries, logs) → `runtime_logs` (+ `runtime_request_1m` rollup); logger-only error records (`autter.capture.mode=log`) → occurrences |
| `POST /v1/metrics` | OTLP `ExportMetricsServiceRequest` | HTTP-server duration histograms → usage rollups; portable process memory/GC metrics → per-instance memory samples |
| `POST /v1/platform-events` | JSON, server key | ECS/Kubernetes OOM kills and restarts → memory incident correlation |
| `POST /v1/profiles` | Symbolized pprof, server key | CPU/in-use heap profile samples |
| `POST /v1/browser` | Browser payload `version: 1` | Errors/rejections → occurrences; session pings → rollups |
| `POST /v1/logs` | OTLP logs, server key | Structured logs and operation summaries → `runtime_logs` |
| `GET /v1/compat` | — | Version, schema level and supported features (public) |
| `GET /healthz` | — | Readiness: 200 only when the ingester can write to ClickHouse (see below) |
| `GET /livez` | — | Liveness: 200 while the process serves requests, whatever storage does |
| `GET /metrics` | — | Prometheus text: readiness, write outcomes, drop counters, sink delivery |

Auth on every ingest route: `Authorization: Bearer <ingest key>`,
`x-autter-key`, or `?key=` (query param — for sendBeacon, which cannot set
headers; **client keys only**: a server or upload key in the URL gets
`401 {"error":"key_in_url"}` and should be rotated, since URLs end up in
proxy and CDN logs). The ingester masks `key` in the request URL before any
route runs, so nothing it logs carries a key. OTLP endpoints accept **both protobuf and JSON** (`content-type:
application/x-protobuf` or `application/json`), gzip/deflate bodies
included — so any OpenTelemetry SDK (Go, Rust, Python, Java, .NET, JS)
works with its default exporter settings.

### Key scopes

| Scope | Prefix convention | Valid on | Extras |
| --- | --- | --- | --- |
| `server` (default) | `autter_rt_…` (secret) | all endpoints | 300 req/min |
| `client` | `autter_rtc_…` (publishable, safe in frontend bundles) | `/v1/browser` only | origin allow-list (required: no origins = no browser origin; list `http://localhost:3000` for local dev), 120 req/min |
| `upload` (1.7.0+) | `autter_rtu_…` (secret, for CI) | `/v1/sourcemaps` and `/v1/sourcemaps/check` only | 300 req/min |

An upload key gets `403 {"error":"upload_key_not_allowed","detail":"autter_rtu_ keys can only upload source maps …"}`
on every other route, so a CI secret that leaks can upload source maps for
one repository and nothing else. A static entry without `scope` is an upload
key when its key starts with `autter_rtu_`, else a server key; an entry (or a
validator answer) with any other `scope` is ignored rather than treated as a
server key. Ingesters before 1.7.0 treat every scope but `client` as
`server`, so a validator must not answer `"scope": "upload"` to them: from
1.7.0 every validator request carries `x-autter-ingester-version`.

`/v1/browser` answers CORS preflights permissively; real enforcement (key +
origin allow-list) happens on the POST. Cross-origin browsers send
`text/plain` bodies (CORS-safelisted, no preflight per beacon) which the
route parses as JSON.

```json
AUTTER_INGEST_KEYS='[
  {"key":"autter_rt_…","orgId":"org1","repositoryId":"repo1"},
  {"key":"autter_rtc_…","orgId":"org1","repositoryId":"repo1",
   "scope":"client","allowedOrigins":["https://app.example.com"]},
  {"key":"autter_rtu_…","orgId":"org1","repositoryId":"repo1","scope":"upload"}
]'
```

The validator webhook may return the same extra fields:
`{ orgId, repositoryId, scope?, allowedOrigins?, suppression? }`, with
`scope` one of `server`, `client`, `upload`, and `suppression` the
repository's suppression rules (1.9.0, below); a static entry takes
`"suppression": [ … ]` too.

### Validator outages

Only a definite refusal from the validator — 404, 410, or a 2xx without
`orgId` and `repositoryId` (or with a scope this ingester doesn't know) —
makes a key invalid: the ingester answers 401 and remembers the refusal
for 60 s. Every other outcome (a 5xx, 429 or other 4xx such as a wrong
`AUTTER_KEY_VALIDATOR_TOKEN`, an unreadable body, a 5 s timeout, a
network error) means the validator could not answer, and is never
remembered as a refusal. A key the validator accepted in the last 15
minutes keeps working on that answer. Any other key gets
`503 Retry-After: 5`, which OTLP exporters and the Autter SDKs retry
(401 is permanent for them). The validator is asked about that key again
after 5 s, so a recovered validator is picked up on the next retry. One
warning a minute is logged while the validator can't answer.

### Volume control (1.9.0)

- **Loop collapse.** Per tenant and identity (fingerprints, service,
  environment, release, source, severity, error type and code, normalised
  message and top frames, session), the first `LOOP_COLLAPSE_AFTER`
  occurrences of a minute are stored as usual; the rest of the minute is
  stored as ONE sample whose `collapsed_count` makes the count exact, and
  forwarded to the sink with `count`. A loop of 10,000 a minute is 11 rows,
  not 10,000. Shutdown stores the minute in progress.
- **Suppression rules** set per repository in Autter: `drop` or `sample`
  (keep `sampleRate`, never a fatal one) the occurrences whose error type,
  message, service, environment, route, release or source match. Delivered
  with the key, applied before anything is stored.

Folded and suppressed occurrences are counted in `runtime_ingest_drops`
(`collapsed`, `suppressed`); request and error-rate rollups still count
every error. Details: [docs/ARCHITECTURE.md § Volume control](../../docs/ARCHITECTURE.md#volume-control).

### Rejections and drops (1.8.0)

Everything the ingester refuses (401, 403, 404, 413, 415, 429, 400, 503) or
does not store from an accepted request (spans past 5,000, log records past
2,000, cumulative HTTP histograms, invalid browser events, …) is counted per
repository, minute, route and reason in `runtime_ingest_drops`; keys that
don't resolve count against an empty tenant with the sha256 of the key when
it is an Autter key. OTLP answers name dropped records in `partial_success`
(JSON and protobuf), so collectors log them. Counts are written every 5 s in
one batch, bounded in memory, and a failed write is logged and dropped:
counting never slows or fails ingest. Reasons and queries:
[docs/ARCHITECTURE.md § Rejections and drops](../../docs/ARCHITECTURE.md#rejections-and-drops).

### Version compatibility

`GET /v1/compat` (public, no tenant data) returns this ingester's version,
its ClickHouse schema state, and which features from
`src/compat-manifest.json` it supports. Add
`?features=operation_logging&sdk=@autter/runtime-node@1.3.0` to get the evaluated
incompatibilities. Every response carries `x-autter-ingester-version`. The
ingester records the SDK name and version each service sends with, and
whether it came through an OpenTelemetry Collector (`runtime_sdk_versions`,
`via` from 1.8.0), and its own version (`runtime_ingester_info`), and the
Autter dashboard reads both. See [docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

## Configuration

| Env | Default | Description |
| --- | --- | --- |
| `PORT` | `4318` | Listen port (OTLP/HTTP convention) |
| `CLICKHOUSE_URL` | — | e.g. `http://localhost:8123`; unset = ingest returns 503 |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `default` / empty | |
| `CLICKHOUSE_DATABASE` | `autter_runtime` | Created automatically |
| `AUTTER_INGEST_KEYS` | — | JSON: `[{"key":"...","orgId":"...","repositoryId":"..."}]` (optional `scope`, `allowedOrigins`, `suppression`) |
| `AUTTER_LOCAL_DEV` | off | `1`: local development only. Also accept the built-in key `autter_rt_local_dev_only`, from loopback and private addresses only. Set by the repo's `docker-compose.yml`, never by the deploys. Refused at startup together with `AUTTER_KEY_VALIDATOR_URL`; without it, a listed `autter_rt_local_dev_only` is ignored |
| `AUTTER_KEY_VALIDATOR_URL` | — | Webhook: `POST {key}` → `{orgId, repositoryId, scope?, allowedOrigins?, suppression?}`, or 404 for an unknown or revoked key (60 s cache; see [Validator outages](#validator-outages)) |
| `AUTTER_KEY_VALIDATOR_TOKEN` | — | Bearer token sent to the validator |
| `AUTTER_SINK_URL` | — | Issue-grouping webhook; at-least-once, across restarts with an outbox (`docs/ARCHITECTURE.md`) |
| `AUTTER_SINK_TOKEN` | — | Bearer token sent to the sink |
| `SINK_OUTBOX_DIR` | `/var/lib/autter/sink-outbox` in the image; `<os tmpdir>/autter-sink-outbox-<port>` otherwise | Undelivered sink batches are written here before the ingest request is answered and re-sent after a restart; `dead/` keeps the batches given up on. One directory per ingester process; mount a volume to survive container replacement. `off` = memory only (lost on restart) |
| `SINK_OUTBOX_FSYNC` | off | `1` fsyncs every outbox write (survives a host crash, not just a process crash) |
| `SINK_OUTBOX_SHARED` | off | `1` when `SINK_OUTBOX_DIR` is a volume every task mounts (EFS on Fargate): each process uses its own subdirectory and adopts the batches of processes that closed theirs or stopped their heartbeat 2 min ago |
| `INSERT_RECEIPTS_FILE` | `<SINK_OUTBOX_DIR>/insert-receipts.log`, else `<os tmpdir>/autter-insert-receipts-<port>.log` | Journal of which tables each recent request wrote, so a retry after a restart does not insert committed rows again; `off` = memory only. With `AUTTER_REDIS_URL` the receipts are also shared by every replica |
| `SINK_MAX_AGE_HOURS` | `72` | A batch still undelivered after this long is dead-lettered |
| `SINK_MAX_ATTEMPTS` | unlimited with an outbox, `12` without | Delivery attempts per batch before it is dead-lettered (1–60 s backoff); `0` = no limit |
| `SINK_MAX_BUFFERED_BATCHES` | `1000` | Sink queue cap in memory; past it the oldest batch of the heaviest tenant is dead-lettered |
| `SINK_MAX_BUFFERED_MB` | `64` | Sink queue cap in memory (MiB) |
| `SINK_DEAD_LETTER_MAX_MB` | `256` | Disk budget for dead letters; the oldest are deleted past it (counted, logged) |
| `SOURCE_MAP_CACHE_MB` | `64` | Memory budget (decoded size, function scope tables included) for parsed source maps used to symbolicate browser, Node and edge frames at ingest; least recently used maps are evicted, and a map that needs more than half of it is used without being kept. The source contents of cached maps (context lines) are kept apart, one file per entry, under a budget of the same size, so they never change which maps are cached |
| `MAX_BODY_BYTES` | `1048576` | Request body cap |
| `LOOP_COLLAPSE_AFTER` | `10` | Identical occurrences stored per minute before the rest of the minute is collapsed into one sample with an exact count; `0` turns loop collapse off |
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests per minute per tenant (repository), server keys; upload keys get their own window of the same size. Sliding window |
| `CLIENT_RATE_LIMIT_PER_MINUTE` | `120` | Requests per minute per tenant, client keys. Sliding window |
| `RECORD_LIMIT_PER_MINUTE` | `600000` | Records (spans, log records, data points, events, profile samples) per minute per tenant, server keys. A request is let in while budget is left and charged in full |
| `CLIENT_RECORD_LIMIT_PER_MINUTE` | `6000` | The same for client keys |
| `PROMOTION_LOOKUPS_PER_MINUTE` | `30` | Per-tenant ClickHouse dedupe lookups for `/v1/logs` error promotion; over budget, records are promoted with in-batch dedupe only |
| `IP_RATE_LIMIT_PER_MINUTE` | `6000` | POST requests per minute per client address (IPv6 per /64), before the body is read or the key looked at; always per process; `0` turns it off |
| `IP_UNKNOWN_KEY_LOOKUPS_PER_MINUTE` | `30` | Validator calls per minute per client address for keys the ingester has no cached answer for; past it such keys get `429` with `Retry-After` |
| `UNKNOWN_KEY_LOOKUPS_PER_MINUTE` | `600` | The same budget for the whole ingester |
| `AUTTER_REDIS_URL` | — | Redis (≥ 6) shared by all replicas for the tenant limits, the unknown-key budgets and promotion lookups (`redis://…` or `rediss://…`). If Redis fails, checks fall back to the process's own count until it is back |
| `AUTTER_INGESTER_REPLICAS` | `1` | Replicas behind the load balancer. Without Redis each process enforces 1/N of every shared limit, and N > 1 logs a warning at startup |
| `TRUST_PROXY` | `1` | Proxy hops whose `X-Forwarded-For` is trusted for the client address (`1` behind an ALB or Caddy; `0` when exposed directly) |
| `OCCURRENCE_TTL_DAYS` / `SPAN_TTL_DAYS` / `METRICS_TTL_DAYS` | `14` / `7` / `90` | ClickHouse TTLs (applied at table creation) |
| `LLM_CALL_TTL_DAYS` | `90` | Retention for `runtime_llm_calls` rows |
| `AUTTER_LLM_PRICES_FILE` | unset | JSON file of LLM prices merged over the built-in table (see [LLM / GenAI calls](#llm--genai-calls)). Read and validated at startup: an invalid file stops the ingester with every bad field named |
| `LOG_TTL_DAYS` | `14` | Retention for `runtime_logs` (request summaries are always kept, never sampled, so this is the main volume knob). New tables get it. When it is **set**, it is also applied to an existing table at boot: a longer TTL at once, a shorter one only when the table has no rows older than it (otherwise the boot log gives the `ALTER TABLE … MODIFY TTL` to run). Unset, an existing table's TTL is left as it is. Only the delete rule is changed (move and recompress rules are kept), with `materialize_ttl_after_modify = 0`; a failure is logged and retried next boot |
| `ARCHIVE_S3_URL` / `ARCHIVE_S3_NAMED_COLLECTION` | unset (off) | Tiered retention ([docs/RETENTION.md](../../docs/RETENTION.md)): days older than the hot window (the TTLs above) of occurrences, spans, logs and LLM calls are written to Parquet in this bucket (S3, GCS's S3 endpoint, MinIO, R2) before they leave ClickHouse; the archive job drops each day after reading its objects back, and the delete TTL becomes a backstop a week past the hot window, set only once every older day is archived. Unset: the TTLs delete as before |
| `ARCHIVE_S3_ACCESS_KEY_ID` / `ARCHIVE_S3_SECRET_ACCESS_KEY` | unset | Keys ClickHouse uses for the bucket (HMAC keys for GCS); not needed with a named collection or ClickHouse's own credentials |
| `ARCHIVE_RETENTION_DAYS` | `365` | Event age (30–3650) kept in the archive; match the bucket's lifecycle rule |
| `ARCHIVE_TABLES` / `ARCHIVE_BACKSTOP_DAYS` / `ARCHIVE_INTERVAL_MINUTES` / `ARCHIVE_MAX_DAYS_PER_PASS` / `ARCHIVE_SCHEDULER` | all four / `auto` (hot window + 7 days; `0` = none) / `60` / `4` / `auto` | Which tables, the disk-guard TTL, how often and how much per pass, and which process runs the job (`auto`: Redis lease holder or the only replica) |
| `AUTTER_REDACT_VALUE_PATTERNS` | — | JSON array of extra regex sources masked in stored/forwarded text and attribute values (built-in secret/PII patterns always apply) |
| `AUTTER_REDACT_KEY_PATTERNS` | — | JSON array of extra regex sources for attribute keys whose values are masked wholesale |

## Rate limits and key lookups (1.12.0)

In the order a request meets them:

1. **Per address.** `IP_RATE_LIMIT_PER_MINUTE` POSTs per client address
   (from `X-Forwarded-For` through `TRUST_PROXY` hops; IPv6 grouped by
   /64), before the body is read. Always counted in the process.
2. **Route and body.** Unknown routes (404), bodies that don't parse (400,
   413) and content types a route doesn't take (415) are refused before the
   key is resolved. They are attributed from the key caches only, never by
   asking the validator. Protobuf is decoded, and source maps are read, only
   after the key is checked.
3. **Key lookup.** Accepted and refused keys are cached apart (10,000 and
   50,000 entries, least recently used evicted, 60 s), so junk keys can't
   evict a working one. Concurrent requests for one key share one validator
   call. A key in neither cache spends the unknown-key budget (per address,
   then overall) before the validator is asked; past it the request gets
   `429` with `Retry-After`, never a `401`. Keys over 512 characters or with
   spaces or control characters are refused without a call.
4. **Per tenant.** Requests and records per minute, sliding windows, per
   repository and key type (server, client, upload).

Limits are shared across replicas through `AUTTER_REDIS_URL`. Without it,
set `AUTTER_INGESTER_REPLICAS` so each process enforces its share. Loop
collapse windows stay per process (see `docs/ARCHITECTURE.md`).

## Health, readiness and drops (1.12)

`GET /healthz` is a readiness check. It answers 200 only when the ingester
can store what it is sent: a probe makes sure the schema exists and inserts
one row into `runtime_ingester_heartbeat` with the configured credentials
(cached for 5 s, shared by concurrent callers), and a failed ingest write in
the last minute also makes it unready. Before 1.12 it answered ClickHouse's
unauthenticated `/ping`, so a wrong password or a dropped table showed "up"
while every ingest request got 503.

```json
{"ok":false,"status":"unready","clickhouse":"auth_failed","retryable":false,
 "checkedAt":"…","probeLatencyMs":12,
 "writes":{"lastOkAt":null,"lastErrorAt":"…","lastError":"auth","consecutiveFailures":3,"lagSeconds":0,…},
 "drops":{"requests":42,"records":97,"byReason":[{"route":"traces","reason":"storage_unavailable","kind":"rejected","requests":3,"records":12}],…},
 "sink":{"queued":0,"durable":true,"deadLettered":0,"oldestQueuedAgeSeconds":0,…}}
```

`clickhouse` is `up`, `down` (unreachable, timed out or failing: retry,
`Retry-After: 5`), `auth_failed` (credentials or grants: fix the deployment),
`schema_missing` (a table or the database is gone and could not be
recreated) or `unconfigured` (no `CLICKHOUSE_URL`: every ingest request gets
503, so this is 503 too). A table dropped under a running ingester is
recreated on the next write. An ingest request with nothing to store (an
empty export) gets 503 too while storage is not writable, instead of a 2xx.

With an archive configured, `archive` reports the archive job as ClickHouse
records it (`runtime_archive_passes`), whichever process runs it:
`{"configured":true,"runsJob":false,"lastPassAt":"…","lastSuccessfulPassAt":"…","passOverdue":false,"passWarnHours":3,"checkedAt":"…"}`.
`passOverdue` is true when no pass has finished without errors for three
intervals (at least 3 hours) since the last one or since the archive was
configured; every process then also logs `runtime archive: an archive is
configured but no archive pass has finished …` hourly. It never makes
`/healthz` unready.

`clickhouseVersion` is the server's `version()`. `insertReceipts.mode` says
where the receipts that stop a retried request from writing its rows twice
are kept (`memory`, `file`, `redis`, `redis+file`).

`writes.lagSeconds` is how long writes have been failing since the last one
that succeeded. `drops` are the process-lifetime counts by route and reason
(the per-minute rows in `runtime_ingest_drops` cannot be written while
ClickHouse is down; these can always be read). `/metrics` has the same
numbers for Prometheus. Use `/healthz` for load balancers and compose
`depends_on`, and `/livez` for restart policies, so a storage outage does not
restart the ingester in a loop.

The tables live in the `CLICKHOUSE_DATABASE` database (`autter_runtime`),
not `default`: `SHOW TABLES FROM autter_runtime`.

## Coded errors and request summaries (1.5.0)

- **Code-based grouping.** An occurrence carrying a valid `autter.error.code`
  (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$`, ≤80 chars) is fingerprinted by
  scheme `code-v1`: `sha256("code-v1\0" + service + "\0" + code)[:32]` —
  independent of source, message, stack and route, so one code is one issue
  across traces, log promotion, the browser and external connectors.
  Uncoded errors keep the historical fingerprint (`message-v1`) byte-for-byte.
  `fingerprint_scheme` is stored per occurrence and sent to the sink.
- **Declared fields.** `autter.error.why|fix|link|expected` and
  `autter.request.id` are lifted from span/exception-event attributes, log
  attributes and browser context into `runtime_error_occurrences`
  (`error_why`, `error_fix`, `error_link`, `expected`, `request_id`) and the
  sink payload. why/fix are scrubbed and capped at 1000 chars; links must be
  http(s) and ≤500 chars. Exception spans inherit the request id of their
  server span.
- **Request summaries.** `/v1/logs` lifts `autter.operation.kind`,
  `autter.request.id`, `http.route` (id-normalised), `http.response.status_code`,
  `autter.error.code` and the `autter.operation.ai` rollup (`cost_usd`, `calls`)
  into `runtime_logs` columns. `kind = 'request'` rows feed the
  `runtime_request_1m` materialized view (per route/method/minute: count,
  failed, duration sum, p50/p95). The view counts every insert, so a retried
  batch can be counted twice — route stats are approximate under exporter
  retries; `runtime_logs` itself collapses duplicates.
- **Edge latency histograms.** Request summaries marked
  `autter.request.counted_by = "summary"` (`@autter/runtime-edge`, which
  sends no histograms) feed `runtime_latency_histograms` for endpoint
  regression detection. runtime-edge exports per request, so summaries are
  added in memory to one point per service, environment, release, method,
  route and minute across batches, written about 15 s after the minute ends
  and at shutdown; a retried batch adds nothing twice (insert receipts). A
  summary without its own timestamp, outside [now − 2 h, now + 5 min], or
  with a missing, negative, non-numeric or over-15-minute duration is left
  out (drop reason `latency_summary_invalid`); past 200 routes per service
  and environment in 10 minutes, `latency_routes_over_limit`. A route that
  also sends Node histograms gets no edge points. `x-autter-ingest` on
  `/v1/logs` reports `latency_summaries=` (summaries added). A crash loses
  the open minutes' edge points.
- **Tail-retained spans.** Spans marked `autter.tail_retained` or
  `autter.retention_reason` `error` / `slow` (kept because their trace failed
  or was slow, not a random sample) never count as requests in the span-fed
  usage rollups.
- **Log promotion.** SDKs without a trace pipeline (logger-only mode,
  `@autter/runtime-edge`) send errors as log records with `exception.*` and
  `autter.capture.mode = "log"`. `/v1/logs` promotes those (severity ≥ error)
  to server occurrences — stored, counted and forwarded to the sink —
  skipping a record when its trace id already produced an occurrence in the
  same batch or (ClickHouse lookup) within ±60 s. If the lookup fails the
  record is promoted anyway.

## LLM / GenAI calls

Spans following the [OTel GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
(`gen_ai.*` attributes — emitted by `withLlmCall` in `@autter/runtime-node`,
the Vercel AI SDK with telemetry enabled, and the GenAI instrumentations for
Python/Go/etc.) and OpenInference `LLM` / `EMBEDDING` spans
(`llm.model_name`, `llm.token_count.*`) are recognised automatically on
`/v1/traces` and additionally stored per call in `runtime_llm_calls`:
provider, model, operation, input/output tokens, prompt-cache reads and
writes, reasoning tokens, duration, ok/error status (with the provider
exception type in `error_type` for failed calls), and a USD cost. An opaque
calling-user id is read from `autter.user_id` (or the AI SDK's
`metadata.userId`). The Vercel AI SDK's outer `ai.generateText`/`ai.streamText`
spans, in-process `invoke_agent` spans, and OpenInference agent/chain/tool
spans are not counted — their model-call children carry the usage, and
counting both would double the tokens.

**Cost.** A cost the span reports wins (`autter.llm.cost_usd` →
`gen_ai.usage.cost` → `ai.usage.cost` → `llm.cost.total`; `cost_source =
'reported'`). Otherwise it is estimated, cache-aware, from the built-in price
table in `src/llm-prices.ts` (`cost_source = 'estimated'`, and
`pricing_version` records the table's as-of day):

```
uncached = max(0, input − cache_read − cache_write)
cost     = uncached × input rate + cache_read × cache-read rate
         + (cache_write − long) × cache-write rate + long × long-TTL write rate
         + output × output rate
```

A model the table does not list is left unpriced (`cost_source = 'none'`,
cost 0); it is never priced like a sibling. Entries match on a version
boundary (`gpt-5` prices `gpt-5-2025-08-07`, not `gpt-5.5` or `gpt-5-pro`).
The token contract, the table's sources and what it leaves out are in
[docs/LLM-INSTRUMENTATION.md](../../docs/LLM-INSTRUMENTATION.md#prompt-caching-and-cost).

**Price override file.** `AUTTER_LLM_PRICES_FILE` points at a JSON file
merged over the built-in table, for negotiated rates, fine-tuned or
self-hosted models, or a price change before the next release:

```json
{
  "asOf": "2026-12-01",
  "models": [
    { "match": "gpt-5.6-sol", "inputPerMTok": 5, "outputPerMTok": 25,
      "cacheReadPerMTok": 0.5, "cacheWritePerMTok": 6.25, "cacheWriteLongPerMTok": 12.5 },
    { "match": "acme-support-ft", "inputPerMTok": 1.2, "outputPerMTok": 4.8 }
  ]
}
```

An entry replaces every built-in entry with the same `match` (its dated
ones too) and adds models the table lacks; `match` is lowercased and
router/Bedrock prefixes are stripped as for incoming model ids. Rates are
USD per 1M tokens; the cache rates and `effectiveFrom` (a `YYYY-MM-DD` day
the price starts) are optional, with the same fallbacks as the built-in
table. Rows priced from the file record `pricing_version =
'override:<asOf>'`. The file is read once at startup; unknown keys, negative
or non-numeric rates, a bad date or a model listed twice stop the ingester
with every problem named.

## Schema migrations

The ingester owns the ClickHouse schema and updates it **automatically on
boot** — deploying a new ingester version is the schema deployment; there
is no separate migration step to run.

How it works: the baseline `CREATE TABLE IF NOT EXISTS` statements
provision fresh databases; versioned migrations in `src/migrations.ts`
alter existing ones. Applied migration ids are recorded in
`<db>.schema_migrations`, so each runs exactly once per database, and every
statement is written to be idempotent (`ADD COLUMN IF NOT EXISTS`, …) so
concurrent replicas booting during a rolling deploy race harmlessly.

To change the schema (e.g. add a column):

1. Append a migration to `MIGRATIONS` in `src/migrations.ts` — new columns
   need a `DEFAULT` so still-running old replicas can keep inserting.
2. Update the baseline in `src/clickhouse.ts` `schemaStatements()` so fresh
   databases come up with the final shape.
3. Ship it — the next deploy applies it everywhere; the log line
   `clickhouse migration applied: <id>` confirms.

Never edit or reorder a shipped migration; append a corrective one.

## Local development

```bash
docker compose up clickhouse   # from the repo root
AUTTER_LOCAL_DEV=1 \
CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_PASSWORD=dev \
npm run dev
```

`AUTTER_LOCAL_DEV=1` accepts the built-in key `autter_rt_local_dev_only`
(tenant `local`/`local`) from loopback and private addresses. Or run
`docker compose up` from the repo root, which sets it for the container.

Send a test error span:

```bash
curl -s http://localhost:4318/v1/traces \
  -H 'authorization: Bearer autter_rt_local_dev_only' -H 'content-type: application/json' \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"payments-api"}},{"key":"service.version","value":{"stringValue":"e4a218f"}}]},"scopeSpans":[{"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","name":"POST /orders/:id","kind":2,"startTimeUnixNano":"1753100000000000000","endTimeUnixNano":"1753100000120000000","status":{"code":2,"message":"boom"},"attributes":[{"key":"http.route","value":{"stringValue":"/orders/:id"}},{"key":"http.response.status_code","value":{"intValue":500}}],"events":[{"name":"exception","timeUnixNano":"1753100000100000000","attributes":[{"key":"exception.type","value":{"stringValue":"TypeError"}},{"key":"exception.message","value":{"stringValue":"cannot read x"}},{"key":"exception.stacktrace","value":{"stringValue":"TypeError: cannot read x\n    at handler (/app/dist/orders.js:12:3)"}}]}]}]}]}]}'
```

## Pointing OpenTelemetry at it

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"; // http/json

new OTLPTraceExporter({
  url: "https://otlp.your-domain.dev/v1/traces",
  headers: { authorization: "Bearer <ingest key>" },
});
```
