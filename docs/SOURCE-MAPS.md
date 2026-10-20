# Readable stack traces: source maps and debug ids

Production JavaScript is minified, so a browser stack trace points at
`/assets/index-4f3c.js:1:58213`. Upload your build's source maps and Autter
resolves each frame to the original file, line and function before it groups
the error and prepares a fix.

`@autter/runtime-cli` does this for you:

1. **Inject.** Every `.js`, `.mjs` and `.cjs` bundle that has a source map gets
   a *debug id*: a UUID derived from the sha256 of the bundle's bytes, so the
   same build output always gets the same id. The CLI appends a
   `//# debugId=<id>` comment, adds a one-line snippet that registers the id
   with the browser SDK, and writes `"debugId"` into the `.map`.
2. **Upload.** Every map goes to the ingester's `POST /v1/sourcemaps` with a
   server key, its debug id, the release and the path the bundle is served
   from. Maps the ingester already has are skipped.
3. **Match.** `@autter/runtime-browser` 1.6.0+ sends, with each exception, the
   debug ids of the scripts in its stack. The ingester finds the map by debug
   id first, and by release + path when there is none. A debug id names the
   exact bytes that ran, so maps match even when the `release` your SDK reports
   differs from the one you uploaded under (or is missing).

Debug ids need ingester 1.6.0+ (compat feature `source_map_debug_ids`,
migration `0016-source-maps-debug-id`). Older ingesters still accept `.js`
maps by release + path; the CLI warns and uploads everything.

## Pick an integration

| Build | Use |
| --- | --- |
| Vite or Rollup | `@autter/runtime-cli/vite` plugin |
| webpack 5 | `@autter/runtime-cli/webpack` plugin |
| Next.js | `withAutterSourceMaps` from `@autter/runtime-cli/next` |
| Anything else, or a CI step | `autter-runtime sourcemaps inject` + `upload` |
| GitHub Actions | the `upload-sourcemaps` composite action |

Install the package as a dev dependency:

```bash
npm install -D @autter/runtime-cli
```

Every integration reads the server key from `AUTTER_RUNTIME_KEY` (the same
`autter_rt_…` key your backend uses; never a publishable `autter_rtc_…` key, and
never in the browser bundle). Without a key, debug ids are still injected and
nothing is uploaded, so local builds work unchanged.

The release defaults to the commit being built: `GITHUB_SHA`,
`VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `GIT_SHA`, then
`git rev-parse HEAD`. Releases may contain letters, digits, `.`, `_` and `-`.

### Vite / Rollup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { autterSourceMaps } from "@autter/runtime-cli/vite";

export default defineConfig({
  plugins: [autterSourceMaps()],
});
```

