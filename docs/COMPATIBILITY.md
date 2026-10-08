# Version compatibility

Some Runtime features need a minimum ingester version (it adds the route or
the ClickHouse table they write to) and a minimum SDK version (it starts
sending them). When the ingester is older than the feature, the data is
dropped: the SDK gets a 404 or 400 and retries quietly. You no longer have to
match versions by hand. Runtime checks for you in three places:

1. **The SDK warns once at runtime.** `@autter/runtime-node` and
   `@autter/runtime-next` check the ingester in the background when a
   feature that needs a newer ingester is in use. Each incompatible feature
   gets one warning:

   ```text
   [autter-runtime] Operation logging needs ingester >= 1.4.0; yours is 1.3.4. Upgrade the ingester: docker pull ghcr.io/autter-dev/otlp-ingester:latest and restart it (ClickHouse migrations run at boot). See https://github.com/Autter-dev/autter-runtime/blob/main/docs/COMPATIBILITY.md
   ```

   The check never throws, never delays startup or exit, and prints nothing
   when versions match or can't be determined. It makes one `GET /v1/compat`
   request per process. It also reads the `x-autter-ingester-version` header
   on responses the SDK already receives (log export, browser relay). Turn it
   off with `initAutterServer({ compatCheck: false })` or `AUTTER_COMPAT_CHECK=0`.
   `debug: true` (or `AUTTER_DEBUG=1`) logs the result even when everything
   matches. The browser relay (`createBrowserRelayHandler`, `createAutterRelayRoute`)
   checks browser features such as CSP violation capture on the server side.
   The browser bundle sends only its version.

2. **`doctor` gives a one-shot report.**

   ```bash
   npx @autter/runtime-node doctor --endpoint https://ingest.example.com
   # also verify a key:  --key "$AUTTER_RUNTIME_KEY"   machine-readable:  --json
   ```

   It lists the Autter SDK versions installed in the current project, the
   ingester version and its ClickHouse schema level, and every feature those
   SDKs can use. Each feature is marked `ok`, `FAIL` (with the fix), or `??`
   (an ingester older than version reporting can't tell). Exit codes: `0`
   compatible, `1` mismatch or rejected key, `2` ingester unreachable. The
   endpoint defaults to `$AUTTER_ENDPOINT`, then `$OTEL_EXPORTER_OTLP_ENDPOINT`,
   then `https://otlp.autter.dev`. Use it in CI or after a deploy.

   For Python services, copy `adapters/python/compat.py` next to your app:

   ```bash
   python3 compat.py doctor --endpoint https://ingest.example.com --features operation_logging
   ```

   ```python
   from compat import warn_if_incompatible  # stdlib only; daemon thread, never raises
   warn_if_incompatible(os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"], ["operation_logging", "memory_metrics"])
   ```

3. **The Autter dashboard shows the status.** Repository → Settings → Runtime
   shows the ingester version, its schema level, the SDK and version each
   service sends with, and a warning with the fix for any feature your
   versions don't support.

## The ingester endpoint

`GET /v1/compat` is public, like `/healthz`, and returns no tenant data. It
returns the ingester version, the schema state (`ready`, `pending`, `failed`,
`unconfigured`), the applied migrations, and every feature in the manifest
with `available` set. Add `?features=operation_logging&sdk=@autter/runtime-node@1.3.0`
to get the evaluated `issues` too. Every response, including ingest
responses, carries `x-autter-ingester-version`.

The ingester records the SDK name and version each service sends with in
`runtime_sdk_versions`, and its own version and schema level in
`runtime_ingester_info` (migration `0012-runtime-compat`). The SDK name and
version come from the OTLP resource attributes `telemetry.distro.name` and
`telemetry.distro.version`, which the Node and Next.js SDKs set. Plain OTel
SDKs are recorded as `opentelemetry-<language>` from `telemetry.sdk.*`. The
browser SDK sends an `sdk` field. Writes are deduplicated to one row per
service, SDK and version per hour.

Ingesters released before `/v1/compat` (1.4.0 and older) answer it with a
404. The SDK and `doctor` then probe the feature's own route instead. For
example, `POST /v1/logs` without a key returns 401 on 1.4.0 and 404 on older
ingesters. That still catches the most common mismatch: operation logging
against a pre-1.4.0 ingester.

## Feature matrix

The single source of truth is
[`packages/otlp-ingester/src/compat-manifest.json`](../packages/otlp-ingester/src/compat-manifest.json).
The SDKs bundle it, the ingester serves it, and the Python adapter embeds a
copy that a test keeps identical.

| Feature (`id`) | Ingester | Migrations | Route | SDKs |
| --- | --- | --- | --- | --- |
| LLM call tracking (`llm_calls`) | 1.1.0 | `0004-llm-calls` | | node/next 1.1.0 |
| Endpoint latency regression detection (`endpoint_latency`) | 1.3.1 | `0005-latency-histograms` | | node/next 1.3.0 |
| Browser network, timing and outcome capture (`browser_network_events`) | 1.3.2 | | | browser/next 1.3.2 |
| Profile ingestion (`profiles`) | 1.3.2 | `0006-profile-samples` | `/v1/profiles` | |
| Source map upload (`source_maps`) | 1.3.2 | `0007-source-maps` | `/v1/sourcemaps` | |
| Memory pressure detection (`memory_metrics`) | 1.3.3 | `0008`, `0010` | | node/next 1.3.3 |
| Platform OOM/restart events (`platform_events`) | 1.3.3 | `0008-memory-signals` | `/v1/platform-events` | |
| Browser CSP violation capture (`csp_violations`) | 1.3.4 | | | browser 1.3.3, next 1.3.4 |
| Operation logging (`operation_logging`) | 1.4.0 | `0011-runtime-logs` | `/v1/logs` | node/next 1.4.0 |

Notes:

- Ingester 1.3.0 created the latency table but rejected numeric delta
  temporality, so endpoint latency needs 1.3.1.
- Ingesters older than 1.3.2 (network events) or 1.3.4 (CSP) reject the
  **whole** browser batch with a 400 when it contains a newer event type.
  Errors in the same batch are lost too. Upgrade the ingester before the
  browser SDK.
- Upgrade order: ingester first (its migrations run at boot), then SDKs.

## Adding a feature

Append an entry to `compat-manifest.json`. Give the first ingester release
that stores the feature, its migrations, its route (if it has its own), and
the first SDK releases that emit it. The ingester's `compat.test.ts` checks
ids, migrations, routes and versions against the code. The Python parity test
fails until `adapters/python/compat.py` gets the same manifest.
