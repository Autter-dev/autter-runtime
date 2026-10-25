# Autter Runtime Relay (serverless same-origin templates)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Autter-dev/autter-runtime/tree/main/examples/runtime-relay)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Autter-dev/autter-runtime/tree/main/examples/runtime-relay&project-name=autter-runtime-relay&repository-name=autter-runtime-relay)

For static/serverless sites with no backend. The direct browser path
(`https://otlp.autter.dev/v1/browser` + `autter_rtc_*`) is cross-origin and
can be silently dropped by tracker/ad-blockers. A same-origin relay
(`your-domain/api/autter-runtime` → ingester) looks like your own API traffic
and avoids that loss — no Express/Node backend required.

## Option A — Cloudflare Worker (1-click)

1. From this folder: `npx wrangler deploy`
2. Route `/api/autter-runtime*` to this worker (or call it directly).
3. Optional: `wrangler secret put AUTTER_RUNTIME_KEY` (server key `autter_rt_*`)
   to upgrade from publishable client key without touching the browser bundle.
4. SDK:
   ```ts
   initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" });
   ```

Contract (mirrors `createBrowserRelayHandler`): POST-only, 64KB cap,
per-visitor rate limit, `Origin` forwarded for allow-list checks, `Cookie`
stripped, 202 on accept.

**Rate limit.** 120 requests a minute per visitor by default; set
`AUTTER_RELAY_RATE_LIMIT` (a `wrangler.jsonc` var, or a Vercel env var) to
change it, or `0` when a WAF already limits the route. The visitor is the
address the platform vouches for: `CF-Connecting-IP` on a Worker, otherwise
the rightmost public `X-Forwarded-For` entry (Vercel overwrites that header,
and other proxies append to it). Never the first entry, which any caller can
write. The window lives in each isolate or function instance, so it is a
backstop against floods rather than an exact global quota.

## Option B — Vercel Edge

Copy `vercel-edge-route.ts` to `app/api/autter-runtime/route.ts`, deploy.
On Next.js, `createAutterRelayRoute` from `@autter/runtime-next` is the
packaged equivalent, with payload validation and scrubbing on top.
Alternatively add a rewrite in `vercel.json` (proxies without code):

```json
{
  "rewrites": [
    { "source": "/api/autter-runtime/:path*", "destination": "https://otlp.autter.dev/v1/browser/:path*" }
  ]
}
```

Note: the rewrite forwards the browser call directly; prefer the Edge route
when you want the 64KB cap, the rate limit, cookie stripping and the
server-key upgrade.

## When direct is still fine

Pure-static with no edge runtime: use the publishable client key and accept
some ad-block loss:
```ts
initAutterBrowser({
  endpoint: "https://otlp.autter.dev/v1/browser",
  clientKey: "autter_rtc_…",
  service: "marketing-site",
});
```
