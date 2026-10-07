# Changelog

## [1.5.0] - 2026-10-08

Packages: `otlp-ingester` 1.5.0, `runtime-node` 1.5.0, `runtime-next` 1.5.0, `runtime-browser` 1.4.0, new `runtime-edge` 1.0.0. Additive: 1.4.0 code keeps working unchanged (golden-tested).

### Features

- Request summaries: `autterRequests` (Express/Connect), `autterFastify` and `withRuntimeRequest` emit one summary per request with route, status, duration, outcome and a request id. `x-request-id` is honoured or generated, echoed (CORS-exposed) and stamped on spans and records. Summaries are always kept; `ignore` globs skip health/metrics routes (`runtime-node`, `runtime-next`).
- `runtimeContext` (`set`, `outcome`, `debug/info/warn/error`, `id`, `requestId`, `fork`, `carrier`) and `runInBackground`. Debug/info messages inside an operation fold into its summary (`autter.operation.logs`, max 50) and summaries carry `kind` and `autter.operation.level` (`runtime-node`).
- Coded errors: `RuntimeError`, `defineRuntimeErrors`, `isRuntimeErrorLike`, `toClientError` and `autterErrorResponse`. `captureException` reads `code/why/fix/link/status/expected` from any error, records cause chains, keeps `internal` on the span only, and treats `expected` failures as `degraded` (`runtime-node`).
- Code-based grouping: errors with a valid `autter.error.code` get the source-independent `code-v1` fingerprint; uncoded errors keep `message-v1` byte-for-byte (`otlp-ingester`).
- Cross-process carriers (`withRuntimeOperation(name, fn, attrs, { from, waitUntil })`) with OTel span links, and per-operation AI usage rollup (`autter.operation.ai`) (`runtime-node`).
- `initAutterLogging` runs requests, operations and coded errors without starting NodeSDK, for apps that already run their own OpenTelemetry SDK. Its error records (`autter.capture.mode=log`) are promoted to occurrences by `/v1/logs`, deduplicated by trace id (`runtime-node`, `otlp-ingester`).
- Enrichers (`enrichUserAgent`, `enrichRequestSize`, `enrichEdgeGeo`, `enrichDeployment`), sinks (`otlpSink`, `consoleSink`, `fileSink` writing `.autter/runtime/*.jsonl` in development) and the `@autter/runtime-node/testing` subpath (`runtime-node`).
- New `@autter/runtime-edge` 1.0.0: `withAutter` for Cloudflare Workers, Vercel Edge, Deno and Bun with zero dependencies; also exposed as `@autter/runtime-next/edge`.
- `runtime_logs` gains `kind`, `request_id`, `route`, `status_code`, `error_code`, `ai_cost_usd`, `ai_calls` (migration 0012) and feeds the `runtime_request_1m` rollup (migration 0014). `runtime_error_occurrences` gains `error_code`, `error_why`, `error_fix`, `error_link`, `expected`, `request_id`, `fingerprint_scheme` (migration 0013) (`otlp-ingester`).
- Sink payload (still `version: 1`) adds optional `errorCode`, `why`, `fix`, `link`, `expected`, `requestId`, `traceId`, `route`, `method`, `statusCode` and `fingerprintScheme`; absent values are omitted (`otlp-ingester`).
- New `LOG_TTL_DAYS` (default 14) applied idempotently to `runtime_logs` at boot (`otlp-ingester`).
- Browser: `captureException` and the global handlers send `code/why/fix/link/expected/requestId`; new `autterErrorFromResponse(response)`; failed fetch/XHR 5xx responses carry `x-request-id` (`runtime-browser`).
- Experimental zero-code `logging.requests` hook mode, off by default (`runtime-node`).

### Changes

- Console output is a pretty tree outside production; production keeps JSON lines (`runtime-node`).
- Debug/info logged inside an operation are folded into its summary instead of separate records; `logging.inline: false` restores 1.4.0 behaviour (`runtime-node`).
- `cache_read_tokens` / `cache_creation_tokens` counts are no longer masked as tokens by redaction (`runtime-node`, `otlp-ingester`).

### Fixes

- `runtime-browser` no longer declares a `./dist/index.cjs` entry that the ESM-only build never produced.
- `runtime-next` builds no longer race on `dist/` cleanup and drop `client.d.ts` / `edge.d.ts`.

### Upgrade

- Deploy otlp-ingester 1.5.0 first (migrations 0012–0014 run at boot), then SDKs. Older ingesters accept 1.5.0 SDK traffic but ignore the new fields.
- The `runtime_request_1m` rollup counts every insert, so it is approximate when exporters retry a batch.

## [1.3.1] - 2026-09-08

### Fixes

