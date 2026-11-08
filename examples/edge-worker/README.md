# Edge worker example

A Cloudflare Worker using [`@autter/runtime-edge`](../../packages/runtime-edge):
request summaries, request ids, and coded errors with zero dependencies.

## Prerequisites

- Node.js 20 or later; `npx wrangler` (Wrangler 3+) fetches itself.
- Locally: the repo's `docker compose up` ingester on port 4318 (Docker with
  Compose v2), and `npm install && npm run build` at the repo root so the
  worker can import the built `@autter/runtime-edge`.
- Deployed: a Cloudflare account, and a **server** key (`autter_rt_…`),
  never a browser key.

## Run it

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
A refused log batch (a wrong key, an ingester without `/v1/logs`) is logged
once in the worker's console with the ingester's reason. To check the
endpoint and key on their own: `npx @autter/runtime-node verify --endpoint
<url> --key <key>`.

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
