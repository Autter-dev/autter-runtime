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
disable either observer. An `Error` passed to `console.error` is captured as a
caught exception with the rest of the line as context (on by default; an error
already sent via `captureException`, e.g. from an error boundary, is not sent
twice) — set `captureLoggedErrors: false` to leave `console.error` untouched.
Production browser fixes
use source maps uploaded by CI. From 1.6.0, with `@autter/runtime-cli`, exceptions
also carry `debugIds` for the scripts in their stack, read from the
`globalThis._autterDebugIds` registry its injected snippet fills, so maps match
the exact build whatever `release` says; see `docs/SOURCE-MAPS.md` in the
repository.

Tiny, dependency-free browser error + usage tracker for Autter Runtime.
**~4 KB brotlied** (10 KB CI budget), zero runtime dependencies, no OTel SDK,
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

## Breadcrumbs: the steps before an error (opt-in)

```ts
import { initAutterBrowser } from "@autter/runtime-browser";
import { enableBreadcrumbs, addBreadcrumb } from "@autter/runtime-browser/breadcrumbs";

initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" });
enableBreadcrumbs();                 // or enableBreadcrumbs({ console: false })

addBreadcrumb({ message: "Opened checkout", data: { items: 3 } });
```

The last 30 steps are kept and sent, oldest first, as `breadcrumbs` on
exceptions, unhandled rejections, request failures, error messages and
outcomes. The issue page shows them as "Steps before the error", and the root
cause analysis reads them.

| Type | Recorded from | Message, data |
| --- | --- | --- |
| `request` | every fetch/XHR the tracker sees (not its own) | `POST /api/cart 404`; `method`, `path` (no query), `status` (`0` = network error), `durationMs`; level `error` for 5xx/network, `warning` for 4xx |
| `navigation` | `pushState` / `replaceState` / `popstate` | the new path; `from`, `to` |
| `click` | the recent-action listener | `click:checkout` (`data-autter-action`, else the element type) |
| `console` | `console.warn` / `console.error` (opt out with `{ console: false }`) | the arguments joined; level `warning` / `error` |
| `custom` (or any type) | `addBreadcrumb({ type?, message, level?, data? })` | at most 10 data keys of strings, numbers, booleans or null |

Messages (≤ 500 characters) and data values (≤ 200) are scrubbed with
`scrubText` / `redactContext` like the rest of the event. The console
wrappers keep and call the originals, and a call made while a breadcrumb is
being recorded is never recorded again. Breadcrumbs never crowd out the
errors they explain: each event carries at most 8 KB of them and a burst of
errors at most 24 KB per 5 seconds, so a batch stays under the 64 KB beacon
limit. `clearBreadcrumbs()` forgets them (e.g. on logout).

They live in their own import because console patching and the buffer
(~1 KB brotlied) stay out of the main tracker to keep it small, and the main
bundle promises no console patching. The 1.4 `autter.trail` context is still
sent. Needs ingester 1.6.0 (older ingesters ignore the field); through a
relay, `@autter/runtime-node` 1.6.0 forwards it.

## Fingerprint override

Errors group by their stack and message by default. To decide the grouping
yourself, pass a `fingerprint`: every error that carries the same one becomes
**one issue** (per service and environment), whatever its message or stack.

```ts
captureException(error, { fingerprint: ["checkout", "card-timeout"] });
captureException(error, { fingerprint: "chunk-load" }); // a single string works too

initAutterBrowser({
  ...,
  beforeSend(event) {
    if (event.errorType === "ChunkLoadError") event.fingerprint = "chunk-load";
    return event;
  },
});
```

A string, or up to 10 strings of at most 200 characters each (longer values
are cut, extra values dropped). It is sent as the event's `fingerprint` field,
never as context; the relay and the ingester scrub and bound it again. Needs
ingester 1.6.0+; older ingesters ignore it. For grouping rules you can change
without a deploy, use the repository's Runtime settings in Autter.

## Trace propagation (1.6.0, opt-in)

