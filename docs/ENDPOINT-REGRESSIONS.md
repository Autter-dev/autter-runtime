# Endpoint regression telemetry

The ingester stores request-duration histogram buckets for endpoint regression detection. The Autter backend uses these buckets to compare recent p95 with a baseline. Sampled or selectively retained traces are used only to explain individual requests.

## Node setup

Add the following settings to the existing server initialization. Do not initialize another SDK.

```ts
initAutterServer({
  apiKey: process.env.AUTTER_RUNTIME_KEY,
  service: "api",
  environment: "production",
  release: process.env.GIT_SHA,
  retainTracesAboveMs: 2000,
});
```

`retainTracesAboveMs` is opt-in. A positive value retains finished spans from the local trace when a server request meets that duration. Zero or an omitted value leaves successful-request retention unchanged. Error retention keeps its existing setting.

The buffer has per-trace, total-span, trace-count, and time limits. Retention is best effort, not a guarantee of a complete distributed trace. It does not retain spans from another process. Requests longer than the buffer lifetime or high traffic can produce partial traces. Set a threshold that fits the endpoint and observe export volume before wider use.

The SDK adds a process instance ID and explicit request histogram bounds through two minutes. Add the required database or dependency instrumentation through the existing `instrumentations` option. HTTP instrumentation alone cannot measure every database call or connection wait.

## External OTel exporters

Send explicit-bucket histograms with delta temporality:

Use ingester 1.3.1 or later. Version 1.3.0 does not correctly accept numeric delta temporality. OTLP delta is `1` (or `AGGREGATION_TEMPORALITY_DELTA`); cumulative is `2` and is not accepted for detection.

- `http.server.request.duration` uses seconds.
- `http.server.duration` uses milliseconds.
- Include route templates, HTTP methods, service, environment, release, and a unique service instance ID.
- Export at least once every two minutes. Include start and end timestamps, count, sum, bucket counts, and explicit bounds.
- Choose bounds above the longest latency that you need to detect.

Cumulative histograms, missing methods or routes, invalid counts, and intervals longer than two minutes are not stored in the detection table. When both duration instrument names appear in one resource batch, the stable instrument takes precedence.

## Storage and release order

Migration `0005-latency-histograms` adds `runtime_latency_histograms`. The table stores authenticated organization and repository IDs. Stable point identities and query-time deduplication prevent retries from adding the same histogram twice.

Deploy the ingester before the updated backend. Publish and install the updated Node SDK to use the retention option. Configure release commit SHAs before the incident occurs. The backend rollout is controlled separately by the `runtime-endpoint-regressions` PostHog flag.

Old spans do not have the method field required for exact trace comparison. Old histograms cannot be rebuilt from count and sum rollups. Allow time for fresh baseline data after the upgrade.

The browser SDK is unchanged. No request bodies, SQL statements, headers, or secrets are added to this telemetry path. The span method is retained for endpoint matching; no other new span attributes are stored.
