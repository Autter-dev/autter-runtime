# Operation logging and diagnostic context

Operation logging starts in `@autter/runtime-node` and `@autter/runtime-next`
version **1.4.0**. Update the ingester to **1.4.0** before upgrading SDKs: it creates
`runtime_logs` through migration `0011-runtime-logs` and accepts `/v1/logs`.

**1.5.0** (ingester 1.5.0 first) adds request summaries, `runtimeContext`, inline
messages, `kind` on every summary, coded errors, `fork`/carriers, the AI rollup,
`waitUntil`, sinks and logger-only mode — all additive; a golden test proves a
1.4.0 operation still exports the same OTLP JSON apart from the two new summary
keys. Request-level features are documented in
[REQUESTS-AND-ERRORS.md](REQUESTS-AND-ERRORS.md).

## Node and Next.js

Initialize `initAutterServer` once, before the application starts. For Next.js,
use `registerAutter` in `instrumentation.ts` and import the APIs below from
`@autter/runtime-next/server`. Use the Node runtime; these APIs use Node's async
context and do not run in the browser or an edge worker (edge runtimes use
`@autter/runtime-edge`, which passes the context explicitly). Apps that run their
own OpenTelemetry SDK can use `initAutterLogging` instead of `initAutterServer`.

```ts
import {
  initAutterServer, withRuntimeOperation, runtimeLogger,
} from "@autter/runtime-node";

const runtime = initAutterServer({
  apiKey: process.env.AUTTER_RUNTIME_KEY!,
  service: "payments-api",
  release: process.env.GIT_SHA,
  logging: { console: false, minLevel: "info" },
});

await withRuntimeOperation("checkout", async (operation) => {
  operation.setContext({ "payment.provider": "stripe", "cart.item_count": 3 });
  await operation.step("reserve_inventory", () => reserveInventory());
  const payment = await operation.step("confirm_payment", () => confirmPayment());
  runtimeLogger.info("Payment confirmation returned", { "payment.attempts": 2 });
  if (!payment.confirmed) {
    operation.outcome("failed", "Payment was not confirmed; no order created");
    return;
  }
  await operation.step("create_order", () => createOrder(payment));
});

// Flush at the end of a short-lived invocation; shutdown before process exit.
await runtime.shutdown();
```

`withRuntimeOperation(name, fn, attributes?, options?)` runs the callback in an always-recorded
process span and emits one completed operation summary (`autter.operation.kind =
"operation"`; request middleware emits `"request"` summaries). `options.from`
continues work from a `runtimeContext.carrier()` (parent link, request id, and an
OTel span link to the producer trace); `options.waitUntil` receives the log flush
promise once the summary is emitted. It returns the callback's
result and rethrows its original error. An unhandled callback error records an
exception in the trace; the log summary is related evidence, not a second issue.

`operation.setContext(attributes)` merges redacted nested context (arrays are
replaced) and adds attributes to the operation and
its active span. `operation.step(name, fn)` records the step result and elapsed
time; it rethrows failures. A caught step error can be recovered by application
code: the final outcome follows the callback's result or an explicit outcome.
Up to 64 steps are recorded. Log names and context should describe the operation,
not contain request bodies, payment data, or personal information.
`RuntimeLogContext` supports nested objects, arrays and scalar values; standard
trace attributes encode structured values as JSON for OTLP compatibility.

`operation.outcome(status, message?)` accepts `succeeded`, `failed`, `degraded`,
`cancelled`, and `pending`. The default is `succeeded` when the callback returns.
Returning normally is not proof of business success: declare an outcome when
the intended result was not achieved. An explicit `failed` outcome also emits
the existing `autter.outcome` trace event, including the reporting call site.
`pending` means the operation has not confirmed its downstream result.

`createRuntimeLogger(attributes?)` creates a logger with `debug`, `info`, `warn`,
and `error` methods. `runtimeLogger` is the default instance; `runtimeContext`
exposes the same methods plus `set`, `outcome`, `id`, `requestId`, `fork` and
`carrier` for the current operation from anywhere in its call tree.

