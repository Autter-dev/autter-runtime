# Edge worker example

A Cloudflare Worker using [`@autter/runtime-edge`](../../packages/runtime-edge):
request summaries, request ids, and coded errors with zero dependencies.

```bash
npx wrangler secret put AUTTER_RUNTIME_KEY   # a SERVER ingest key, never a browser key
npx wrangler dev
curl -i localhost:8787/?plan=pro             # 200, x-request-id echoed
curl -i "localhost:8787/?over"               # 429 { error: { code: "quota.exceeded", … } }
```

`wrangler.toml` is a sketch; this repo does not depend on Wrangler. The same
handler works on Vercel Edge (`export default`), Deno (`Deno.serve(handler)`)
and Bun (`Bun.serve(handler)`), where `waitUntil` is not available and
delivery is fire-and-forget.
