# Autter Runtime — Detailed Plan

This is the roadmap for the open-source half of Autter Runtime. The Autter
backend (issue grouping, incidents, PR/deploy correlation, agent
investigations, dashboards) lives in the private Autter monorepo; everything
customers install or self-host lives here.

## Milestone 0 — OTLP ingester v0.1 (this repo, shipped)

Self-hostable ingest service, `packages/otlp-ingester`.

**Scope**
- `POST /v1/traces` — OTLP/HTTP **JSON** (`ExportTraceServiceRequest`).
  - Error spans (status `ERROR` or `exception` events) → fingerprinted error
    occurrences in ClickHouse (100% kept, 14-day TTL).
  - All received spans (sampling happens upstream in the SDK) → `runtime_spans`
    (7-day TTL).
  - Server spans (`SPAN_KIND_SERVER`) aggregated per minute into
    `runtime_metrics_1m` usage rollups (90-day TTL) — request count, error
    count, duration sum, keyed by service/environment/release/route.
- `POST /v1/metrics` — OTLP/HTTP JSON (`ExportMetricsServiceRequest`).
  Recognised HTTP-server duration histograms fold into the same 1-minute
  rollups; unknown instruments are accepted and dropped (204).
- `POST /v1/browser` — the compact browser payload emitted by
  `@autter/runtime-browser` (via the customer's same-origin relay):
  unhandled errors, rejections, manual captures → occurrences; session pings
  → rollup session counts.
- **Auth**: `Authorization: Bearer <ingest key>` (or `x-autter-key`). Keys
  resolve to `{orgId, repositoryId}` via either a static `AUTTER_INGEST_KEYS`
  env (self-host) or a `AUTTER_KEY_VALIDATOR_URL` webhook (Autter cloud),
  with a 60-second in-process cache.
- **Sink webhook** (optional): fingerprinted occurrences are forwarded to
  `AUTTER_SINK_URL` so a backend can do issue grouping/alerting in Postgres.
  The ingester itself only writes ClickHouse.
- Payload cap (default 1 MB), per-key fixed-window rate limit, graceful
  degrade when ClickHouse is unreachable (503 on ingest, never crash).

**Non-goals for v0.1**: OTLP protobuf, logs signal, gRPC, multi-node rate
limiting, source maps (symbolication is a backend concern).

## Milestone 1 — Ingester hardening (v0.2–v0.3)

1. **OTLP/HTTP protobuf** decode (`content-type: application/x-protobuf`) —
   the OTel JS exporters default to protobuf; JSON-only forces a config line.
   Use generated proto types, allocation-light decode, 1 MB cap.
2. gzip request bodies (exporters compress by default).
3. Redis-backed rate limiting (multi-replica deployments).
4. `/healthz` deep check (ClickHouse ping) + Prometheus `/metrics` self-telemetry.
5. Backpressure: buffered ClickHouse inserts with bounded queue + drop policy.
6. Container image published to GHCR on tag (`ghcr.io/autter-dev/otlp-ingester`).

## Milestone 2 — `@autter/runtime-browser` (v0.1)

Zero-dependency, <5 KB gzipped (CI-enforced with `size-limit`).

- Captures: `window.onerror`, `unhandledrejection`, manual
  `captureException()`, optional `trackEvent(name, props)` usage signals,
  session start ping.
- API: `initAutterBrowser({ endpoint, service, environment, release })`,
  `captureException()`, `trackEvent()`, `setUser()` (opaque id only),
  `setContext()`, `flush()`.
- Batching: flush at 10 events / 5 s / page hidden / `pagehide` / manual;
  `sendBeacon` → `fetch(keepalive)` fallback; fast-flush for unhandled errors.
- Hard privacy rules: pathname-only routes, no cookies/DOM/form
  values/headers/bodies/emails/IP.
- Never sends OTLP from the browser; the compact JSON payload is the contract
  with `/v1/browser`.

## Milestone 3 — `@autter/runtime-node` (v0.1)

Two halves, one package:

1. `createBrowserRelayHandler({ apiKey })` — framework-agnostic handler
   (Node http / Express / Next.js route): POST-only, ≤64 KB, schema
   validation, strips forbidden attributes, attaches the private ingest key
   server-side, forwards async, returns 202. Kills public credentials, CORS
   and CSP concerns.
2. `initAutterServer({ apiKey, endpoint, service, environment, release })` —
   curated OTel: `@opentelemetry/api`, `sdk-node`, OTLP proto exporters,
   `instrumentation-http`; express/fastify instrumentations as optional
   peers. Default sampling: errors 100%, successful traces 1%, metrics at
   60 s. Never the auto-instrumentation metapackage.

## Milestone 4 — `@autter/runtime-next` (v0.1)

One install command, one config file: server OTel init, browser tracker init,
relay route export, `<AutterErrorBoundary>`, release metadata from `GIT_SHA`,
CI source-map upload helper (maps upload to the Autter backend, not here).

## Milestone 5 — Publishing & community

- npm packages under the `@autter` scope (secure the scope before announcing).
- Changesets + GitHub Actions release pipeline; provenance-signed publishes.
- Versioning: independent per package, semver; the browser payload schema and
  ClickHouse row schemas carry explicit `version` fields for compatibility.
- CONTRIBUTING.md, issue templates, examples/ (next-app, express-app,
  static-site).

## Later / explicitly deferred

- Opt-in same-origin network tracing (`traceparent` propagation) in the
  browser tracker — never global `fetch` patching by default.
- Web Vitals, failed-request capture.
- Public DSN-style endpoint for static sites (origin allow-list, aggressive
  rate limits).
- Logs signal (`/v1/logs`).
- Full OpenTelemetry browser SDK support — only if demanded.

## Compatibility contract

| Interface | Stability |
| --- | --- |
| `/v1/traces`, `/v1/metrics` OTLP/HTTP | OTLP spec-stable |
| `/v1/browser` payload (`version: 1`) | additive-only changes |
| ClickHouse table schemas | additive-only; TTLs configurable via env |
| Sink webhook payload (`version: 1`) | additive-only changes |
