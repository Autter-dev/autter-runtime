# Autter Runtime

Open-source, lightweight runtime telemetry for web apps — tiny error tracking
in the browser, standard OpenTelemetry on the server, one normalised signal
model, analysed per repository.

Autter Runtime deliberately does **not** ship the full OpenTelemetry browser
SDK to your users. The browser gets a dependency-free, <5 KB error tracker;
your server keeps real OTel; and this repo's **OTLP ingester** receives both
and writes them to ClickHouse in a compact, per-repo data model.

```mermaid
flowchart TD
    A["@autter/runtime-browser (tiny tracker)"] --> B["Same-origin relay (@autter/runtime-node)"]
    B --> D["otlp-ingester /v1/browser (JSON)"]
    C["Server OpenTelemetry"] --> E["otlp-ingester /v1/traces + /v1/metrics (OTLP)"]
    D --> F["Normaliser + fingerprinter"]
    E --> F
    F --> G["ClickHouse (occurrences, spans, usage rollups)"]
    F --> H["Optional sink webhook → issue grouping"]
```

## Packages

| Package | Status | Description |
| --- | --- | --- |
| [`packages/otlp-ingester`](packages/otlp-ingester) | **v0.1** | Self-hostable ingest service: OTLP/HTTP (JSON) traces + metrics, browser error payloads → ClickHouse |
| `packages/runtime-browser` | planned | Zero-dependency, <5 KB browser error + usage tracker |
| `packages/runtime-node` | planned | Same-origin relay handler + curated OTel server setup |
| `packages/runtime-next` | planned | One-command Next.js integration |

See [`docs/PLAN.md`](docs/PLAN.md) for the detailed roadmap and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data model.

## Quick start (ingester)

```bash
docker compose up          # local ClickHouse + ingester
# or
cd packages/otlp-ingester
AUTTER_INGEST_KEYS='[{"key":"dev-key","orgId":"org1","repositoryId":"repo1"}]' \
CLICKHOUSE_URL=http://localhost:8123 \
npm run dev
```

Point your OpenTelemetry exporter at it:

```ts
new OTLPTraceExporter({
  url: "http://localhost:4318/v1/traces",
  headers: { authorization: "Bearer dev-key" },
});
```

## Design principles

- **Errors are 100%, everything else is sampled or aggregated.** Raw error
  occurrences are always kept (14-day TTL); successful traces are expected to
  be sampled upstream (0.5–1%); usage is stored as 1-minute rollups (90 days).
- **Per-repo analysis.** Every row is keyed by `org_id` + `repository_id`.
- **Privacy by construction.** No cookies, no DOM, no request/response bodies,
  no emails, no full URLs with query strings.
- **OTLP-compatible at the ingestion layer**, not inside a 3 KB browser script.

## License

MIT
