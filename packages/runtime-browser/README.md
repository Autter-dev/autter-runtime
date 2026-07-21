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

The `endpoint` should be a route on **your own backend** created with
`createBrowserRelayHandler` from
[`@autter/runtime-node`](../runtime-node) — the private ingest key stays
server-side and there is nothing to configure for CORS or CSP.

## API

| Function | Notes |
| --- | --- |
| `initAutterBrowser(options)` | Installs `error`/`unhandledrejection` listeners, sends a session ping |
| `captureException(error, context?)` | Handled errors; fast-flushed |
| `trackEvent(name, props?)` | Usage counter; aggregated server-side per minute |
| `setUser(id)` | **Opaque id only** — never an email |
| `setContext(ctx)` | Attached to subsequent events |
| `flush()` | Force-send the queue (also runs on page hide/unload) |

## Batching & delivery

Events queue and flush at 10 events / 5 s / page hidden / `pagehide` /
manually; errors trigger a fast flush (500 ms). Delivery uses
`navigator.sendBeacon` (JSON blob) with a `fetch(keepalive)` fallback, so
events survive page navigation. A hard cap of 200 events per session
prevents error loops from flooding.

## What is never sent

Full URLs with query strings, cookies, localStorage, DOM content, form
values, request headers/bodies, console history, emails, IP addresses.
Routes are `location.pathname` only; filenames are query-stripped.
