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
| `GET /healthz` | — | Liveness + ClickHouse reachability |

Auth on every ingest route: `Authorization: Bearer <ingest key>`,
`x-autter-key`, or `?key=` (query param — for sendBeacon, which cannot set
headers). OTLP endpoints accept **both protobuf and JSON** (`content-type:
application/x-protobuf` or `application/json`), gzip/deflate bodies
included — so any OpenTelemetry SDK (Go, Rust, Python, Java, .NET, JS)
works with its default exporter settings.

### Key scopes

| Scope | Prefix convention | Valid on | Extras |
| --- | --- | --- | --- |
| `server` (default) | `autter_rt_…` (secret) | all endpoints | 300 req/min |
| `client` | `autter_rtc_…` (publishable, safe in frontend bundles) | `/v1/browser` only | origin allow-list, 120 req/min |

`/v1/browser` answers CORS preflights permissively; real enforcement (key +
origin allow-list) happens on the POST. Cross-origin browsers send
`text/plain` bodies (CORS-safelisted, no preflight per beacon) which the
route parses as JSON.

```json
AUTTER_INGEST_KEYS='[
  {"key":"autter_rt_…","orgId":"org1","repositoryId":"repo1"},
  {"key":"autter_rtc_…","orgId":"org1","repositoryId":"repo1",
   "scope":"client","allowedOrigins":["https://app.example.com"]}
]'
```

The validator webhook may return the same extra fields:
`{ orgId, repositoryId, scope?, allowedOrigins? }`.

### Version compatibility

`GET /v1/compat` (public, no tenant data) returns this ingester's version,
its ClickHouse schema state, and which features from
`src/compat-manifest.json` it supports. Add
`?features=operation_logging&sdk=@autter/runtime-node@1.3.0` to get the evaluated
incompatibilities. Every response carries `x-autter-ingester-version`. The
ingester records the SDK name and version each service sends with
(`runtime_sdk_versions`) and its own version (`runtime_ingester_info`), and
the Autter dashboard reads both. See [docs/COMPATIBILITY.md](../../docs/COMPATIBILITY.md).

## Configuration

| Env | Default | Description |
| --- | --- | --- |
| `PORT` | `4318` | Listen port (OTLP/HTTP convention) |
| `CLICKHOUSE_URL` | — | e.g. `http://localhost:8123`; unset = ingest returns 503 |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `default` / empty | |
| `CLICKHOUSE_DATABASE` | `autter_runtime` | Created automatically |
| `AUTTER_INGEST_KEYS` | — | JSON: `[{"key":"...","orgId":"...","repositoryId":"..."}]` |
| `AUTTER_KEY_VALIDATOR_URL` | — | Webhook: `POST {key}` → `{orgId, repositoryId}` (60 s cache) |
| `AUTTER_KEY_VALIDATOR_TOKEN` | — | Bearer token sent to the validator |
| `AUTTER_SINK_URL` | — | Issue-grouping webhook; at-least-once (`docs/ARCHITECTURE.md`) |
| `AUTTER_SINK_TOKEN` | — | Bearer token sent to the sink |
| `SINK_MAX_ATTEMPTS` | `12` | Delivery attempts per batch (1–60 s backoff) |
| `SINK_MAX_BUFFERED_BATCHES` | `1000` | Retry buffer cap; oldest drops are logged |
| `SINK_MAX_BUFFERED_MB` | `64` | Sink retry buffer cap (memory) |
| `MAX_BODY_BYTES` | `1048576` | Request body cap |
| `RATE_LIMIT_PER_MINUTE` | `300` | Per-key fixed window (server keys) |
| `CLIENT_RATE_LIMIT_PER_MINUTE` | `120` | Per-key fixed window (client keys) |
| `PROMOTION_LOOKUPS_PER_MINUTE` | `30` | Per-tenant ClickHouse dedupe lookups for `/v1/logs` error promotion; over budget, records are promoted with in-batch dedupe only |
| `OCCURRENCE_TTL_DAYS` / `SPAN_TTL_DAYS` / `METRICS_TTL_DAYS` | `14` / `7` / `90` | ClickHouse TTLs (applied at table creation) |
| `LLM_CALL_TTL_DAYS` | `90` | Retention for `runtime_llm_calls` rows |
| `LOG_TTL_DAYS` | `14` | Retention for `runtime_logs` (request summaries are always kept, never sampled, so this is the main volume knob). Unlike the other TTLs it is also applied to **existing** tables: at boot the ingester compares it with the table's TTL and runs `ALTER TABLE … MODIFY TTL` only when they differ; a failure is logged and retried next boot |
| `AUTTER_REDACT_VALUE_PATTERNS` | — | JSON array of extra regex sources masked in stored/forwarded text and attribute values (built-in secret/PII patterns always apply) |
| `AUTTER_REDACT_KEY_PATTERNS` | — | JSON array of extra regex sources for attribute keys whose values are masked wholesale |

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
Python/Go/etc.) are recognised automatically on `/v1/traces` and additionally
stored per call in `runtime_llm_calls`: provider, model, operation, input/
output tokens, duration, ok/error status (with the provider exception type
in `error_type` for failed calls), and a USD cost. The cost is taken
from the `autter.llm.cost_usd` span attribute when reported; otherwise it's
estimated from the built-in price table in `src/llm-pricing.ts`
(`cost_source` records which: `reported` / `estimated` / `unpriced`). An
opaque calling-user id is read from `autter.user_id` (or the AI SDK's
`metadata.userId`). The Vercel AI SDK's outer `ai.generateText`/`ai.streamText`
spans are not counted — their inner `.doGenerate`/`.doEmbed` call spans carry
the usage, and counting both would double the tokens.

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
AUTTER_INGEST_KEYS='[{"key":"dev-key","orgId":"org1","repositoryId":"repo1"}]' \
CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_PASSWORD=dev \
npm run dev
```

Send a test error span:

```bash
curl -s http://localhost:4318/v1/traces \
  -H 'authorization: Bearer dev-key' -H 'content-type: application/json' \
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
