# Releasing (maintainers)

## One-time setup

1. Create the **`autter` organization on npmjs.com** (Add Organization →
   name `autter`) — this owns the `@autter` scope.
2. Generate an **automation token**: npmjs.com → Access Tokens →
   Generate New Token → *Automation* (bypasses 2FA for CI).
3. Add it to this repo as the `NPM_TOKEN` secret:
   `gh secret set NPM_TOKEN -R Autter-dev/autter-runtime`.

## Publishing a release

1. Bump versions in the changed packages' `package.json` (keep
   `@autter/runtime-next`'s dependencies on its sibling packages in sync).
2. Commit, then tag and push:

   ```bash
   git tag v0.1.0 && git push origin main --tags
   ```

The `Release` workflow builds everything, runs the browser size gate, and
publishes each package whose version doesn't already exist on the registry
— re-running is safe. Packages publish with npm **provenance**, so the
version page shows it was built from this repo by CI.

Manual fallback: Actions tab → Release → Run workflow.

## Versioning policy

Independent semver per package. The `/v1/browser` payload schema, the
OTLP surface, ClickHouse row schemas, and the sink webhook payload are
additive-only within a major (see `docs/PLAN.md` § compatibility contract).
