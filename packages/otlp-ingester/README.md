# @autter/otlp-ingester

Self-hostable ingest service for Autter Runtime. Receives OTLP/HTTP (JSON)
traces and metrics plus compact browser error payloads, normalises them into
one per-repo signal model, fingerprints errors, and writes ClickHouse.

## Endpoints

| Route | Payload | Purpose |
| --- | --- | --- |
| `POST /v1/traces` | OTLP/JSON `ExportTraceServiceRequest` | Error spans → occurrences; all spans → `runtime_spans`; server spans → usage rollups |
| `POST /v1/metrics` | OTLP/JSON `ExportMetricsServiceRequest` | HTTP-server duration histograms → usage rollups |
| `POST /v1/browser` | Browser payload `version: 1` | Errors/rejections → occurrences; session pings → rollups |
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
| `AUTTER_SINK_URL` | — | Webhook receiving fingerprinted occurrences for issue grouping |
| `AUTTER_SINK_TOKEN` | — | Bearer token sent to the sink |
| `MAX_BODY_BYTES` | `1048576` | Request body cap |
| `RATE_LIMIT_PER_MINUTE` | `300` | Per-key fixed window (server keys) |
| `CLIENT_RATE_LIMIT_PER_MINUTE` | `120` | Per-key fixed window (client keys) |
| `OCCURRENCE_TTL_DAYS` / `SPAN_TTL_DAYS` / `METRICS_TTL_DAYS` | `14` / `7` / `90` | ClickHouse TTLs (applied at table creation) |

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
