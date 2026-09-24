# Memory pressure incidents

Memory pressure detection uses **OTLP/HTTP metrics from any language**. There
is no Autter SDK requirement: use the service's existing OpenTelemetry meter
provider and OTLP exporter. The Node SDK 1.3.3+ supplies these metrics
automatically; other languages must enable their runtime/process
instrumentation or emit the portable metrics below. An OTel exporter by itself
does not measure process memory. Redeploy the application after changing its
instrumentation. Self-hosted ingesters need version 1.3.3+ for memory sample
storage and `/v1/platform-events`.

## What must be running

Code in a local branch does not collect customer telemetry. Before calling
memory incidents available, publish and install the Node SDK 1.3.3+ where it
is used, deploy the 1.3.3+ ingester so its ClickHouse migrations run, and
deploy the Autter backend and frontend with the memory detector and incident
view. Then redeploy each instrumented application. For non-Node services,
configure a process metric instrument or collector that actually emits the
gauges below; the OTLP exporter only transports them. OOM/restart correlation
also requires an ECS EventBridge or Kubernetes event forwarder that sends
events to `/v1/platform-events` with the matching process instance ID. Without
that forwarder, metric-based pressure detection can still work, but Runtime
cannot know that the platform killed a process.

## Portable metric contract

Send gauges and delta or cumulative sums to `/v1/metrics` as OTLP protobuf or
JSON. Every resource needs `service.name` and a `service.instance.id` unique
to one process lifetime. Set `service.version` to the full deployed commit SHA
and `deployment.environment.name` (or `deployment.environment`) to the
environment. The Runtime server key authenticates and scopes the data to a
repository. Export every 30–120 seconds; the detector needs at least four
samples over ten minutes to recognize sustained growth. Samples remain in
ClickHouse for 14 days.

| Metric name | Instrument and unit | Meaning |
| --- | --- | --- |
| `autter.process.memory.rss` | Gauge, `By` | Current resident process memory; preferred for container pressure |
| `autter.process.memory.heap.used` | Gauge, `By` | Current managed/runtime heap; used for growth detection when RSS is unavailable |
| `autter.process.memory.limit` | Gauge, `By` | Container/task memory limit, when known |
| `autter.process.memory.heap.limit` | Gauge, `By` | Runtime heap limit, when known; distinct from container memory |
| `autter.process.memory.heap.after_gc` | Gauge, `By` | Heap sampled after a GC cycle, when the runtime exposes it |
| `autter.process.gc.count` | Sum, `{collection}` | GC collections; delta and cumulative temporality both work |
| `autter.process.gc.duration` | Sum, `ms` or `s` | Time spent in GC; delta and cumulative temporality both work |

The wire payload is ordinary OTLP. A minimal RSS export looks like this;
replace the example time, value, and resource attributes with live values:

```json
{
  "resourceMetrics": [{
    "resource": { "attributes": [
      { "key": "service.name", "value": { "stringValue": "payments-api" } },
      { "key": "service.instance.id", "value": { "stringValue": "task-42" } },
      { "key": "service.version", "value": { "stringValue": "0123456789abcdef0123456789abcdef01234567" } },
      { "key": "deployment.environment.name", "value": { "stringValue": "production" } }
    ] },
    "scopeMetrics": [{ "metrics": [{
      "name": "autter.process.memory.rss", "unit": "By",
      "gauge": { "dataPoints": [{
        "timeUnixNano": "1790244000000000000", "asInt": "536870912"
      }] }
    }] }]
  }]
}
```

Use at least RSS **or** heap used. Runtime also recognizes
`process.memory.usage` with a `type=rss`, `type=physical`, or
`type=heap_used` data-point attribute, plus the Node runtime metric names.
Do not label virtual memory, peak RSS, reserved heap, or language-specific
allocation counters as current RSS or heap used. A JVM, Go, Python, .NET, or
Rust instrument can emit the portable names above through its standard OTel
meter API; no Autter-specific wire format is needed.

### Language mapping