- Accept OTLP delta temporality value `1` and reject cumulative value `2` in endpoint latency storage (`otlp-ingester`). This corrects the numeric metric format used by SDK exporters.
- Add JSON and protobuf regression coverage for delta and cumulative histograms.

### Upgrade

- Self-hosted installations must deploy ingester 1.3.1 before endpoint regression detection is enabled. Node and Next.js SDK 1.3.0 remain compatible. Other package behavior is unchanged.
- Allow fresh baseline data to collect after the correction. Histograms discarded by the previous ingester cannot be recovered.

## [1.3.0] - 2026-09-08

### Features

- Preserve request-duration histogram buckets for endpoint latency detection. The ingester accepts delta histograms, removes duplicate points at query time, and stores the authenticated organization and repository IDs (`otlp-ingester`).
- Add opt-in `retainTracesAboveMs` to retain local traces for slow server requests. Retention uses bounded buffers and leaves the existing error-retention setting unchanged (`runtime-node`).
- Extend HTTP duration histogram bounds through two minutes and add a unique service instance ID (`runtime-node`).
- Keep normalized routes and HTTP methods on stored spans for exact endpoint trace matching (`otlp-ingester`).

### Upgrade

- Deploy the ingester before enabling endpoint regression detection in the Autter backend. Migration `0005-latency-histograms` creates the required table.
- Set the release commit SHA and enable slow-request retention before an incident occurs. Historical histogram buckets and discarded traces cannot be rebuilt.
- The Next.js package now requires `@autter/runtime-node` version `^1.3.0`. Browser behavior is unchanged.
- See `docs/ENDPOINT-REGRESSIONS.md` for setup and retention limits.

## [1.2.1] - 2026-09-07

### Fixes

- **One failed request no longer splits into two error issues**: `captureException` records the exception onto the active HTTP request span instead of a separate error span, so a thrown Express error and its failed request stay one issue. Before, a single request produced both an `Error` group and a duplicate `SpanError` group. The exception stack trace is now kept on the request span as well (`runtime-node`)

## [1.2.0] - 2026-09-07

### Features

- **Cross-language error grouping**: the ingester now parses native stack formats for Go, Rust, JVM (Java, Kotlin, Scala), and .NET, alongside JavaScript/TypeScript and Python. Each frame is reduced to a stable `function (file)` token, so errors group by their real code location instead of collapsing onto the message alone (`otlp-ingester`)

### Fixes

- Stop unrelated backend errors from grouping into one issue when their stack frames were discarded — Go and Rust frames were dropped entirely, and .NET/Rust frames lost the function name or kept volatile line numbers that fragmented one defect across deploys (`otlp-ingester`)

### Internal

- Add representative stack-trace fixtures and golden fingerprint tests for every supported language (`otlp-ingester`)

## [1.1.0] - 2026-09-01

### Features

- **LLM observability**: One-line client auto-instrumentation via `instrumentLlmClient`, provider exception type tracking on failed calls, and auto-initialization across SDK and ingester (`runtime-node`)
- **PII redaction**: Deep attribute redaction across all packages — browser source, ingester storage, Next.js re-exports (`runtime-browser`, `runtime-node`, `otlp-ingester`)
- **Auto-flush**: Graceful shutdown with automatic span flushing on `SIGTERM`/`SIGINT` and before process exit (`runtime-node`)
- **Error-linked trace retention**: Keep the full trace behind every error for debugging (`runtime-node`)
- **At-least-once sink delivery**: Bounded retry buffer for reliable downstream delivery (`otlp-ingester`)
- **`withProcessSpan`**: Always-recorded spans for non-HTTP work (`runtime-node`)
- **`withLlmCall`/`trackLlmCall`**: LLM usage & cost tracking (`runtime-node`)

### Fixes

- Tighten GenAI/usage token redaction to avoid masking token counts (`runtime-node`)
- Bound deep redaction traversal to prevent infinite loops on circular references (`runtime-node`)
- Make deep redaction serialization-safe for complex object graphs (`runtime-node`)
- Handle flush target failures gracefully (`runtime-node`)
- Split `runtime-next` into separate server and client entry points (`runtime-next`)
- Downgrade non-Error unhandled rejections to warnings (`runtime-browser`)
- Capture `unhandledRejection` with stackless fallback (`runtime-node`)
- Count error events into usage metric rollups (`otlp-ingester`)
- Populate route in `runtime_metrics_1m` for Express requests (`otlp-ingester`)
- Deterministic occurrence IDs and fair eviction in ingester (`otlp-ingester`)
- ClickHouse healthcheck on Docker Desktop for Mac (`quickstart`)

### Internal

- CI: never overwrite the box's Caddyfile on single-server deploys
- Docs: clarify `instrument.cjs` is created in the user's own app
