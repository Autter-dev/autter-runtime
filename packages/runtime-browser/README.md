# @autter/runtime-browser

The tracker also observes enforced Content Security Policy violations, failed fetch and XHR requests, HTTP 5xx responses, long tasks, and
slow resources by default. Call `captureOutcome(name, message)` for a bad
result returned without an exception. Failures include the most recent button,
link, or form action from the preceding 30 seconds. Use a stable, non-sensitive
`data-autter-action="send-email"` attribute for a useful action name; otherwise
only the element type is recorded. Set `captureActions: false` to disable this
context. Set `captureNetworkFailures: false` or `captureTimings: false` to
disable either observer. Production browser fixes
can use release keyed source maps uploaded by CI; see
`docs/CONTINUOUS-DETECTION.md` in the repository.

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

// Unhandled errors, promise rejections, and enforced CSP blocks are captured automatically.

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
| `initAutterBrowser(options)` | Installs error, rejection, CSP, and recent-action listeners; sends a session ping |
| `captureException(error, context?)` | Handled errors; fast-flushed |
| `captureMessage(message, severity?, context?)` | Warnings/info without an exception (`"warning"` default); grouped and aggregated like errors |
| `trackEvent(name, props?)` | Usage counter; aggregated server-side per minute |
| `setUser(id)` | **Opaque id only** — never an email |
| `setContext(ctx)` | Attached to subsequent events |
| `flush()` | Force-send the queue (also runs on page hide/unload) |
| `redactContext(ctx)` | Mask obvious PII in a context bag (applied to every event automatically) |

## Batching & delivery

Events queue and flush at 10 events / 5 s / page hidden / `pagehide` /
manually; errors trigger a fast flush (500 ms). Delivery uses
`navigator.sendBeacon` (JSON blob) with a `fetch(keepalive)` fallback, so
events survive page navigation. A hard cap of 200 events per session
prevents error loops from flooding.

## What is never sent

Full URLs with query strings, cookies, localStorage, DOM text, form
values, request headers/bodies, console history, IP addresses.
Routes are `location.pathname` only; filenames are query-stripped.
For CSP blocks, only the directive and blocked resource origin are retained.

Custom `context` is free-form, so it is scrubbed before send: values under
sensitive-looking keys (`email`, `password`, `token`, `secret`, `auth`,
`cookie`, `api_key`, `card_number`, …) are replaced with `[redacted]`, and
email-shaped substrings are masked inside ordinary string values. This
mirrors the server SDK's `redactAttributes`; the relay and ingester apply
the same rules as defense-in-depth.
