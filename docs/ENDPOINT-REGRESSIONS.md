# Endpoint regression telemetry

The ingester stores request-duration histogram buckets for endpoint regression detection. The Autter backend uses these buckets to compare recent p95 with a baseline. Histograms count every request, whatever is sampled. Traces are used only to explain individual requests: a normal one and a slow one.

## Node setup

`@autter/runtime-node` (and `@autter/runtime-next`, which runs it) sends the histograms and keeps slow traces by default. Set a release so recent and baseline windows can be told apart:

```ts
initAutterServer({
  apiKey: process.env.AUTTER_RUNTIME_KEY,
  service: "api",
  environment: "production",
  release: process.env.GIT_SHA,
});
```

What is exported for each request:

| | Default | Option |
| --- | --- | --- |
| Request-duration histogram point | Every request (delta, explicit buckets through 120 s) | not sampled |
| Trace, random sample | 1% | `traceSampleRate` |
| Trace of a request with an error | 100%, the whole local trace | `retainTracesOnError` |
| Trace of a slow request | the whole local trace, rate limited (below) | `retainTracesAboveMs`, `retainSlowTracesPerMinute` |

A request is slow when its root server span takes longer than both 500 ms and its route's p95 baseline. The SDK keeps that baseline per method and route template, in the process, from every request it served (sampled or not; older requests count half every 15 minutes). Until a route has about 20 recent requests, only the 500 ms floor applies. A regression does not absorb the baseline: when a tenth of the route's requests in the last minute or so are above it, those requests stop feeding it, and from a fifth the baseline is frozen. A route that becomes and stays slow therefore keeps a steady sample of slow traces, up to its share of the budget every minute, instead of only the first few; after an hour regressed, the baseline adopts the new latency. The baseline is per process: a process that starts already slow (a deploy that regressed) has no healthy baseline to compare with. The 500 ms floor matches the detector's rule that a regression adds at least 500 ms, so no faster request could be the evidence for one.

Slow traces are rate limited so a slow incident can't flood export: at most `retainSlowTracesPerMinute` (default 60) a minute per process, in bursts of up to 20, and at most a sixth of that per route. When the budget is spent, slow requests fall back to head sampling.

Every exported request span says why it was kept, in `autter.retention_reason`:

- `head`: the random head sample. Use these for "normal" behaviour.
- `slow`: kept because the request was slow.
- `error`: kept because the trace had an error.

Spans kept by tail retention (`slow` and `error`) also carry `autter.tail_retained = true`. The ingester counts no request from them (either mark is enough), because the histogram already counts each one. Anything that estimates counts, rates or percentiles from stored spans must use only random samples (`head`, or no reason for other senders); the regression evidence prefers `slow` traces for the slow request.

Overrides:

```ts
initAutterServer({ ..., retainTracesAboveMs: 2000 });      // fixed threshold, no per-route estimate
initAutterServer({ ..., retainTracesAboveMs: false });     // no slow traces (0 works too)
initAutterServer({ ..., retainSlowTracesPerMinute: 600 }); // a larger budget
```

Up to 1.11, slow-trace retention was off unless `retainTracesAboveMs` was set, and it applied to any server span. It now applies to the local root server span only.

The buffer has per-trace (512 spans), total-span (10,000), byte (about 16 MB), trace-count and idle-time (60 s without a span) limits. Over its budget it drops the newest in-flight traces whole, so the oldest requests, the likeliest to end slow, keep their child spans; a dropped trace, or one over 512 spans, is never exported, not even in part. Retention is best effort, not a guarantee of a complete distributed trace. It does not retain spans from another process.

The SDK adds a process instance ID and explicit request histogram bounds through two minutes. Add the required database or dependency instrumentation through the existing `instrumentations` option. HTTP instrumentation alone cannot measure every database call or connection wait.

## Edge functions

`@autter/runtime-edge` sends no metrics, but its request summaries cover every request and are never sampled. The ingester builds latency histogram points from the summaries marked `autter.request.counted_by = "summary"` (the default; `countRequests: false` turns it off), with the same bucket bounds as the Node SDK. runtime-edge exports once per request, so the ingester adds summaries in memory to one point per service, environment, release, method, route and minute, across batches, and writes the point about 15 seconds after the minute ends (and at shutdown). A retried batch adds nothing twice (it goes through the request's insert receipts, and a record already in an open point is skipped); a late summary for a minute already written becomes a second point for it, and readers sum a minute's points. A summary needs `http.request.method` and a route. It is left out, and counted as a `latency_summary_invalid` drop, without its own timestamp, with a timestamp more than 2 hours old or 5 minutes ahead, or with a duration that is missing, negative, not a number or over 15 minutes. Each service and environment gets at most 200 routes in 10 minutes (`latency_routes_over_limit` past that). A route of a service that also sends Node histograms for it gets no edge points, so its requests are not counted twice. Node and Next.js summaries are never used here, because their histograms already count each request. An ingester crash loses the open minutes' edge points (the summaries stay in `runtime_logs`, the request counts in `runtime_metrics_1m`).

## External OTel exporters

Send explicit-bucket histograms with delta temporality:

Use ingester 1.3.1 or later (`npx @autter/runtime-node doctor` checks it; see [Version compatibility](COMPATIBILITY.md)). Version 1.3.0 does not correctly accept numeric delta temporality. OTLP delta is `1` (or `AGGREGATION_TEMPORALITY_DELTA`); cumulative is `2` and is not accepted for detection.

- `http.server.request.duration` uses seconds.
- `http.server.duration` uses milliseconds.
- Include route templates, HTTP methods, service, environment, release, and a unique service instance ID.
- Export at least once every two minutes. Include start and end timestamps, count, sum, bucket counts, and explicit bounds.
- Choose bounds above the longest latency that you need to detect.

Cumulative histograms, missing methods or routes, invalid counts, and intervals longer than two minutes are not stored in the detection table. When both duration instrument names appear in one resource batch, the stable instrument takes precedence.

The ingester never derives these histograms from spans: spans are sampled, and a p95 from a 1% sample is not one. A sender with spans and no histograms gets no regression detection. To keep slow traces from another OTel SDK, use a tail-sampling step that keeps them, such as the OpenTelemetry Collector `tail_sampling` processor with a `latency` policy (and a `status_code` policy for errors). Spans without `autter.retention_reason` can be picked as the normal request too, as long as they succeeded and were no slower than the baseline p95.

## Storage and release order

Migration `0005-latency-histograms` adds `runtime_latency_histograms`. The table stores authenticated organization and repository IDs. Stable point identities and query-time deduplication prevent retries from adding the same histogram twice.

Deploy the ingester before the updated backend. Install `@autter/runtime-node` 1.12.0 or later for default slow-trace retention and `autter.retention_reason`; earlier versions keep slow traces only with a positive `retainTracesAboveMs`. Edge histograms need the ingester release that builds them from request summaries. Configure release commit SHAs before the incident occurs. The backend rollout is controlled separately by the `runtime-endpoint-regressions` PostHog flag.

Old spans do not have the method field required for exact trace comparison. Old histograms cannot be rebuilt from count and sum rollups. Allow time for fresh baseline data after the upgrade.

The browser SDK is unchanged. No request bodies, SQL statements, headers, or secrets are added to this telemetry path. The span method is retained for endpoint matching. Exported spans also carry `autter.retention_reason` (`head`, `slow` or `error`), and tail-retained ones `autter.tail_retained`.
