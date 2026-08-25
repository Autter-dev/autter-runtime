# @autter/runtime-browser

Tiny, dependency-free browser error + usage tracker for Autter Runtime.
**~1 KB brotlied** (5 KB CI budget), zero runtime dependencies, no OTel SDK,
no console patching, no DOM recording, no offline storage.

## Install

```bash
npm install @autter/runtime-browser
```

## Usage

```ts
import { initAutterBrowser, captureException, trackEvent } from "@autter/runtime-browser";

initAutterBrowser({
  endpoint: "/api/autter-runtime",   // your same-origin relay — never a key in the browser
  service: "web-app",
  environment: "production",
  release: "e4a218f",                // e.g. a git SHA
});

// Unhandled errors and promise rejections are captured automatically.

// Handled errors:
try {
  await startCheckout();
} catch (error) {
  captureException(error, { operation: "start-checkout" });
  throw error;
}

// Coarse usage counters (no PII in props):
trackEvent("clicked_cta");
```

Two ways to deliver events:

**Relay (recommended when you have a backend)** — `endpoint` points at a
route on your own backend created with `createBrowserRelayHandler` from
[`@autter/runtime-node`](../runtime-node). No key in the browser at all.

**Direct (static sites, SPAs without a backend)** — point at the ingester
with a **publishable client key** (`autter_rtc_…`, scope `client`). Client
keys only work on the browser endpoint, are origin-restricted server-side,
and rate-limited harder — never ship a secret `autter_rt_` server key:

```ts
initAutterBrowser({
  endpoint: "https://otlp.autter.dev/v1/browser",
  clientKey: "autter_rtc_xxxxxxxx",
  service: "marketing-site",
});
```

## API

| Function | Notes |
| --- | --- |
| `initAutterBrowser(options)` | Installs `error`/`unhandledrejection` listeners, sends a session ping |
| `captureException(error, context?)` | Handled errors; fast-flushed |
| `captureMessage(message, severity?, context?)` | Warnings/info without an exception (`"warning"` default); grouped and aggregated like errors |
| `trackEvent(name, props?)` | Usage counter; aggregated server-side per minute |
| `setUser(id)` | **Opaque id only** — never an email |
| `setContext(ctx)` | Attached to subsequent events |
| `flush()` | Force-send the queue with acknowledged, bounded retries |
| `getDeliveryStats()` | Accepted, acknowledged, beacon-accepted, pending, and dropped counts |

## Batching & delivery

Events queue and flush at 10 events / 5 s / manually; errors trigger a fast
flush (500 ms). Ordinary delivery uses acknowledged `fetch(keepalive)` with
three bounded retries. Page hide/unload uses `navigator.sendBeacon` as a
last chance. A configurable 200-event page-lifecycle cap and 20-copy
per-error cap prevent loops from flooding; `onDrop` and `getDeliveryStats()`
make every SDK-side drop observable. Delivery refusals carry the server's
reason (`onDrop`'s third argument, e.g. `"invalid ingest key"`) and are not
retried — only rate limits (429), transient upstream failures (5xx) and
network errors are.

## What is never sent

Full URLs with query strings, cookies, localStorage, DOM content, form
values, request headers/bodies, console history, emails, IP addresses.
Routes are `location.pathname` only; filenames are query-stripped.
