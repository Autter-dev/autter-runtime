# Edge worker example

A Cloudflare Worker using [`@autter/runtime-edge`](../../packages/runtime-edge):
request summaries, request ids, and coded errors with zero dependencies.

Locally, against the repo's `docker compose up` ingester:

```bash
cp .dev.vars.example .dev.vars               # AUTTER_ENDPOINT=http://localhost:4318 + the local key
npx wrangler dev
curl -i localhost:8787/?plan=pro             # 200, x-request-id echoed
curl -i "localhost:8787/?over"               # 429 { error: { code: "quota.exceeded", … } }
```

The worker logs where it sends on its first request. Without
`AUTTER_ENDPOINT` it sends to `http://localhost:4318`, never to a hosted
ingester. `.dev.vars` is git-ignored and only applies to `wrangler dev`.

Deployed, `wrangler.toml` sets `AUTTER_ENDPOINT` to Autter cloud
(`https://otlp.autter.dev`; change it for a self-hosted ingester), and the key
is a secret:

```bash
npx wrangler secret put AUTTER_RUNTIME_KEY   # a SERVER ingest key, never a browser key
npx wrangler deploy
```

`wrangler.toml` is a sketch; this repo does not depend on Wrangler. The same
handler works on Vercel Edge (`export default`), Deno (`Deno.serve(handler)`)
and Bun (`Bun.serve(handler)`), where `waitUntil` is not available and
delivery is fire-and-forget.