`@autter/runtime-browser/tracing` adds a W3C `traceparent` header
(`00-<trace id>-<span id>-00`) to `fetch` and `XMLHttpRequest` requests, so
the server continues the browser's trace and a browser failure links to the
server spans and request summary of the same request.
`@autter/runtime-node` (OpenTelemetry HTTP instrumentation) continues it with
no setup. It is a separate import because it does not fit the main tracker's
10 KB budget (about 0.6 KB more, brotlied):

```ts
import { initAutterBrowser } from "@autter/runtime-browser";
import { enableTracePropagation } from "@autter/runtime-browser/tracing";

initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" });
enableTracePropagation({
  tracePropagationTargets: ["https://api.example.com/", /^https:\/\/[a-z-]+\.internal\.example\.com\//],
});
```

| Event | `traceId` |
| --- | --- |
| `request_failure` (5xx or network error) | the trace id its own request sent |
| `exception` / `unhandled_rejection` | the trace id of the request that most recently finished or failed, when that was at most 5 s earlier and that request was traced |

Rules:

- **Same-origin requests always get a header; cross-origin requests only
  when listed** in `tracePropagationTargets` (a string matches as a URL
  prefix, a RegExp is tested against the full URL). A third-party API never
  sees a new CORS preflight.
- **An existing `traceparent` is never overwritten.** If your code (or another
  library) already set one on the request, it is sent as is and its trace id
  is used on the event.
- **The header is unsampled (`-00`)**: the browser makes no sampling decision.
  `@autter/runtime-node` 1.6.0 head-samples such requests at its own
  `traceSampleRate` and keeps error traces in full. Another OpenTelemetry SDK
  with the default parent-based sampler does not head-sample them; set its
  `remoteParentNotSampled` sampler to your ratio sampler to keep your usual
  rate.
- The tracker's own `endpoint` (the same-origin relay) never gets a header.
- `fetch` is traced through the tracker's network observer, so
  `captureNetworkFailures: false` turns fetch propagation off;
  `XMLHttpRequest` is wrapped by the module itself. Call
  `enableTracePropagation()` before your app sends requests;
  `disableTracePropagation()` turns it off at runtime.

**CORS for cross-origin APIs.** `traceparent` is not a CORS-safelisted
header, so a listed cross-origin API gets a preflight (`OPTIONS`) and must
allow the header, or the browser blocks the request:

```
Access-Control-Allow-Headers: traceparent, content-type
Access-Control-Expose-Headers: x-request-id
```

Only list APIs you control and whose CORS configuration allows it.

## Sample, ignore and deny: `/filters` (1.7.0, opt-in)

`sampleRate`, `ignoreErrors` and `denyUrls` live in
`@autter/runtime-browser/filters` (the main tracker has no room left in its
10 KB budget; this adds about 0.35 KB brotlied and nothing to apps that don't
import it). `withFilters` takes your init options plus the three filters and
installs them as `beforeSend`; your own `beforeSend` still runs, after them:

```ts
import { initAutterBrowser } from "@autter/runtime-browser";
import { withFilters } from "@autter/runtime-browser/filters";

initAutterBrowser(withFilters({
  endpoint: "/api/autter-runtime",
  service: "web-app",
  sampleRate: 0.25,                                          // a quarter of errors
  ignoreErrors: ["ResizeObserver loop", /^AbortError$/],     // type or message
  denyUrls: [/^(chrome|moz|safari-web)-extension:/, "googletagmanager.com"],
}));
```

- `sampleRate` (0..1, default 1): the share of errors sent: exceptions,
  unhandled rejections, outcomes, failed requests, CSP violations and
  error-level messages. Never a `fatal` message; warnings, info, usage
  events and timings are never sampled.
- `ignoreErrors`: a string matches when the error's type or message contains
  it (case-sensitive); a RegExp is tested against the type, the message and
  `"<type>: <message>"`. Applies to every error event, warnings included. It
  sees the message as sent, after secret/PII scrubbing.
- `denyUrls`: errors from these scripts are never sent. The script is the
  error event's file (`window.onerror`), else the URL of the innermost stack
  frame that has one, so an app error passing through a third-party callback
  is still sent. Strings match when the URL contains them; RegExps are tested
  against it.
