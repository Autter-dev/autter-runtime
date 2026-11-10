# Is my data arriving?

How to check that telemetry gets from your app to storage, what is sampled,
how long each kind takes to show up, and what each failure looks like.

- [Check it in one command: `verify`](#check-it-in-one-command-verify)
- [What is sampled](#what-is-sampled)
- [When it arrives](#when-it-arrives)
- [What the SDKs tell you](#what-the-sdks-tell-you)
- [What the ingester tells you](#what-the-ingester-tells-you)
- [Behind a firewall or proxy](#behind-a-firewall-or-proxy)

## Check it in one command: `verify`

```bash
npx @autter/runtime-node verify --service checkout --release "$GIT_SHA"
# Python:  python3 compat.py verify --service checkout --release "$GIT_SHA"
```

It reads `AUTTER_ENDPOINT` and `AUTTER_RUNTIME_KEY` (Python also reads the
key from `OTEL_EXPORTER_OTLP_HEADERS`), sends one test span with an error and
one log record through the real path, reads them back, and stops at the
first step that fails:

| Step | Checks | When it fails |
| --- | --- | --- |
| `key` | A key is set and is a server key | No key, or a client (`autter_rtc_`) or upload (`autter_rtu_`) key |
| `network` | DNS, TCP, TLS and an HTTP answer from the ingester | Says which of the four broke, and the likely cause (see [below](#behind-a-firewall-or-proxy)) |
| `ingester` | The server is an Autter ingester; its version against your installed SDKs | Wrong URL (for example one ending in `/v1/traces`) |
| `storage` | `/healthz`: ClickHouse accepts writes | Storage unconfigured, down, refusing the ingester's password, or missing tables |
| `auth` | The ingester accepts the key | The ingester's own reason: `invalid ingest key`, `missing ingest key`, `client keys cannot send OTLP`… |
| `ingest` | `/v1/traces` accepts the test span, nothing rejected | The status and reason |
| `stored` | The span and the error are in storage | Accepted but not written: check the ingester's logs |
| `trace` | The error is linked to its span by trace id | |
| `release` | The release you sent is stored | A warning when no release is set: "broke in release X" needs one |
| `logs` | `/v1/logs` stores a record | The ingester has no `/v1/logs` (older than 1.4.0) |

The test event is stored under environment `verify` and never opens an
issue, sends an alert, or counts as a request. Against an ingester without
`GET /v1/verify` (released before it), `verify` sends only a plain span and
reports `stored` as not checked.

Exit codes: `0` delivered, `1` a step failed, `2` the ingester could not be
reached. `--json` gives the full report. Run it after a deploy, in CI, or
whenever events don't show up.

`doctor` is the quicker check that sends nothing: versions and version skew,
which features are active, storage readiness and the key (`key: not checked`
when none is given).

## What is sampled

Errors are never head-sampled. Healthy traffic is.

| What | Sent | Knob |
| --- | --- | --- |
| Errors: `captureException`, crashes, unhandled rejections, failed outcomes, error spans | 100% | `sampleRate` (default 1) drops a share of `captureException`/error messages, never crashes; `ignoreErrors` drops matches |
| The full trace around an error | 100% (buffered in process, then exported) | `retainTracesOnError` (default true) |
| The full trace of a slow request (over 500 ms and its route's rolling p95) | up to 60 a minute per process (buffered, then exported) | `retainTracesAboveMs` (a fixed threshold, or `false`), `retainSlowTracesPerMinute` |
| Regular traces (healthy requests) | 1% | `traceSampleRate` (default `0.01`) |
| Request counts, error counts, latency histograms | 100%, as metrics | not sampled |
| LLM calls (`gen_ai.*` spans): model, tokens, cost, latency, status | 100% | `llmTracing: false` turns them off |
| LLM prompt and completion content | failed or slow calls only | `llmContent: "always"` or `"never"` |
| Logs, operation and request summaries | 100% | `logging.minLevel` |
| Browser errors | 100% | `sampleRate`, `ignoreErrors`, `denyUrls` in `@autter/runtime-browser/filters` |
| Python and other OTel SDKs | your sampler's ratio | Errors survive only if your sampler keeps them; `adapters/python/autter_tracing.py` keeps every error |

At the ingester, suppression rules (set in Autter) drop or sample matching
errors, and loop collapse stores a looping error as one sample a minute with
an exact count. Both are counted, and an accepted request says how many it
suppressed or collapsed in the `x-autter-ingest` header (below).

## When it arrives

Times from the call in your code to the row in storage, with a healthy
ingester. Storage writes are synchronous: once the ingester answers 200 or
202, the rows are in ClickHouse.

| What | Typical delay | Why |
| --- | --- | --- |
| Browser error | under 1 s | sent 0.5 s after the error, or at once on page hide |
| Browser events (clicks, timings) | up to 5 s | batched every 5 s, or at 10 events |
| Server error (`captureException`, a 5xx) | 0–2 s | the always-on exporter batches every 2 s |
| Server trace (sampled healthy request) | 0–5 s | OpenTelemetry's default 5 s batch |
| Logs, operation and request summaries | about 2 s | the log sink flushes every 2 s |
| Request counts and latency (metrics) | up to 60 s | exported every 60 s (`metricIntervalMs`) |
| Edge worker records | after the response | sent in `waitUntil` once the request finishes |
| Autter dashboard (issues, alerts) | a few seconds after storage | the sink forwards stored errors |

`initAutterServer` flushes on a normal exit (`autoFlush`, on by default). A
serverless function that is frozen after it answers should `await
runtime.shutdown()` (or flush in `waitUntil`) before it returns, or the last
batch waits for the next invocation or is lost.

## What the SDKs tell you

`@autter/runtime-node` and the relay print one line, once per process, for
each of these:

- **No key.** `initAutterServer()` without `apiKey` falls back to
  `AUTTER_RUNTIME_KEY`; with neither, it says so at startup and sends
  nothing. Earlier releases sent the header `Bearer undefined` and every
  request was refused in silence. The relay answers `500 {"error": "relay has
  no ingest key"}` so the browser's network panel shows it too.
- **The wrong kind of key.** A client or upload key given to a server SDK is
  named at startup.
- **The first refusal.** The first 401 (key refused), 403 (wrong key kind or
  origin), 404 (a route the ingester doesn't have, such as `/v1/logs` on an
  ingester older than 1.4.0) or 400 on traces, metrics, logs or relay
  forwards prints the ingester's reason, for example:

  ```text
  [autter-runtime] The ingester at https://otlp.autter.dev refused the ingest key on /v1/traces (401: invalid ingest key). Nothing is stored until it is fixed: this data is dropped. Check AUTTER_RUNTIME_KEY (a server key, autter_rt_…, for this repository). Then run: npx @autter/runtime-node verify
  ```

- **Version mismatches.** One warning per feature the ingester is too old
  for ([Version compatibility](COMPATIBILITY.md)).

`@autter/runtime-edge` warns once on a missing key and once per refused
status. Python services use the upstream OpenTelemetry exporter, which logs
failed exports itself; `compat.py doctor` and `verify` check the key.

## What the ingester tells you

- **`x-autter-ingest`** on every accepted ingest response says what the
  request became: `spans=3 occurrences=1 metric_points=2 llm_calls=0
  suppressed=0 collapsed=0 truncated_values=0 rejected=0` (logs:
  `log_records=…`; browser: `events=…`). OTLP's `partialSuccess` only
  carries rejections, so a fully accepted request answers
  `{"partialSuccess": {}}`. That empty object means nothing was rejected.
- **`partialSuccess`** names what was rejected and why when something was:
  `rejectedSpans` with an `errorMessage` such as "1 span rejected: one request
  takes at most 1000 spans; send smaller batches".
- **Refusals** carry `{"error": "…"}`: `missing ingest key`, `invalid ingest
  key`, `client keys cannot send OTLP — use a server key`, `storage
  unavailable, retry later`. A browser batch with invalid events gets
  `issues` with the field path, from the ingester and from the relay:

  ```json
  {"error": "invalid payload", "issues": [{"path": ["events", 0, "type"], "message": "expected one of exception, …, got \"error\""}]}
  ```

- **`GET /v1/verify`** (with your server key) returns this key's last
  accepted and last refused request as the ingester saw them (route, status,
  reason, error, time), and storage readiness. With a trace id,
  `GET /v1/verify/<trace id>` says what was stored for it in the last day.
  The record is kept in the ingester's memory, per process.
- **`/healthz`** (public) says whether ClickHouse accepts writes, and counts
  every drop by reason since the process started; **`/metrics`** has the
  same as Prometheus text.

## Behind a firewall or proxy

When `doctor` or `verify` can't reach the ingester, they print where the
path broke:

| Failed step | Usually |
| --- | --- |
| `dns` | A typo in the host, or a container or VPN without the right DNS |
| `tcp`, timed out | An egress firewall or security group dropping traffic to port 443, or an IPv6 address with no IPv6 route (the check tries IPv4 first) |
| `tcp`, refused | Wrong port, or nothing running there |
| `tls` | A proxy intercepting TLS: point `NODE_EXTRA_CA_CERTS` (Node) or `SSL_CERT_FILE` (Python) at its CA certificate |
| `http` | A proxy or load balancer holding the request |

Node's HTTP client, which the OTLP exporter uses, ignores `HTTPS_PROXY`. On
a network where outbound traffic must go through a proxy, allow the
ingester's host directly, or run an OpenTelemetry Collector inside the
network that can reach it.
