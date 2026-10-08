# Changelog

## [Unreleased]

### Security

- Scrub secrets and PII from exception messages, stack traces and span status messages, not only custom attributes; re-scrub every span at export so third-party instrumentations, HTTP URLs (`?token=`) and `recordException` calls are covered; scrub `LlmCallHandle.setAttributes`, `instrumentLlmClient` attributes and provider errors, and module-level captures made before `initAutterServer` (`runtime-node`).
- New value patterns everywhere: Basic auth, `Authorization:`/`Cookie:`/`Set-Cookie:` header text, connection strings with empty usernames or `@` in the password, `sk-proj-`/`sk-ant-`, Stripe, GitHub fine-grained, GitLab, npm, SendGrid and Google API keys, `password=`/`?token=`/`?api_key=` assignments, Luhn-valid card numbers. New sensitive keys: any `…authorization` header key, `session`/`sessionid`/`sid`, `pwd`, `dsn`, bounded `ssn`. Custom value patterns now apply globally (`runtime-node`, `runtime-browser`, `otlp-ingester`).
- The browser relay scrubs message, stack, name and nested context (`redact` option) (`runtime-node`).
- Browser SDK scrubs messages, stacks and nested context; new `redact: { keys, values } | false` option and `scrubText` export (`runtime-browser`).
- Ingester scrubs occurrence message/stack/route, span names, browser context (deep) and LLM-call attributes before storage and the sink webhook; extra patterns via `AUTTER_REDACT_VALUE_PATTERNS` / `AUTTER_REDACT_KEY_PATTERNS` (`otlp-ingester`).
- Python adapter: new stdlib-only `adapters/python/redact.py` (`redact_text`, `redact_attributes`, `configure`); the caught-exception sampler scrubs tracebacks with it.
- Shared parity vectors in `test-vectors/redaction.json` run against every implementation.

### Version compatibility check

- One source of truth for feature requirements: `packages/otlp-ingester/src/compat-manifest.json`. It lists the minimum ingester, ClickHouse migrations, route and minimum SDK versions for each feature. See `docs/COMPATIBILITY.md`.
- New `GET /v1/compat` (public): ingester version, schema state and level, and per-feature availability. Optional `?features=…&sdk=name@version` returns evaluated issues. Every response carries `x-autter-ingester-version`, exposed to CORS on `/v1/browser`. The ingester records the SDK name and version each service sends with (`runtime_sdk_versions`) and its own version (`runtime_ingester_info`), through migration `0012-runtime-compat` (`otlp-ingester`).
- The SDK checks the ingester once, in the background, when a feature that needs a newer ingester is in use. It warns once per incompatible feature, naming both versions and the fix. Opt out with `compatCheck: false` or `AUTTER_COMPAT_CHECK=0`. The SDK reports itself as `telemetry.distro.name` and `telemetry.distro.version`, and the browser relay forwards the browser SDK version. Both check browser features against the ingester's version header (`runtime-node`, `runtime-next`).
- New `npx @autter/runtime-node doctor`: a one-shot SDK, ingester and schema report. Exits non-zero on a mismatch (`runtime-node`).
- The browser payload carries the SDK version (`sdk`). Older ingesters ignore it (`runtime-browser`).
- Python adapter: new stdlib-only `adapters/python/compat.py`, with `warn_if_incompatible` and `python3 compat.py doctor`.

### Behavior notes

- Error messages that contained secrets now fingerprint on their scrubbed form, so such issues may regroup once (they previously split per secret value).

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
