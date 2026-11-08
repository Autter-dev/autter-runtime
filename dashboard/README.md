# Runtime dashboard

A small UI for **local development** with Autter Runtime. It reads the
ClickHouse tables your local [OTLP ingester](../packages/otlp-ingester)
writes, so while you build you can see what your app is sending without
writing SQL.

It's a development tool only. It isn't part of the hosted Autter cloud, and
the self-hosted deploy files (`deploy/single-server`, `deploy/aws`) don't run
it.

| Page | What it shows | Tables |
| --- | --- | --- |
| **Overview** | requests, failure rate, latency, error and LLM totals; request and error charts; top routes; top issues | `runtime_metrics_1m`, `runtime_error_occurrences`, `runtime_spans`, `runtime_llm_calls` |
| **Errors** | issues grouped by fingerprint, with severity/source filters, search and sparklines. Each issue shows stack, top frames, releases, routes and recent occurrences | `runtime_error_occurrences` |
| **Events** | logs and operation events, newest first, with severity/type filters and search (including by trace id), plus `trackEvent()` counters | `runtime_logs`, `runtime_metrics_1m` |
| **Traces** | recent traces (errors only, or slower than a threshold), per-operation p50/p95, and a waterfall per trace with its errors and logs | `runtime_spans`, `runtime_error_occurrences`, `runtime_logs` |
| **LLM** | spend, calls, tokens and latency by model; recent calls | `runtime_llm_calls` |

It's read-only. Every query runs with ClickHouse `readonly=2`, a 15 s time
limit and a row cap.

## Run it

**With the repo's compose file.** This starts ClickHouse, the ingester on
`:4318` (it accepts the local key `autter_rt_local_dev_only`), and the dashboard:

```bash
docker compose up
open http://localhost:4319
```

**From the published image**, if ClickHouse and the ingester are already
running on your machine:

```bash
docker run --rm -p 127.0.0.1:4319:4319 \
  -e CLICKHOUSE_URL=http://host.docker.internal:8123 -e CLICKHOUSE_PASSWORD=dev \
  ghcr.io/autter-dev/runtime-dashboard:latest
```

**From source**, with Rust 1.93 or newer:

```bash
cd dashboard
CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_PASSWORD=dev cargo run --release
```

Send some telemetry to the ingester and reload. Events sent with the local
key land in the `local` repository. Each repository that has sent data shows
up in the picker within a minute.

## Configuration

Environment variables; the ClickHouse ones match the ingester's.

| Variable | Default | |
| --- | --- | --- |
| `CLICKHOUSE_URL` | `http://localhost:8123` | `https://` needs a build with `--features tls` |
| `CLICKHOUSE_USER` | `default` | |
| `CLICKHOUSE_PASSWORD` | empty | `dev` with the repo's compose file |
| `CLICKHOUSE_DATABASE` | `autter_runtime` | |
| `DASHBOARD_ADDR` | `127.0.0.1:4319` | the container image listens on `0.0.0.0:4319`; publish it to `127.0.0.1` as shown above |
| `DASHBOARD_BASIC_AUTH` | unset | `user:password` turns on HTTP basic auth |
| `DASHBOARD_ORG_ID` / `DASHBOARD_REPOSITORY_ID` | unset | pin to one repository; otherwise a picker lists every repository with data in the last 14 days |

The default listen address is loopback. The binary warns at startup if it's
listening anywhere else without basic auth.

## Why it's light

- **One static binary.** It's about 1.8 MB on macOS arm64, including the fonts
  and logo, and ships in a `FROM scratch` image. It runs on a single-threaded
  tokio runtime.
- **ClickHouse does the work.** Each query filters on the leading
  `ORDER BY` columns (`org_id`, `repository_id`, then fingerprint, trace id or
  time), reads only the columns it shows, and returns aggregates instead of raw
  rows. Values are bound as server-side parameters, never spliced into SQL.
  A page's queries run concurrently over pooled keep-alive connections, so
  page time is the slowest single query.
- **Cheap results.** Responses come back as `TabSeparated` and rows are
  borrowed slices of one buffer. A field is copied only when it contains an
  escape.
- **HTML that's complete on arrival.** Pages are rendered server-side with
  [maud](https://maud.lambda.xyz), whose templates compile to string pushes,
  and gzipped. There are no client-side data fetches. The single script
  (about 3 KB gzipped) draws canvas charts, handles live refresh and
  prefetches pages on hover. It's cached immutably under a content hash.
- **Bounded ClickHouse memory.** List pages never group a whole time window
  just to show its newest rows. Traces pick the newest matching spans with a
  top-N sort first, then aggregate only those traces. Events sort in exact
  reverse key order, so ClickHouse reads in index order and stops early.

### Measured

Measured on an M-series laptop, against ClickHouse 26.11 holding 10M spans,
5M logs, 2M error occurrences, 2.5M metric rows and 1M LLM calls for one
repository. Times are median wall time per page, warm:

| Page | 24 h | 7 d |
| --- | --- | --- |
| Overview | 28 ms | 76 ms |
| Errors | 29 ms | 65 ms |
| Errors, free-text search | 43 ms | 102 ms |
| Issue detail | 20 ms | 21 ms |
| Events | 10 ms | 28 ms |
| Traces | 41 ms | 79 ms |
| Trace detail | 8 ms | 8 ms |
| LLM | 8 ms | 15 ms |

The dashboard process idles at about 7 MB of memory. It peaked at 11 MB while
serving 800 pages to 16 concurrent clients, using about 1.2 ms of CPU per page
including gzip. Pages are 2–13 KB gzipped. Every query on the same data stays
under about 130 MB of ClickHouse memory.

## Branding

The logo, favicon, colours and type follow [autter.dev](https://autter.dev):

- Light theme: cream surfaces, navy ink, teal accent.
- Dark theme: zinc surfaces, teal accent.
- Fonts: Quattrocento Sans for text, Quattrocento for headings, Inconsolata
  for code.

The fonts are latin subsets bundled from `@fontsource` under the SIL Open
Font License; see [`assets/fonts/OFL.txt`](assets/fonts/OFL.txt). Together
they're about 100 KB, downloaded once and then cached. They load with
`font-display: swap`, so text never waits on them.

## Develop

```bash
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
```

The schema is owned by the ingester (`packages/otlp-ingester/src/clickhouse.ts`
and `migrations.ts`). Columns are additive within a major version, so new
columns don't break the dashboard. If a page needs a new column, add the
ingester migration first.