| Stack | Useful source for the portable gauges | GC evidence |
| --- | --- | --- |
| Node/Next.js | `@autter/runtime-node` 1.3.3+ exports RSS, V8 heap and limits automatically | GC count, duration, and a post-GC heap sample automatically |
| Python | Current process RSS from `psutil.Process().memory_info().rss` | `gc.get_stats()` collection counts; do not call `tracemalloc` usage total process heap |
| Go | `runtime.MemStats.HeapAlloc` for heap used; use an OS/process collector for RSS | `NumGC` and `PauseTotalNs` are cumulative counters |
| JVM | `MemoryMXBean.getHeapMemoryUsage()` for heap used and heap max; use an OS/process collector for RSS | `GarbageCollectorMXBean` collection count/time |
| .NET | `Process.WorkingSet64` for RSS and `GC.GetGCMemoryInfo()` for managed heap evidence | Runtime GC counters, when instrumented |
| Rust and other languages | Process RSS from an OS/process collector; runtime heap only if the allocator exposes a current-use gauge | Only emit GC metrics for runtimes that actually have GC |

For Python, install `psutil` and, after configuring the existing OTel meter provider, a current
RSS gauge can be added without a second provider:

```python
import psutil
from opentelemetry import metrics
from opentelemetry.metrics import Observation

process = psutil.Process()  # create in each worker after fork
meter = metrics.get_meter("autter-process-memory")
meter.create_observable_gauge(
    "autter.process.memory.rss",
    callbacks=[lambda options: [Observation(process.memory_info().rss)]],
    unit="By",
)
```

Set the resource identity on that same provider, for example:

```bash
OTEL_SERVICE_NAME=payments-api
OTEL_RESOURCE_ATTRIBUTES="service.instance.id=${PROCESS_INSTANCE_ID},service.version=${GIT_SHA},deployment.environment.name=production"
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.autter.dev
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ${AUTTER_RUNTIME_KEY}"
```

`PROCESS_INSTANCE_ID` must be set separately for each process. On ECS use a
task/container ID; on Kubernetes use a pod UID **plus container restart count**
or container ID. The event forwarder must report the same ID. Multiple
workers in one pod need different IDs. For Node, pass `instanceId` to
`initAutterServer` or set `AUTTER_RUNTIME_INSTANCE_ID`.

This OTLP resource and metric contract is the same for Go, Rust, Java, .NET,
Ruby, PHP, and other OTel SDKs. Configure a metric exporter as well as the
trace exporter, and reuse the application's existing provider. Language setup
guidance is in [Integrations](INTEGRATIONS.md) and the corresponding
`autter-skills` style skill.

## OOM and restart events

An OOM kill cannot be reported by the process after it dies. Configure your
ECS EventBridge or Kubernetes event forwarder to POST the platform event to
`<Runtime ingest URL>/v1/platform-events` using a **server Runtime key**:

```json
{
  "service": "payments-api",
  "environment": "production",
  "release": "<deployment SHA>",
  "instanceId": "<service.instance.id of the killed process>",
  "platform": "ecs",
  "kind": "oom_kill",
  "occurredAt": "2026-09-24T10:00:00.000Z"
}
```

Use `kind=restart` for a restart, and `platform=kubernetes` for Kubernetes.
The instance ID must match the OTLP resource ID of the process that exited.
Send the request as JSON with `Authorization: Bearer <server Runtime key>`.
The key scopes events to one repository; never put it in browser code.
Duplicate deliveries are keyed by the event content. Events remain for 30 days.

The memory sweep checks recent samples every ten minutes. An OOM event opens
an exhaustion incident even when the final sample is missing. Sustained RSS
or heap growth, or high usage relative to the corresponding limit, can open an
incident. Growing post-GC heap is labelled **suspected leak**, not proven.
The incident shows process memory, service request volume, restart/OOM
events, and the release. It recommends increasing the memory limit to protect
availability when appropriate, then investigating retained objects.

## Profiles and draft fixes

For source-level diagnosis, upload a symbolized pprof **in-use heap** profile
to `/v1/profiles`, with `x-autter-service`, `x-autter-environment`,
`x-autter-release`, and `x-autter-instance-id` matching the memory metrics.
Runtime stores sampled frames for seven days. A draft fix is considered only
when the release is a full Git commit SHA, the in-use profile contains source
locations that match indexed repository files, those files are unchanged on
the target branch, and the existing fix agent can justify a specific change.
No profile or no matching source produces a visible skip reason. Draft fixes
are never merged or deployed automatically.
