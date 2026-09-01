# Changelog

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
