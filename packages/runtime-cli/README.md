# @autter/runtime-cli

Readable stack traces for Autter Runtime. Gives every JS bundle a
content-addressed **debug id** and uploads its **source map** to the ingester,
so minified browser frames resolve to your original source, even when the
release your SDK reports doesn't match the upload.

- `autter-runtime sourcemaps inject <dir>` / `upload <dir>` CLI
- Vite/Rollup plugin: `@autter/runtime-cli/vite`
- webpack 5 plugin: `@autter/runtime-cli/webpack`
- Next.js wrapper: `withAutterSourceMaps` from `@autter/runtime-cli/next`

No runtime dependencies; bundlers are optional peer dependencies. Debug ids
need ingester 1.6.0+ and `@autter/runtime-browser` 1.6.0+ (older ingesters
still match `.js` maps by release + path). Full guide:
[docs/SOURCE-MAPS.md](../../docs/SOURCE-MAPS.md).

## Install

```bash
npm install -D @autter/runtime-cli
```

Set `AUTTER_RUNTIME_KEY` to a **server** ingest key (`autter_rt_…`) where your
build runs. Without it, debug ids are injected and nothing is uploaded.

## Vite / Rollup

```ts
import { autterSourceMaps } from "@autter/runtime-cli/vite";

export default defineConfig({ plugins: [autterSourceMaps()] });
```

## webpack

```js
const { AutterSourceMapsWebpackPlugin } = require("@autter/runtime-cli/webpack");

module.exports = { plugins: [new AutterSourceMapsWebpackPlugin()] };
```

## Next.js

```js
// next.config.mjs
import { withAutterSourceMaps } from "@autter/runtime-cli/next";

export default withAutterSourceMaps({ reactStrictMode: true });
```

All three turn on hidden source maps when you haven't configured maps, inject
debug ids after the build, upload when a key is present, and delete the maps
they created once uploaded. Options (all optional): `release`, `urlPrefix`,
`endpoint`, `key`, `upload: false`, `deleteAfterUpload`, `dryRun`,
`concurrency`, `failOnError` (default `false`: a failed upload is logged and
never fails the build), `silent`.

## CLI

```bash
npx autter-runtime sourcemaps inject dist
npx autter-runtime sourcemaps upload dist --url-prefix / --release "$GIT_SHA"
npx autter-runtime sourcemaps upload dist --dry-run
```

```
autter-runtime sourcemaps inject <dir> [--dry-run]
autter-runtime sourcemaps upload <dir> [--release <r>] [--url-prefix <prefix>]
              [--endpoint <url>] [--concurrency <n>] [--delete-after-upload] [--dry-run] [--json]
```

- **inject** writes `//# debugId=<id>`, a one-line snippet that registers
  `globalThis._autterDebugIds[new Error().stack] = "<id>"`, and `"debugId"` in
  the `.map`, for each `.js`/`.mjs`/`.cjs` with a map. The id is derived from
  sha256 of the bundle bytes; running it again changes nothing.
- **upload** posts each map (without `sourcesContent`) to
  `<endpoint>/v1/sourcemaps`, in parallel, skipping maps the ingester already
  has. Each map carries the bundle's function scopes (`x_autter_scopes`),
  parsed from the file as served, so frames are named after the function they
  are in rather than their call site; a bundle that does not parse is uploaded
  without them, with a warning. Release: `--release`, else `GITHUB_SHA`,
  `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `GIT_SHA`, then
  `git rev-parse HEAD`.

Exit codes: `0` ok, `1` some maps failed, `2` no key / no release / key
rejected, `64` usage error.

## Programmatic API

```ts
import { injectDir, uploadDir } from "@autter/runtime-cli";

await injectDir("dist");
const summary = await uploadDir("dist", { urlPrefix: "/", release: process.env.GIT_SHA });
```