- `createFilter(filters, next?)` returns the bare `beforeSend` hook.

What these leave out never leaves the page and is counted nowhere, and it
applies to this app's browsers only. Suppression rules in Autter (Runtime
settings, ingester 1.9.0) drop or sample at ingest for every SDK, and the
coverage panel shows how many they left out.

## API

| Function | Notes |
| --- | --- |
| `initAutterBrowser(options)` | Installs error, rejection, CSP, and recent-action listeners; sends a session ping |
| `captureException(error, context?)` | Handled errors; fast-flushed; duck-types `code/why/fix/link/expected/requestId`; `context.fingerprint` overrides grouping |

| `enableTracePropagation({ tracePropagationTargets? })` | From `@autter/runtime-browser/tracing`: W3C trace propagation, see [Trace propagation](#trace-propagation-160-opt-in) |
| `captureException(error, context?)` | Handled errors; fast-flushed; duck-types `code/why/fix/link/expected/requestId` |
| `autterErrorFromResponse(response)` | `Promise<Error>` from a failed Response's JSON error body (or status text) |
| `captureMessage(message, severity?, context?)` | Warnings/info without an exception (`"warning"` default); grouped and aggregated like errors |
| `trackEvent(name, props?)` | Usage counter; aggregated server-side per minute |
| `setUser(id)` | **Opaque id only** — never an email |
| `setContext(ctx)` | Attached to subsequent events |
| `flush()` | Force-send the queue (also runs on page hide/unload) |
| `redactContext(ctx)` | Mask secrets/PII in a context bag, nested (applied to every event automatically) |
| `scrubText(text)` | Mask secrets/PII inside a string (applied to every message, stack and name automatically) |
| `enableBreadcrumbs(options?)`, `addBreadcrumb(crumb)`, `clearBreadcrumbs()` | From `@autter/runtime-browser/breadcrumbs` — see above |
| `withFilters(options)`, `createFilter(filters, next?)` | From `@autter/runtime-browser/filters`: `sampleRate`, `ignoreErrors`, `denyUrls`, see [above](#sample-ignore-and-deny-filters-170-opt-in) |

## Batching & delivery

Events queue and flush at 10 events / 5 s / page hidden / `pagehide` /
manually; errors trigger a fast flush (500 ms). Delivery uses
`navigator.sendBeacon` (JSON blob) with a `fetch(keepalive)` fallback, so
events survive page navigation. A hard cap of 200 events per session
prevents error loops from flooding (events left out by `beforeSend` or the
filters do not count toward it); the ingester also collapses a looping error
into one sample a minute with an exact count (1.9.0).

## What is never sent

Full URLs with query strings, the raw User-Agent header, cookies,
localStorage, DOM text, form values, request headers/bodies, console history,
IP addresses, and CSP policy text. Routes are `location.pathname` only.
Browser and OS are a family plus major version. Filenames and script URLs are
query-stripped. For CSP blocks, the directive, blocked resource origin, script
path, and a short policy hash are retained. Of response headers, only
`x-request-id` is read, and only on failed (5xx) requests. With
`@autter/runtime-browser/tracing`, the only request header read is
`traceparent` (to keep an existing one and use its trace id), and the only
header added is `traceparent`, on same-origin and listed requests.

Messages, stack traces and custom `context` (at any depth) are scrubbed
before send: values under sensitive-looking keys (`email`, `password`,
`token`, `secret`, `auth`, `cookie`, `session`, `api_key`, `card_number`, …)
are replaced with `[redacted]`, and secrets inside strings — JWTs,
`Bearer`/`Basic` credentials, `Cookie:`/`Authorization:` text, connection
strings with credentials, common API keys, `?token=`/`password=`
assignments, emails, card numbers — are masked in place. This mirrors the
server SDK's `redactText`/`redactAttributes`; the relay and ingester apply
the full server-side rule set again as defense-in-depth.

Add your own patterns (or opt out, not recommended):

```ts
initAutterBrowser({
  ...,
  redact: { keys: /^internal_ref$/, values: [/ORD-\d{5}/g] },
  // redact: false,
});
```