The plugin sets `build.sourcemap: "hidden"` when you haven't configured maps
(maps are written, but bundles don't reference them), injects debug ids into
every chunk after the bundle is written, uploads under Vite's `base`, and then
deletes the maps it created so they are not deployed. SSR builds and Vite 6
server environments are skipped. With plain Rollup, use the same import (or
`@autter/runtime-cli/rollup`); it sets `output.sourcemap: "hidden"` when unset.

### webpack

```js
// webpack.config.js
const { AutterSourceMapsWebpackPlugin } = require("@autter/runtime-cli/webpack");

module.exports = {
  mode: "production",
  plugins: [new AutterSourceMapsWebpackPlugin()],
};
```

Production builds without a `devtool` get `hidden-source-map`. After emit, the
plugin injects every emitted JS asset and uploads it under
`output.publicPath` (`/` when it is `"auto"`). Development builds are left
alone.

### Next.js

```js
// next.config.mjs
import { withAutterSourceMaps } from "@autter/runtime-cli/next";

export default withAutterSourceMaps({
  reactStrictMode: true,
});
```

Client production builds get hidden source maps; chunks are uploaded as
`<basePath or assetPrefix>/_next/static/…`. On Next.js 15.4.1 and later the work
runs in `compiler.runAfterProductionCompile`, so it covers webpack and
Turbopack builds alike (Turbopack needs `productionBrowserSourceMaps`, which the
wrapper turns on and then hides by removing the `sourceMappingURL` comments).
Older versions use the webpack plugin. Server bundles are never touched. If
you already set `productionBrowserSourceMaps: true`, your maps stay public and
on disk. The wrapper lives in `@autter/runtime-cli` rather than
`@autter/runtime-next` so build-time code never becomes a runtime dependency of
your app.

### CLI

```bash
npx autter-runtime sourcemaps inject dist
AUTTER_RUNTIME_KEY=autter_rt_… npx autter-runtime sourcemaps upload dist \
  --url-prefix / --release "$GIT_SHA"
```

| Option | Meaning |
| --- | --- |
| `--release <r>` | Release to upload under (default: see above) |
| `--url-prefix <p>` | Where the directory is served from: `/` (default), `/static/`, `https://cdn.example.com/app/`. `~/` means `/`. |
| `--endpoint <url>` | Ingester base URL (default `$AUTTER_ENDPOINT`, `$AUTTER_RUNTIME_ENDPOINT`, `$OTEL_EXPORTER_OTLP_ENDPOINT`, then `https://otlp.autter.dev`) |
| `--concurrency <n>` | Parallel uploads (default 8) |
| `--delete-after-upload` | Delete each `.map` (and its `sourceMappingURL` comment) once uploaded |
| `--dry-run` | Show what would change or be uploaded; write and send nothing |
| `--json` | Machine-readable output |

`inject` is idempotent: run it twice and the second run changes nothing.
Run it **before** you upload and **before** you deploy, on the exact files you
deploy. Exit codes: `0` success, `1` some maps failed, `2` no key / no
release / key rejected, `64` usage error.

`@autter/runtime-node` also installs an `autter-runtime` bin (for `doctor`).
Each package hands the other's commands over, so `autter-runtime doctor` and
`autter-runtime sourcemaps …` both work whichever one npm linked.

### GitHub Actions

```yaml
- run: npm run build
- uses: Autter-dev/autter-runtime/.github/actions/upload-sourcemaps@main
  with:
    directory: dist
    key: ${{ secrets.AUTTER_RUNTIME_KEY }}
    url-prefix: /
    delete-after-upload: "true"
- run: ./deploy.sh dist
```

Inputs: `directory`, `key` (required), `release` (default `GITHUB_SHA`),
`url-prefix`, `endpoint`, `inject` (`"false"` if a bundler plugin already
injected), `delete-after-upload`, `cli-version`.

## How the pieces fit

**The debug id** is the first 16 bytes of sha256(bundle bytes), formatted as a
version-4 UUID. A bundle whose bundler already wrote `//# debugId=` (Rollup's
`sourcemapDebugIds`, Turbopack, webpack `-debugids` devtools) keeps that id and
only gains the snippet.

**The snippet** is one line of ES5:

```js
;!function(){try{var g=…globalThis…,s=(new g.Error).stack;s&&((g._autterDebugIds=g._autterDebugIds||{})[s]="<id>")}catch(e){}}();
```

The stack's first frame names the URL the browser loaded the bundle from;
`@autter/runtime-browser` maps that URL to the id and attaches
`debugIds: { "<script URL>": "<id>" }` (query and hash removed) to exceptions,
only for scripts that appear in the exception's stack. The snippet goes on the
first line, so a bundle that throws while loading is still identified; the
map's `mappings` are shifted down one line to match. Bundles that start with a
directive (`"use strict"`, `"use client"`) get it appended instead, which moves
nothing. Running inject again changes nothing.

**Storage.** `runtime_source_maps` (ReplacingMergeTree, 30-day TTL) keeps one
map per org, repository, release and path, now with `debug_id` and
`content_hash`. `sourcesContent` is stripped by the CLI and again by the
ingester, and maps are limited to 5 MB. `POST /v1/sourcemaps/check` tells the
CLI which maps are already stored (same release, path, debug id and content,
uploaded in the last 7 days), so re-runs skip them; older ones are re-sent to
refresh the TTL.

**Lookup.** Symbolication calls
`lookupSourceMap(client, database, { orgId, repositoryId, release, filename, debugId })`
(`packages/otlp-ingester/src/source-maps-lookup.ts`): by debug id first, then
by release + path (origin, query and hash removed).

## Troubleshooting

- **Frames stay minified.** Check that you deployed the files you injected
  (inject after any later minification or copying step), that the browser SDK
  is 1.6.0+, and that the ingester is 1.6.0+ (`GET /v1/compat` lists
  `source_map_debug_ids`). Without debug ids, the SDK `release` must equal the
  upload release and `--url-prefix` must match the served path.
- **`map is … MB … the ingester accepts up to 5 MB`.** Split the bundle
  (code-splitting) so each map stays under 5 MB without `sourcesContent`.
- **`release "…" is not valid`.** Use a commit SHA or a value with only
  letters, digits, `.`, `_` and `-`.
- **Subresource integrity.** Injection changes bundle bytes after the build,
  so script hashes computed during the build (Next.js `experimental.sri`,
  webpack SRI plugins) no longer match. Recompute them after injecting, or
  leave SRI off for these bundles.
