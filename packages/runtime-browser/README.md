# @autter/runtime-browser

The tracker also observes enforced Content Security Policy violations, failed fetch and XHR requests, HTTP 5xx responses, long tasks, and
slow resources by default. Call `captureOutcome(name, message)` for a bad
result returned without an exception. Failures include a coarse browser and
operating system, the most recent button, link, or form action from the
preceding 30 seconds, and a short trail of route changes and those actions.
Exceptions and CSP blocks also include the script URLs on the page, with query
strings removed. A cross-origin `Script error` is flagged when the browser
hides the throwing file; the script list is the set that was loaded, not the
hidden origin. Use a stable, non-sensitive
`data-autter-action="send-email"` attribute for a useful action name; otherwise
only the element type is recorded. Set `captureActions: false` to disable this
context. Set `captureNetworkFailures: false` or `captureTimings: false` to
disable either observer. Production browser fixes
can use release keyed source maps uploaded by CI; see
`docs/CONTINUOUS-DETECTION.md` in the repository.

Tiny, dependency-free browser error + usage tracker for Autter Runtime.
**~4 KB brotlied** (5 KB CI budget), zero runtime dependencies, no OTel SDK,
no console patching, no DOM recording, no offline storage. ESM only (the
package has no CommonJS build; bundlers and `require(esm)`-capable Node
resolve the `default` export condition).

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

## Coded errors and request ids (1.4.0)

`captureException` — and the automatic error and rejection listeners — read
declared fields off **any** thrown value, so existing error classes with a
`code` property benefit without changes:

| Error property | Sent as | Rule |
| --- | --- | --- |
| `code` | `autter.error.code` | Must match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$`, ≤80 chars (`billing.declined`); otherwise not sent (`ECONNRESET` is not a code) |
| `why` / `fix` | `autter.error.why` / `.fix` | Declared cause / remedy, first 1000 chars |
| `link` | `autter.error.link` | `http(s)://` only, ≤500 chars |
| `expected` | `autter.error.expected` | `true` marks an expected business failure (recorded, never pages) |
| `requestId` | `autter.request.id` | `^[\w.-]{8,128}$` |

A valid code groups the error by **code** (one code = one issue across the
browser, the server SDKs and external sources) instead of by message.

`autterErrorFromResponse(response)` turns a failed `fetch` Response into such
an error. It reads the `{ "error": { message, code, why, fix, link, requestId } }`
body produced by `autterErrorResponse()` / `toClientError()` in
`@autter/runtime-node` (from a clone — you can still read the body), and falls
back to the status text and the `x-request-id` header:

```ts
const res = await fetch("/api/checkout", { method: "POST", body });
if (!res.ok) {
  const error = await autterErrorFromResponse(res); // name "HttpResponseError", .status, .code, …
  captureException(error);
  throw error;
}
```

Failed requests observed automatically (fetch/XHR 5xx) carry the response's
`x-request-id` header as `autter.request.id`, so the browser failure links to
the server's request summary without browser tracing. Cross-origin APIs must
expose the header (`Access-Control-Expose-Headers: x-request-id`) for the
page to read it.

## API

| Function | Notes |
| --- | --- |
| `initAutterBrowser(options)` | Installs error, rejection, CSP, and recent-action listeners; sends a session ping |
| `captureException(error, context?)` | Handled errors; fast-flushed; duck-types `code/why/fix/link/expected/requestId` |
| `autterErrorFromResponse(response)` | `Promise<Error>` from a failed Response's JSON error body (or status text) |
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

Full URLs with query strings, the raw User-Agent header, cookies,
localStorage, DOM text, form values, request headers/bodies, console history,
IP addresses, and CSP policy text. Routes are `location.pathname` only.
Browser and OS are a family plus major version. Filenames and script URLs are
query-stripped. For CSP blocks, the directive, blocked resource origin, script
path, and a short policy hash are retained. Of response headers, only
`x-request-id` is read, and only on failed (5xx) requests.

Custom `context` is free-form, so it is scrubbed before send: values under
sensitive-looking keys (`email`, `password`, `token`, `secret`, `auth`,
`cookie`, `api_key`, `card_number`, …) are replaced with `[redacted]`, and
email-shaped substrings are masked inside ordinary string values. This
mirrors the server SDK's `redactAttributes`; the relay and ingester apply
the same rules as defense-in-depth.