**Inline messages (1.5.0).** Inside an operation, `debug` and `info` messages are
folded into its summary as `autter.operation.logs` — `{ t, level, message,
attrs? }`, `t` in milliseconds since the operation started — instead of being
exported as separate records. `warn` and `error` are folded **and** exported.
`autter.operation.level` is the highest level seen (including a failed outcome).
Disable with `logging.inline: false` to get 1.4.0's one-record-per-message
behaviour. Outside an operation every message is its own record, as before. `error` records
diagnostic context; use `captureException` for exception grouping or declare a
failed operation outcome for business-failure grouping. Logs inherit the
active operation ID, name, parent operation ID, and application attributes, plus
the active OTel trace/span IDs. Concurrent operations keep separate contexts.
Async context does not cross a queue or process by itself: put
`runtimeContext.carrier()` in the job payload and pass it as
`withRuntimeOperation(name, fn, {}, { from: payload.autter })` in the consumer.
`runtimeContext.fork(name, fn)` links a child to its parent even when the child
outlives it; `runInBackground(name, fn)` does the same without awaiting.

## Collection and privacy

- Logs are OTLP/HTTP log records. Both OTLP JSON and protobuf are accepted.
  evlog and other OTLP log exporters can use `/v1/logs` with a server ingest key.
- Source attributes are bounded and scrubbed again at ingestion. Tenant identity
  comes from the validated key, never the supplied event. Client/browser keys
  cannot send server logs.
- Redaction applies before console output and export. Never intentionally send
  secrets or personal data; pattern-based redaction cannot identify every secret.
- `logging.minLevel` filters ordinary messages (folded or not); completed
  operation summaries are retained independently. `logging.console` defaults to
  true and can be disabled without disabling export. Console output is JSON
  lines (as in 1.4.0) when `NODE_ENV=production` and a compact tree elsewhere;
  `logging.sinks` replaces the default sinks, and `logging.file` controls the
  local `.autter/runtime/*.jsonl` files (on by default only in development).
- Summaries are never sampled. Inline messages are capped at 50 per operation
  (`autter.operation.logs_truncated` marks the rest), 300 characters each and
  about 6 KB per operation, and are placed last in the context budget so they
  never crowd out operation context.
- Logs batch in memory (up to 1,000 records or 4 MiB, whichever comes first).
  Requests contain up to 50 records or 512 KiB. Context has depth, field, step
  and string limits; truncated context is marked. Each flush has a 10-second
  budget and makes at most three attempts per batch. Failed batches remain
  buffered for a later flush, with automatic retry intervals up to 30 seconds. Buffer overflow and failed shutdown delivery are
  reported. `flushRuntimeLogs()` rejects if delivery fails, and
  `runtimeLogStats()` reports buffered and dropped counts. This is best-effort
  telemetry, not durable delivery or an audit log.
- Records expire after 14 days by default (`LOG_TTL_DAYS` on ingester 1.5.0+). Successful operation counts represent captured
  summaries, not a guarantee that every application operation was observed.

## Investigation and fixes

Autter's repository Runtime Logs view displays captured messages, operation
summaries, outcomes, steps, and trace IDs. Investigation readers retrieve related
logs and spans using captured IDs and compare bounded successful operations.
They disclose unavailable sources and truncation. Event text is untrusted
diagnostic evidence, never instructions to an agent. Business context improves
an investigation but does not establish a cause by itself.

The observations feed the existing root-cause analysis and draft-fix pipelines,
which retain their repository settings, source checks and validation rules. A reported outcome call site can locate the reporting code; it is not
proof that this location caused the failure. The fix agent must confirm the
cause, reproduce applicable conditions, and validate the intended result.

Log and trace exporters are independent. Operation evidence may arrive after an
initial analysis; refresh the evidence panel or rerun analysis to incorporate
later arrivals. Shutdown attempts log export before closing tracers. Regular Runtime flushing
exports logs and traces independently so a failed log export does not block
exception telemetry.
