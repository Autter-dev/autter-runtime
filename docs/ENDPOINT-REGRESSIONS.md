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

A request is slow when its root server span takes longer than both 500 ms and its route's rolling p95. The SDK keeps that estimate per method and route template, in the process, from every request it served in the last few minutes (sampled or not; older requests count half every 5 minutes). Until a route has about 20 recent requests, only the 500 ms floor applies. The 500 ms floor matches the detector's rule that a regression adds at least 500 ms, so no faster request could be the evidence for one.

Slow traces are rate limited so a slow incident can't flood export: at most `retainSlowTracesPerMinute` (default 60) a minute per process, in bursts of up to 20, and at most a sixth of that per route. When the budget is spent, slow requests fall back to head sampling.

Every exported request span says why it was kept, in `autter.retention_reason`:

- `head`: the random head sample. Use these for "normal" behaviour.
- `slow`: kept because the request was slow.
- `error`: kept because the trace had an error.

Spans kept by tail retention (`slow` and `error`) also carry `autter.tail_retained = true`. The ingester counts no request from them, because the histogram already counts each one.

Overrides:

```ts
initAutterServer({ ..., retainTracesAboveMs: 2000 });      // fixed threshold, no per-route estimate
initAutterServer({ ..., retainTracesAboveMs: false });     // no slow traces (0 works too)
initAutterServer({ ..., retainSlowTracesPerMinute: 600 }); // a larger budget
```

Up to 1.11, slow-trace retention was off unless `retainTracesAboveMs` was set, and it applied to any server span. It now applies to the local root server span only.

The buffer has per-trace, total-span, trace-count, and time limits. Retention is best effort, not a guarantee of a complete distributed trace. It does not retain spans from another process. Requests longer than the buffer lifetime (30 s) or high traffic can produce partial traces.

The SDK adds a process instance ID and explicit request histogram bounds through two minutes. Add the required database or dependency instrumentation through the existing `instrumentations` option. HTTP instrumentation alone cannot measure every database call or connection wait.

## Edge functions

`@autter/runtime-edge` sends no metrics, but its request summaries cover every request and are never sampled. The ingester builds latency histogram points from the summaries marked `autter.request.counted_by = "summary"` (the default; `countRequests: false` turns it off), one per service, environment, release, method, route and minute of a batch, with the same bucket bounds as the Node SDK. A summary needs `http.request.method` and a route. A retried batch replaces its points. Node and Next.js summaries are never used here, because their histograms already count each request.

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
