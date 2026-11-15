# Releasing (maintainers)

## One-time setup

1. Create the **`autter` organization on npmjs.com** (Add Organization →
   name `autter`) — this owns the `@autter` scope.
2. For **each public package** (`runtime-browser`, `runtime-node`,
   `runtime-edge`, `runtime-next`, `runtime-cli`, `otlp-ingester`), add a
   trusted publisher: npmjs.com → the package → Settings → Trusted Publisher
   → GitHub Actions, with organization `Autter-dev`, repository
   `autter-runtime`, workflow `release.yml`, no environment, and
   **Allow `npm publish`** ticked. A new trusted publisher must be used by a
   publish within 2 days or npm drops it.
3. Once each package has published through it, set the package's
   publishing access to *Require two-factor authentication and disallow
   bypass 2fa tokens*. No npm token is stored in this repo.

## Publishing a release

1. Bump versions in the changed packages' `package.json` (keep
   `@autter/runtime-next`'s dependencies on its sibling packages in sync).
2. Commit, then tag and push:

   ```bash
   git tag v0.1.0 && git push origin main --tags
   ```

The `Release` workflow builds everything, runs the browser size gate, and
publishes each package whose version doesn't already exist on the registry
— re-running is safe. It authenticates with npm trusted publishing (OIDC), so
there is no token to renew. Packages publish with npm **provenance**, so the
version page shows it was built from this repo by CI.

Manual fallback: Actions tab → Release → Run workflow.

## Versioning policy

Independent semver per package. The `/v1/browser` payload schema, the
OTLP surface, ClickHouse row schemas, and the sink webhook payload are
additive-only within a major (see `docs/PLAN.md` § compatibility contract).
