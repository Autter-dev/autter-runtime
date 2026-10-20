# Changelog

## Unreleased

### Fixes

- Symbolicated browser frames are named after the function they are in, not their call site (scope-based naming, as Sentry's js-source-scopes and PostHog cymbal's `token.scope()` do it). Until now a resolved frame took the name the source map holds at its CALLER's position, so `const run = actions.captured; await run()` reported the `captured` frame as `run`, and handlers a framework calls got the framework's identifier (`func`, `fn`, `listener`). `autter-runtime sourcemaps upload` and the Vite/Rollup, webpack and Next.js plugins now parse each bundle as served (after `inject`, so positions match the stack) with `acorn` (new dependency), record every function (declarations, expressions, arrows, class and object methods, getters, setters) with its generated range and its original name (its own name, else the binding it is assigned to, else its object or class key; mapped through the map's `names`, else `sourcesContent`; minified names that cannot be mapped are marked unknown, never guessed), and upload them in the map as `x_autter_scopes`: `{ version: 1, names, scopes: [[startLine, startCol, endLine, endCol, nameIndex], …] }`. A bundle that does not parse, or a map that only fits the 5 MB limit without scopes, is uploaded without them, with a warning (`runtime-cli`). The ingester names a resolved frame after the innermost scope containing it (`null` for an anonymous function or top-level code); the source map cache's byte budget counts the scope table, and `/v1/sourcemaps` stores the field as sent. Maps without scopes, and malformed `x_autter_scopes`, keep the caller-name rule exactly (`otlp-ingester`). See `docs/SOURCE-MAPS.md`.
- Grouping: `frames-v3` tokens change only for frames resolved through a map uploaded with scopes (new uploads from the new CLI), and only where the call-site name differed from the function's own name, so an issue grouped under the old names gets a new `frames-v3` issue once, from the first release uploaded with scopes; issues still keyed by `message-v1` keep matching it. Different handlers in one file no longer merge into one issue under a shared call-site name (`fn@events.js`). The `frames-v3` contract and `fingerprint-v3-vectors.json` are unchanged, so there is no scheme bump.

## [1.6.0] - 2026-10-21

Packages: `otlp-ingester` 1.6.0, `runtime-node` 1.6.0, `runtime-next` 1.6.0, `runtime-browser` 1.6.0, `runtime-edge` 1.1.0, new `runtime-cli` 1.0.0. Additive: every new field is optional and older ingesters ignore it. Deploy otlp-ingester 1.6.0 first (migrations 0016–0017 run at boot), then SDKs.

### Features

- Server errors keep their stacks: `autterErrorHandler()` (Express/Connect error middleware that calls `next(err)` unchanged), `autterFastifyErrors` (Fastify `onError` hook, as a plugin or `autterFastifyErrors(app)`) and `autterKoa()` (Koa middleware that rethrows) record a thrown error, with its stack, on the request span. Previously the framework's 500 reached the ingester as a stackless `HttpServerError` grouped by route. By default they report status ≥ 500, RuntimeErrors and coded errors (`capture` option). New `captureRequestError(error, attributes?)` for other frameworks: reported once, on the request's HTTP server span even when a child span is active (`runtime-node`).
- Unhandled promise rejections are recorded as errors (`autter.unhandled_rejection: true`, not fatal) without changing whether the process crashes. When Node would crash (default `--unhandled-rejections=throw`, no other listener) the rejection is rethrown on the next tick, so it still exits with code 1 and is recorded as a fatal crash as before; `warn-with-error-code` keeps its warning and exit code; `strict` is left to the crash monitor. Opt out with `captureUnhandledRejections: false` (`initAutterServer`, `initAutterLogging`) (`runtime-node`).
- Next.js `onRequestError` from `@autter/runtime-next/instrumentation`: errors Next catches in server components, server actions, route handlers and middleware are recorded with their stack and Next's context (`next.route_path`, `next.router_kind`, `next.route_type`, `next.render_source`, `next.digest`, method and query-less path; never headers or cookies). Node: on the request span through `registerAutter`'s tracker. Edge: an `edge-light`/`worker` build with no Node imports sends the error to `/v1/logs` with `autterOnRequestError({ edge })` options. Redirects and `notFound()` are skipped (`runtime-next`).
- `captureEdgeException(options, error, attributes?)` reports one exception outside `withAutter`, skipping errors `withAutter` already reported (`runtime-edge`).
- Breadcrumbs (compat feature `breadcrumbs`): the last 30 steps before an error, oldest first, attached to the error and shown on the issue page. Browser: opt-in `@autter/runtime-browser/breadcrumbs` (`enableBreadcrumbs()`, `addBreadcrumb()`) records requests from the fetch/XHR wrappers (method, path without query, status including 4xx, duration), navigations, clicks (the existing action label) and `console.warn`/`console.error` (opt out with `{ console: false }`), scrubbed like the rest of the event, and attaches them to exceptions, unhandled rejections, request failures, error messages and outcomes; kept out of the main bundle so it stays under 5 KB, and the 1.4 `autter.trail` is still sent. Node: `addBreadcrumb()` scoped to the current request (AsyncLocalStorage), `runtimeLogger` entries recorded as `log` breadcrumbs, attached to exception span events as the `autter.breadcrumbs` JSON attribute; the browser relay forwards `breadcrumbs`. Ingester: validates, bounds (30, 500-char messages, 10 data keys, 16 KB) and scrubs them, stores them under `autter.breadcrumbs` in the occurrence's `attributes` JSON (no migration) and forwards them on the sink as the optional `breadcrumbs` field (`runtime-browser`, `runtime-node`, `runtime-next`, `otlp-ingester`).
- Symbolication at ingest and the `frames-v3` issue identity (EI-14/15): every stack is parsed into structured frames, innermost first (V8, Firefox/Safari, Python reversed from its outermost-first traceback, Go, JVM, .NET, Rust, best-effort Ruby/PHP), with dependency, runtime and extension frames marked not in-app. Browser JS frames are resolved through the release's uploaded source maps before grouping (function names from the map's `names`, `ignoreList` honoured, parsed maps cached in a byte-bounded LRU, `SOURCE_MAP_CACHE_MB`); a lookup or map failure never fails ingest. The new `frames-v3` fingerprint hashes service, error type and up to five in-app `function@file` tokens (no line numbers, route, source or release), so a bug stays one issue across deploys, chunk hashes, preview domains, pages and tiers. Sink occurrences gain optional `frames`, `fingerprints` (every candidate: `manual-v1`, `code-v1`, `frames-v3`, `message-v1`, highest precedence first) and `fingerprintRecord`; `fingerprint`/`fingerprintScheme` stay the legacy identity byte-for-byte. `runtime_error_occurrences` gains `frames` and `fingerprints` (migration `0016-occurrence-frames-fingerprints`). Shared vectors: `stack-parse-vectors.json`, `fingerprint-v3-vectors.json` (`otlp-ingester`).
- Readable stack traces with debug ids (EI-13): new `@autter/runtime-cli` package (`autter-runtime sourcemaps inject|upload`) gives every JS bundle with a map a content-addressed debug id (`//# debugId=`, a `globalThis._autterDebugIds` registration snippet, and `debugId` in the `.map`), and uploads maps in parallel, skipping ones the ingester already has. Release defaults to `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `GIT_SHA`, then `git rev-parse HEAD`. Bundler plugins: `@autter/runtime-cli/vite` (Vite and Rollup), `@autter/runtime-cli/webpack` and `withAutterSourceMaps` from `@autter/runtime-cli/next`; composite action `.github/actions/upload-sourcemaps`. `/v1/sourcemaps` accepts `debugId` (or reads it from the map) and `.mjs`/`.cjs` bundles; new `/v1/sourcemaps/check`; `runtime_source_maps` gains `debug_id` and `content_hash` (migration `0017-source-maps-debug-id`); `lookupSourceMap` finds a map by debug id, then by release + path (`otlp-ingester`). Exceptions carry `debugIds` for the scripts in their stack, read from `globalThis._autterDebugIds` (`runtime-browser`); the browser relay forwards them, and its `autter-runtime` bin hands `sourcemaps` commands to `@autter/runtime-cli` (`runtime-node`). New compat feature `source_map_debug_ids`. See `docs/SOURCE-MAPS.md`.
- Fingerprint override (`fingerprint_override`): `captureException(err, { fingerprint })` takes a string or up to 10 strings (≤200 chars each) and groups every error that carries it into one issue. Browser: a `fingerprint` field on the event, also settable in `beforeSend`, passed through the relay. Node, logger-only mode and edge: the exception event (or promoted log) attribute `autter.fingerprint`, a JSON array of strings. The ingester carries it as `fingerprintOverride` (scrubbed, bounded) and `manualFingerprint()` hashes it into the `manual-v1` candidate, which wins over every automatic scheme; older ingesters ignore the field (`runtime-browser`, `runtime-node`, `runtime-next`, `runtime-edge`, `otlp-ingester`).
- Browser errors link to server traces (EI-11). New opt-in `@autter/runtime-browser/tracing` (`enableTracePropagation({ tracePropagationTargets })`, about 0.6 KB brotlied; the main bundle grows by 45 B of hooks): same-origin `fetch` and XHR requests, and URLs matching `tracePropagationTargets`, carry an unsampled W3C `traceparent`; an existing `traceparent` is never overwritten and the tracker's own endpoint never gets one. `request_failure` events carry their request's `traceId`; an exception or unhandled rejection carries the trace id of the request that finished or failed in the previous 5 s, when that request was traced (`runtime-browser`). The relay forwards a valid `traceId` (`runtime-node`). Unsampled remote parents are head-sampled at the service's own `traceSampleRate` instead of never, so browser-initiated requests keep their usual sampling (`runtime-node`). `/v1/browser` accepts a 32-hex `traceId` per event and stores it as the occurrence's `trace_id` (sink `traceId`); a malformed one is dropped on its own. Browser occurrences no longer count as duplicates in the `/v1/logs` promotion dedupe (`otlp-ingester`). New compat feature `browser_trace_propagation` (ingester 1.6.0).

### Fixes

- Boundary captures (`autterErrorResponse`, `autterFastify`, `withRuntimeRequest`) land on the request's HTTP server span when an instrumentation's child span is active, so the 500 is not also reported as a stackless `HttpServerError`; a throwing `capture` predicate no longer escapes into the response (`runtime-node`).
- `shutdown()` removes the crash monitor it installed (`runtime-node`).
- Errors from another JavaScript realm keep their type, message and stack. Under `next start`, Next runs edge code in a `vm` sandbox and hands edge route-handler errors to the Node `onRequestError`; they failed `instanceof Error` and were recorded as `"Error: …"` with a stack synthesized at the capture site. New internal `isError` (`Error.isError`, else the built-in error tag) is used wherever an error is recorded (`runtime-node`, `runtime-edge`).
- `captureRequestError` on an error that was already reported (by `withRuntimeRequest`, an error hook, …) still adds its attributes to the request span, without a second exception, so Next's `onRequestError` context is kept for route handlers wrapped in `withRuntimeRequest` (`runtime-node`).
- Edge `onRequestError` hands its delivery to the request's `waitUntil` from Next's request context: Next awaits the hook for middleware but not for errors raised while rendering, so an edge function could finish before the record was sent (`runtime-next`).
- Docs: Next.js apps add `serverExternalPackages: ["@autter/runtime-node"]` to `next.config`. Next bundles a separate copy of the SDK into `instrumentation.ts` and into each route, so without it code in routes (`withRuntimeRequest`, `captureServerException`, `runtimeLogger`) used a copy `registerAutter` never started: request summaries went to the console instead of the ingester, and errors were reported twice (`runtime-next`).

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

### Security

- Scrub secrets and PII from exception messages, stack traces and span status messages, not only custom attributes; re-scrub every span at export so third-party instrumentations, HTTP URLs (`?token=`) and `recordException` calls are covered; scrub `LlmCallHandle.setAttributes`, `instrumentLlmClient` attributes and provider errors, and module-level captures made before `initAutterServer` (`runtime-node`).
- New value patterns everywhere: Basic auth, `Authorization:`/`Cookie:`/`Set-Cookie:` header text, connection strings with empty usernames or `@` in the password, `sk-proj-`/`sk-ant-`, Stripe, GitHub fine-grained, GitLab, npm, SendGrid and Google API keys, `password=`/`?token=`/`?api_key=` assignments, Luhn-valid card numbers. New sensitive keys: any `…authorization` header key, `session`/`sessionid`/`sid`, `pwd`, `dsn`, bounded `ssn`. Custom value patterns now apply globally (`runtime-node`, `runtime-browser`, `otlp-ingester`).
- The browser relay scrubs message, stack, name and nested context (`redact` option) (`runtime-node`).
- Browser SDK scrubs messages, stacks and nested context; new `redact: { keys, values } | false` option and `scrubText` export (`runtime-browser`).
- Ingester scrubs occurrence message/stack/route, span names, browser context (deep) and LLM-call attributes before storage and the sink webhook; extra patterns via `AUTTER_REDACT_VALUE_PATTERNS` / `AUTTER_REDACT_KEY_PATTERNS` (`otlp-ingester`).
- Python adapter: new stdlib-only `adapters/python/redact.py` (`redact_text`, `redact_attributes`, `configure`); the caught-exception sampler scrubs tracebacks with it.
- Shared parity vectors in `test-vectors/redaction.json` run against every implementation.
- Export-time scrubbing also covers span link attributes, span event names and resource attributes on traces and metrics (`process.command_args` from NodeSDK's process detector, `OTEL_RESOURCE_ATTRIBUTES`). A batch with a span that could not be scrubbed is reported as a failed export instead of a silent partial success (`runtime-node`).
- The JWT pattern no longer takes seconds on long `eyJ-eyJ-…` runs (5 s per 64 KB in Node, 3.4 s in the ingester, 6 s in the browser); the ingester caps each scrubbed string at 64 KB and cuts context values to their stored size before scrubbing (`runtime-node`, `runtime-browser`, `otlp-ingester`, Python).
- Custom key/value patterns with `g` or `y` flags work on every key and every occurrence (a `/x/g` key pattern used to skip every other matching key); browser value patterns mask every match, not just the first (`runtime-node`, `runtime-browser`).
- Messages, names and stacks are scrubbed before they are cut to size, so a secret straddling the limit is masked whole (browser, relay, Python sampler). A browser context with a throwing getter or revoked Proxy is dropped instead of throwing into the app. The `card` key rule no longer masks keys like `discard` or `scorecard`.

### Version compatibility check

- One source of truth for feature requirements: `packages/otlp-ingester/src/compat-manifest.json`. It lists the minimum ingester, ClickHouse migrations, route and minimum SDK versions for each feature. See `docs/COMPATIBILITY.md`.
- New `GET /v1/compat` (public): ingester version, schema state and level, and per-feature availability. Optional `?features=…&sdk=name@version` returns evaluated issues. Every response carries `x-autter-ingester-version`, exposed to CORS on `/v1/browser`. The ingester records the SDK name and version each service sends with (`runtime_sdk_versions`) and its own version (`runtime_ingester_info`), through migration `0015-runtime-compat` (`otlp-ingester`).
- The SDK checks the ingester once, in the background, when a feature that needs a newer ingester is in use. It warns once per incompatible feature, naming both versions and the fix. Opt out with `compatCheck: false` or `AUTTER_COMPAT_CHECK=0`. The SDK reports itself as `telemetry.distro.name` and `telemetry.distro.version`, and the browser relay forwards the browser SDK version. Both check browser features against the ingester's version header (`runtime-node`, `runtime-next`).
- New `npx @autter/runtime-node doctor`: a one-shot SDK, ingester and schema report. Exits non-zero on a mismatch (`runtime-node`).
- The browser payload carries the SDK version (`sdk`). Older ingesters ignore it (`runtime-browser`).
- Python adapter: new stdlib-only `adapters/python/compat.py`, with `warn_if_incompatible` and `python3 compat.py doctor`.

### Changes

- Console output is a pretty tree outside production; production keeps JSON lines (`runtime-node`).
- Debug/info logged inside an operation are folded into its summary instead of separate records; `logging.inline: false` restores 1.4.0 behaviour (`runtime-node`).
- `cache_read_tokens`, `cache_creation_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cached_tokens` and `reasoning_tokens` counts are no longer masked as tokens by redaction (`runtime-node`, `otlp-ingester`).

### Fixes

- Value redaction is linear on adversarial strings. The email, URL-credential, JWT, Slack and Autter-key patterns could take seconds to minutes on long runs such as `"a".repeat(65536)`; they now only start a match at the beginning of a run, query-string stripping is procedural, and strings are capped before scrubbing (`runtime-core`, `runtime-node`, `runtime-edge`, `otlp-ingester`, `runtime-browser`). The patterns predate 1.5.0; 1.5.0 routes more input through them.
- `@autter/runtime-edge` keeps the request summary when its queue is full (a summary evicts the oldest plain record), caps warn/error records at 50 per request, and no longer throws from `rt.error` / `rt.captureException` when attributes have throwing getters or are Proxies.
- `@autter/runtime-edge` queues records with the destination (key, endpoint, service, environment) they were created for, and no longer queues records when no key is configured, so a later request can't export them under its own key.
- `/v1/logs` promotion dedupe lookups are bounded: windows of at most 10 minutes, at most 4 per request, newest records first, only for timestamps within the last 24 hours, and a per-tenant budget (`PROMOTION_LOOKUPS_PER_MINUTE`, default 30) (`otlp-ingester`).
- A throwing getter or Proxy on an error's metadata no longer stops `captureException` from reporting the error (`runtime-browser`).
- The sink keeps a numeric `statusCode` of `0` (`otlp-ingester`).
- An invalid `autter.error.code` or request id on an exception event no longer hides a valid one on its span (`otlp-ingester`).
- `proxy-addr` 2.0.8 in the lockfile (CVE-2026-90711; reached through Express in the ingester and examples).
- Package test scripts build the workspace packages they import first, so each suite runs on a clean checkout.
- `runtime-browser` no longer declares a `./dist/index.cjs` entry that the ESM-only build never produced.
- `runtime-next` builds no longer race on `dist/` cleanup and drop `client.d.ts` / `edge.d.ts`.

### Behavior notes

- Error messages that contained secrets now fingerprint on their scrubbed form, so such issues may regroup once (they previously split per secret value).

### Upgrade

- Deploy otlp-ingester 1.5.0 first (migrations 0012–0015 run at boot), then SDKs. Older ingesters accept 1.5.0 SDK traffic but ignore the new fields.
- The `runtime_request_1m` rollup counts every insert, so it is approximate when exporters retry a batch.
- The compatibility tables (`runtime_sdk_versions`, `runtime_ingester_info`) are created by migration `0015-runtime-compat`, after 0012–0014.

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
