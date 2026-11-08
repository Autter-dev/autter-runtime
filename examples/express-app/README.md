# Express example

An Express app with Autter Runtime on both halves: `@autter/runtime-node`
on the server (traces, request summaries, coded errors, LLM calls) and
`@autter/runtime-browser` on the page, posting through the app's own
same-origin relay.

## Prerequisites

- Node.js 20 or later and npm 10 (the repo is an npm workspace).
- Docker with Compose v2, for the local ClickHouse and ingester.
- Ports 3000 (the app), 4318 (the ingester) and 8123 (ClickHouse) free.
- Nothing else: no key to create, no `.env`. Against a deployed ingester you
  need its URL and a **server** key (`autter_rt_…`); see below.

## Run it locally

From the root of this repo, in two terminals:

```bash
docker compose up                         # ClickHouse + ingester on http://localhost:4318
```

```bash
npm install
npm run build                             # all packages, in dependency order
npm start -w example-express-app          # http://localhost:3000
```

With no `AUTTER_*` variables set, the app sends to `http://localhost:4318`
with the ingester's built-in local key `autter_rt_local_dev_only`, and says
so when it starts. It never falls back to a hosted ingester. `npm start`
first copies the built browser SDK, every file of it, into `public/sdk/`
(plain Node, so it works on Windows too).

Open http://localhost:3000, click the buttons, then check the connection
and see the errors stored:

```bash
npx @autter/runtime-node doctor --endpoint http://localhost:4318 --key autter_rt_local_dev_only
docker compose exec clickhouse clickhouse-client --password dev --query \
  "SELECT service, error_type, message FROM autter_runtime.runtime_error_occurrences ORDER BY occurred_at DESC LIMIT 5"
```

`example-express` rows come from the server, `example-web` rows from the
page.

Check the path before clicking around: `npx @autter/runtime-node verify
--endpoint http://localhost:4318 --key autter_rt_local_dev_only --service
example-express-app` sends a test event and reads it back, step by step
(built from this repo: `node packages/runtime-node/dist/cli.js verify …`).

## Against another ingester

Set both variables; with an endpoint and no key, the app exits with an error.

```bash
AUTTER_ENDPOINT=https://otlp.autter.dev AUTTER_RUNTIME_KEY=autter_rt_… npm start -w example-express-app
```

`PORT` changes the app's port (default 3000).
