# Contributing to Autter Runtime

We'd be more than glad to have you. Whether it's a bug report, a new
language integration, a docs fix, or a feature — contributions of every
size are welcome, and first-time contributors are actively encouraged.

## Ways to contribute

- **Report a bug** — open an issue with what you sent, what you expected,
  and what happened. Ingester logs or a failing `curl` reproduction make
  fixes fast.
- **Improve the docs** — unclear setup steps, missing language examples,
  typos. Docs PRs are the easiest way to land a first contribution.
- **Add a language/framework integration** — a new snippet in
  [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md), or a whole new style skill
  in [Autter-dev/autter-skills](https://github.com/Autter-dev/autter-skills)
  (Ruby, PHP, Java, Elixir, Django, Laravel, Rails … all unclaimed).
- **Work on the SDKs or ingester** — features, bug fixes, performance.
  Check open issues, or open one first for anything sizeable so we can
  agree on direction before you invest time.

## Repo layout

```
packages/
├── runtime-browser/   # <5 KB zero-dep browser tracker (size-limit enforced in CI)
├── runtime-node/      # Node server tracker (curated OTel) + browser relay handlers
├── runtime-next/      # Next.js wrapper: instrumentation + relay route + error boundary
└── otlp-ingester/     # the ingest service: OTLP + /v1/browser → ClickHouse
deploy/
├── aws/               # ECS Fargate deploy scripts + runbook
└── single-server/     # docker-compose (ingester + ClickHouse + Caddy) for EC2/Lightsail
docs/                  # architecture, integrations, getting started, this-repo-without-npm
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first — it explains the
data model (occurrences/spans/rollups), the fingerprinting rules, and the
two-key auth model that most changes end up touching.

## Development setup

Prereqs: Node ≥ 20, Docker (for a local ClickHouse).

```bash
git clone https://github.com/Autter-dev/autter-runtime
cd autter-runtime
npm install
npm run build            # builds all packages in dependency order
```

Run the full stack locally:

```bash
docker compose up -d     # local ClickHouse (:8123, password "dev")
npm run dev              # ingester on :4318 with static key "dev-key"
```

Send yourself a test error and read it back:

```bash
curl -X POST http://localhost:4318/v1/browser \
  -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" \
  -d '{"version":1,"service":"dev","environment":"local","events":[{"type":"exception","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'","message":"hello autter","errorType":"Error"}]}'

docker compose exec clickhouse clickhouse-client --password dev \
  --query "SELECT service, severity, message FROM autter_runtime.runtime_error_occurrences"
```

## Ground rules for changes

These are the invariants that keep the system trustworthy — CI checks some,
review checks the rest:

- **Browser bundle stays under 5 KB** (brotlied). CI runs
  `npm run size -w @autter/runtime-browser` and fails over-budget PRs. The
  browser tracker stays **zero-dependency** — no exceptions.
- **Telemetry fails open.** SDK code must never throw into the host app,
  never block a response, never retry unboundedly. Bounded queues, short
  timeouts, drop-successes-before-errors.
- **Tenancy comes from the key, never the payload.** Nothing a client
  sends may influence which org/repo rows are written to.
- **Privacy is whitelist-based.** New ingested fields must be explicitly
  allowed in the payload schema / normalisers; never add pass-through of
  arbitrary attributes, headers, bodies, or cookies.
- **ClickHouse schema changes need BOTH** a versioned migration in
  `packages/otlp-ingester/src/migrations.ts` (idempotent statements, new
  columns need a `DEFAULT`) **and** the matching change in the baseline
  `schemaStatements()` in `clickhouse.ts`. Shipped migrations are
  append-only — never edit or reorder existing ones.
- **Fingerprinting changes are breaking.** Any change to
  `fingerprint.ts` regroups every existing issue. Treat it like a schema
  migration: discuss in an issue first.
- **Wire formats are contracts.** The `/v1/browser` `version: 1` payload
  and the OTLP surface can gain optional fields, but existing fields don't
  change meaning. Bump the payload `version` for anything incompatible.

## Submitting a PR

1. Fork, branch from `main`.
2. Make the change; keep the diff focused (one logical change per PR).
3. `npm run build` must pass; if you touched runtime-browser, check
   `npm run size -w @autter/runtime-browser`.
4. If you changed ingest behaviour, include the manual verification you
   ran (the curl + clickhouse-client read-back above is usually enough).
5. Open the PR with a short description of *why*, not just what.

CI runs build + the browser size gate on every PR. A maintainer will
review — we aim to respond within a few days.

## Releases (maintainers)

Publishing is tag-driven: `git tag v0.x.y && git push origin v0.x.y`
publishes all packages to npm with provenance and a versioned image to
GHCR. Details in [docs/RELEASING.md](docs/RELEASING.md).

## Questions

Open a [GitHub issue](https://github.com/Autter-dev/autter-runtime/issues)
— for questions and ideas as much as bugs. There are no bad questions;
if the docs left you confused, that's a docs bug we want to know about.
