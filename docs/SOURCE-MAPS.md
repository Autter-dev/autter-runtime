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
2. **Upload.** Every map goes to the ingester's `POST /v1/sourcemaps`,
   gzipped, with a server key, its debug id, the release, the path the
   bundle is served from and the bundle's function scopes (see **Function
   names** under [How the pieces fit](#how-the-pieces-fit)). Maps the
   ingester already has are skipped.
3. **Match.** `@autter/runtime-browser` 1.6.0+ sends, with each exception, the
   debug ids of the scripts in its stack. The ingester finds the map by debug
   id first, and by release + path when there is none. A debug id names the
   exact bytes that ran, so maps match even when the `release` your SDK reports
   differs from the one you uploaded under (or is missing).

Debug ids need ingester 1.6.0+ (compat feature `source_map_debug_ids`,
migration `0017-source-maps-debug-id`). Older ingesters still accept `.js`
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
`content_hash`, in a ZSTD-compressed `String` column. `sourcesContent` is
stripped by the CLI and again by the ingester. A stored map may be up to
32 MiB (5 MiB up to ingester 1.6.0), enough for a vendor chunk of about 20 MB
of minified code. The CLI sends the request gzipped (`Content-Encoding:
gzip`; maps shrink roughly 3×) and the ingester inflates it, counting its body limit
(32 MiB + 1 MiB) in inflated bytes, so a small compressed body can't expand
past it. The key is checked before the body is read. `POST
/v1/sourcemaps/check` tells the CLI which maps are already stored (same
release, path, debug id and content, uploaded in the last 7 days), so re-runs
skip them; older ones are re-sent to refresh the TTL.

**Function names.** A frame is named after the function it is in, the way
Sentry (js-source-scopes) and PostHog (cymbal's `token.scope()`) do it.
`upload` parses each bundle exactly as served (after `inject`, so positions
match browser stacks) with [acorn](https://github.com/acornjs/acorn) and
records every function: declarations, expressions, arrows, class and object
methods, getters and setters. Each one is named by, in order, its own name,
the binding it is assigned to (`const x = () => …`, `x = function …`,
`obj.x = …`), its object or class key (a constructor takes its class's name),
else nothing (anonymous). The name token's position is mapped through the map
to the original identifier: the map's `names` there, else the generated name
when it isn't a minified one (≤ 2 characters), else the identifier at the
original position in `sourcesContent`. A name the minifier removed
(`function onPayClick() {}` passed inline) is read back from `sourcesContent`
too. The result travels in the map, encoded like `mappings`:

```json
"x_autter_scopes": {
  "version": 1,
  "names": ["captured", "other", "addItem", "total", "onCheckoutClick"],
  "scopes": "AAwDA,oCAgB,0BAsEI,kFAsCY,6CAoBC,yCAiBV,..."
}
```

`scopes` is base64 VLQ with `;` between generated lines (the line a scope
starts on) and `,` between the scopes that start on one line, in start order.
Each scope is 3 or 4 values, 0-based and in UTF-16 columns: its start column
(relative to the previous scope's start on the line), its end line (relative
to the start line), its end column (exclusive; relative to the start column
when it ends on its start line), and, when it has a name, a name index
(relative to the last one written). Name indexes continue the map's own
`names`, which already hold most original names (`AAwDA` above is columns
0–56 of line 0, named `names[0]`, `computeTotal`); `x_autter_scopes.names`
holds the rest, and a `null` there is a minified name that could not be
mapped. A 3-value scope is anonymous. On a TypeScript-sized bundle (21 688
functions, 5 MB map) this is 187 KB, 3.8% of the map: about 7 bytes per
function plus 1 204 extra names.

The ingester names a frame after the innermost scope that contains it
(`null` in an anonymous function or top-level code; for a `null` name it keeps
the call-site name). Maps uploaded without scopes (older CLIs) keep the
earlier rule: the name the map holds at the caller's position. That rule names
`const run = actions.captured; run()` as `run` and a handler a framework calls
as `fn`/`func`/`listener`, which also merged different handlers of one file
into one `frames-v3` issue. A bundle that does not parse, or a map that only
fits the 32 MB limit without scopes, is uploaded without them and the CLI
prints a warning.

**Parse cache.** Parsed maps are kept in an LRU bounded by
`SOURCE_MAP_CACHE_MB` (64 MiB by default), counted by what they actually take:
mappings are decoded into one `Int32Array` (20 bytes per segment, about 3 bytes
per byte of map JSON; a general-purpose decoder takes about 14), plus names,
sources and scope tables. A map that would take more than half the budget —
about 10 MiB of JSON at the default — is not kept: its frames are resolved in
one pass over the encoded `mappings` for the whole stack, so it never flushes
the other maps, at the cost of fetching it again for the next event.

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
- **`map is … MB … the ingester accepts up to 32 MB`.** Split the bundle
  (code-splitting) so each map stays under 32 MB without `sourcesContent`.
- **`HTTP 413 … ingester 1.6.0 and older accept up to 5 MB`.** The ingester
  predates large maps; upgrade it, or split the bundle.
- **`release "…" is not valid`.** Use a commit SHA or a value with only
  letters, digits, `.`, `_` and `-`.
- **Frames are named after call sites** (`run`, `fn`, `func`, `listener`).
  The map was uploaded without function scopes: by a CLI that predates them,
  or with a warning (the bundle did not parse, or the map is close to 32 MB).
  Upload it again with the current `@autter/runtime-cli`.
- **Subresource integrity.** Injection changes bundle bytes after the build,
  so script hashes computed during the build (Next.js `experimental.sri`,
  webpack SRI plugins) no longer match. Recompute them after injecting, or
  leave SRI off for these bundles.
