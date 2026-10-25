# Readable stack traces: source maps and debug ids

Production JavaScript is minified or bundled, so a browser stack trace points
at `/assets/index-4f3c.js:1:58213` and a bundled backend's at
`/app/dist/server.js:1:90417`. Upload your build's source maps and Autter
resolves each frame to the original file, line and function before it groups
the error and prepares a fix, and shows the lines of your code around each
frame on the issue.

`@autter/runtime-cli` does this for you, for browser bundles and for server
bundles alike (tsup, esbuild, webpack and Next.js server output, Vite SSR; see
[Server bundles](#server-bundles)):

1. **Inject.** Every `.js`, `.mjs` and `.cjs` bundle that has a source map gets
   a *debug id*: a UUID derived from the sha256 of the bundle's bytes, so the
   same build output always gets the same id. The CLI appends a
   `//# debugId=<id>` comment, adds a one-line snippet that registers the id
   with the SDK running the bundle, and writes `"debugId"` into the `.map`.
2. **Upload.** Every map goes to the ingester's `POST /v1/sourcemaps`,
   gzipped, with an upload or server key, its debug id, the release, the path the
   bundle is served from, the bundle's function scopes (see **Function
   names** under [How the pieces fit](#how-the-pieces-fit)) and the original
   source of your own files (`sourcesContent`; see **Source contents**).
   Maps the ingester already has are skipped.
3. **Match.** `@autter/runtime-browser` 1.6.0+, and the Node and edge SDKs
   (`autter.debug_ids`), send with each exception the debug ids of the bundles
   in its stack. The ingester finds the map by debug id first, and by release +
   path when there is none (for a server bundle, the release's map stored
   under the longest tail of the path the process ran it from). A debug id
   names the exact bytes that ran, so maps match even when the `release` your
   SDK reports differs from the one you uploaded under (or is missing).

Debug ids need ingester 1.6.0+ (compat feature `source_map_debug_ids`,
migration `0017-source-maps-debug-id`). Older ingesters still accept `.js`
maps by release + path; the CLI warns and uploads everything.

## The quick path: `setup`, then `verify`

Two commands do the whole job, and both are built for coding agents as much
as for people: non-interactive, `--json` output, meaningful exit codes.

```bash
npx @autter/runtime-cli@latest sourcemaps setup            # once, in the app's directory
# store AUTTER_RUNTIME_KEY where the production build runs (setup says how)
npm run build                                               # the production build
npx autter-runtime sourcemaps verify dist                   # before every deploy
```

`autter-runtime sourcemaps setup [dir]` detects the project and wires in the
right integration from the table below. Safe to re-run: a second run changes
nothing and lists only what is left.

- **Detects** the build tool (Vite and the frameworks that build with it:
  SvelteKit, Nuxt, Astro, Remix, React Router, Solid, SolidStart, Qwik;
  Next.js; webpack, Vue CLI; Rollup; Create React App; Angular CLI; Parcel;
  esbuild scripts), the package manager (`packageManager` field, then the
  lockfile), the CI (`.github/workflows`, `vercel.json`/`.vercel` or `VERCEL`,
  `netlify.toml`, Cloudflare Pages through wrangler, `.gitlab-ci.yml`), the
  output directory and URL prefix, the source map settings already there, the
  installed `@autter/runtime-browser` or `@autter/runtime-next` (debug ids
  need 1.6.0+), and whether `initAutterBrowser` gets a `release`.
- **Edits** what it can edit confidently: `@autter/runtime-cli` in
  `devDependencies` (`--install` also runs the package manager); the plugin in
  `vite.config.*` (under `vite` for Nuxt and Astro), `rollup.config.*`,
  `webpack.config.*` (under `configureWebpack` for Vue CLI), or
  `withAutterSourceMaps(...)` around the exported Next.js config, outermost
  around any `withX(...)` wrappers. Config files are parsed (JavaScript or
  TypeScript, with acorn) and only the import and the plugin are spliced in,
  in the file's own quote and semicolon style. Recognised shapes:
  `export default` / `module.exports =` an object literal, a
  `define…Config({...})` call, a top-level variable holding one, or a
  function that returns one. Anything else (`mergeConfig(...)`, `plugins:
  getPlugins()`, a spread that may already set `plugins`, a file that does not
  parse) is left untouched and reported as a `manual` action with the snippet.
- **Builds without a plugin** (Create React App, Angular, Parcel, esbuild,
  unrecognised tools with a known output directory) get a `postbuild` script,
  or the same commands appended to `build` for pnpm, Yarn 2+ and Bun, which
  don't run `postbuild`:

  ```bash
  autter-runtime sourcemaps inject build && autter-runtime sourcemaps upload build --delete-after-upload --best-effort
  ```

  `--best-effort` keeps local builds and fork PRs (no key) green, and with
  `--delete-after-upload` it deletes every map in the output whatever
  happened, so maps are never deployed. Setup also turns on maps where the
  tool supports hidden ones: `GENERATE_SOURCEMAP=true` when a `.env` file
  turned them off (CRA), `"sourceMap": { "scripts": true, "styles": false,
  "hidden": true, "vendor": false }` in Angular's production configuration;
  for esbuild and Parcel it says which flag to change.
- **Reports, never edits, app code.** When `initAutterBrowser` has no
  `release`, a `manual` action shows how to pass the commit SHA through the
  tool's public env or define mechanism (`define` with
  `import.meta.env.VITE_AUTTER_RELEASE`, `env.NEXT_PUBLIC_AUTTER_RELEASE`,
  `REACT_APP_AUTTER_RELEASE`, `DefinePlugin`, Angular `--define`), reading
  the detected CI's commit variable.
- **Never writes a key.** `secret.where` lists, per detected CI, where
  `AUTTER_RUNTIME_KEY` goes, with commands that read the value from a prompt
  or stdin so it stays out of shell history: `gh secret set
  AUTTER_RUNTIME_KEY --repo <owner/repo>` (from the git remote), `vercel env
  add AUTTER_RUNTIME_KEY production`, `netlify env:set AUTTER_RUNTIME_KEY
  "$(cat)" --context production --scope builds --secret`, and dashboard notes
  for Cloudflare Pages build variables and GitLab masked CI variables. For
  GitHub Actions it also asks you to pass the secret to the build step.

`--dry-run` writes nothing and reports the same plan. `--json` prints
`{ detected, actions, secret, next }`, where each action is `{ type:
"edit" | "add-dependency" | "add-script" | "manual" | "set-secret", file?,
description, snippet?, command? }`. Exit codes: `0` everything was applied,
`2` manual actions remain, `1` error (for example no `package.json`).

`autter-runtime sourcemaps verify <dir>` checks the output that is about to
be deployed:

- every `.js`/`.mjs`/`.cjs` bundle has a debug id: the `//# debugId=` comment
  and the registration snippet, with the same id;
- no `.map` file is left in `<dir>`, and no `sourceMappingURL` points at a
  map that is not there (or inlines one as a `data:` URL): both are deploy
  risks;
- with `AUTTER_RUNTIME_KEY` set, every bundle's map is on the ingester. It
  asks `POST /v1/sourcemaps/check` by debug id alone (ingester 1.7.0+), which
  works after the maps were deleted and finds exactly what symbolication
  would. Without a key, the local checks pass or fail on their own and the
  upload state is reported as unverified.

Files copied unchanged from `public/` (or `static/`, `src/`), Next.js build
manifests and polyfills, and service workers are skipped; `--ignore <glob>` skips more.
`--allow-maps` reports leftover maps without failing, for a step that runs
before they are removed. `--server` checks server output (`dist/` of a tsup or
esbuild build, `.next/server`): browsers never load it, so leftover maps are a
note there, and Next.js server manifests are skipped. It exits `1` on any failure, with the reason per
file, and `--json` prints `{ ok, bundles, maps, upload, failures }`.

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

Every integration reads the key from `AUTTER_RUNTIME_KEY`, and only where the
build runs (never in the browser bundle). Use an **upload-only key**
(`autter_rtu_…`, ingester 1.7.0+) in CI: it can upload and check source maps
and nothing else, so a leaked CI secret can't send or forge telemetry. The
full server key your backend uses (`autter_rt_…`) also works. A publishable
`autter_rtc_…` key is refused. Without a key, a plugin turns no source maps on
and injects nothing, so local builds are exactly what they were; it prints one
line saying so.

**Maps a plugin turned on are never left behind.** When you haven't
configured source maps, a plugin turns hidden ones on for the upload and
deletes every one of them afterwards (JS and CSS maps, and any
`sourceMappingURL` comment naming them), whatever happened to the upload:
uploaded, rejected (a 413 from an older ingester, a bad key), the ingester
unreachable, or a dry run. One line says how many it removed and why, for
example `removed 12 source map(s) this plugin generated, so they are not
deployed: 3 of 12 could not be uploaded (HTTP 413: …)`. Bundles keep their
debug ids, so a later upload can still match them. Maps you configured
yourself (`build.sourcemap`, `output.sourcemap`, a webpack `devtool`,
`productionBrowserSourceMaps`) are never deleted unless you set
`deleteAfterUpload: true`, and then only once uploaded. With `upload: false`
(upload later with the CLI) or `deleteAfterUpload: false`, the generated maps
are kept and the plugin warns that they must not be deployed.

Every plugin also handles server bundles (Vite SSR and server environments,
webpack Node targets, Next.js `.next/server`; see
[Server bundles](#server-bundles)) and sends your own files' source with each
map. `serverBundles: false` leaves server output alone; `sourcesContent:
false` uploads maps without source.

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
server environments are server bundles: they get the same, stored under their
output directory's path in the project (`/dist/server/`) instead of `base`
(see [Server bundles](#server-bundles)); `serverBundles: false` leaves them
alone. With plain Rollup, use the same import (or
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
`output.publicPath` (`/` when it is `"auto"`), then deletes every map asset
the build emitted when the devtool was its own. Development builds are left
alone. A build for a Node target (`target: "node"`, `"node18"`,
`"async-node"`, `"electron-main"`) is a server bundle, stored under its
`output.path` relative to the project instead of `output.publicPath`.

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
wrapper turns on, then deletes every map under `.next/static` with the
`sourceMappingURL` comments that name them).
Older versions use the webpack plugin. If you already set
`productionBrowserSourceMaps: true`, your maps stay public and on disk.

The server output (`.next/server`, Node.js and edge runtimes) gets the same:
hidden maps for webpack server compilations (and, on 15.4.1+,
`experimental.serverSourceMaps` for Turbopack), debug ids in every server
chunk that has a map, and an upload under `/.next/server/…` (the server
directory's path in the project), which the ingester matches against
`/var/task/.next/server/app/page.js`, `/app/.next/server/…` in a container, or
a standalone build. The maps the wrapper turned on are deleted after the
upload step; a server `devtool` your own `webpack()` function sets, or an
`experimental.serverSourceMaps` you set, is yours: uploaded, never deleted.
`serverBundles: false` leaves the server output and those settings alone.
The wrapper lives in `@autter/runtime-cli` rather than `@autter/runtime-next`
so build-time code never becomes a runtime dependency of your app.

### Server bundles

Node and edge code you bundle (tsup, esbuild, webpack, Rollup, Vite SSR,
Next.js server output, a Cloudflare Worker) gets readable stack traces the
same way as browser code: inject, upload, and the ingester resolves Node and
edge frames at ingest, before it groups the error.

```bash
# tsup / esbuild: build with maps (tsup: sourcemap: true; esbuild: --sourcemap)
npx autter-runtime sourcemaps inject dist
AUTTER_RUNTIME_KEY=autter_rtu_… npx autter-runtime sourcemaps upload dist --url-prefix /dist/
npx autter-runtime sourcemaps verify dist --server
```

- **Matching.** The Node and edge SDKs send the debug ids of the bundles in
  each exception's stack (`autter.debug_ids`), so a map is found whatever path
  the host runs the bundle from. Without one (an older SDK, a plain
  OpenTelemetry SDK), the event's release (`service.version`) must equal the
  upload release, and the ingester takes the release's map whose stored path
  is the longest tail of the frame's path: `/dist/server.js` matches
  `/app/dist/server.js`, `/srv/app/dist/server.js` and
  `C:\app\dist\server.js`. So `--url-prefix` for server output is any tail of
  the deployed path (the plugins use the output directory's path in the
  project, such as `/dist/server/`); `/` works when the bundle's path in the
  directory is unique. Keep server and browser maps of one release under
  different paths (`/dist/` vs `/assets/`): one release stores one map per path.
- **Which frames.** Only in-app `.js`/`.mjs`/`.cjs` frames are looked up:
  `node_modules/` (unbundled dependencies) and `node:` frames never belong to
  an upload. Frames already readable (an unbundled app, or Node's own
  `--enable-source-maps`) are left as they are when no map was uploaded.
- **Leftover maps.** Server output is not served to browsers, so
  `verify --server` reports `.map` files there as a note instead of a failure.
- **Grouping.** A server issue's frames-v3 identity hashes the frames as
  resolved, so the first upload of maps for an existing bundled service
  starts new issues for its errors (once), exactly as it did for browser code.

### CLI

```bash
npx autter-runtime sourcemaps inject dist
AUTTER_RUNTIME_KEY=autter_rtu_… npx autter-runtime sourcemaps upload dist \
  --url-prefix / --release "$GIT_SHA"
npx autter-runtime sourcemaps verify dist
```

| Option | Meaning |
| --- | --- |
| `--release <r>` | Release to upload under (default: see above) |
| `--url-prefix <p>` | Where the directory is served from: `/` (default), `/static/`, `https://cdn.example.com/app/`. `~/` means `/`. |
| `--endpoint <url>` | Ingester base URL (default `$AUTTER_ENDPOINT`, `$AUTTER_RUNTIME_ENDPOINT`, `$OTEL_EXPORTER_OTLP_ENDPOINT`, then `https://otlp.autter.dev`) |
| `--concurrency <n>` | Parallel uploads (default 8) |
| `--delete-after-upload` | Delete each `.map` (and its `sourceMappingURL` comment) once uploaded |
| `--no-sources-content` | Upload maps without your files' original source (issues then show no lines around a frame) |
| `--best-effort` | Never fail (for build scripts): no key or a failed upload is reported and exits `0`; with `--delete-after-upload`, every `.map` under the directory is then deleted anyway |
| `--server` (verify) | The directory is server output: leftover `.map` files are a note, not a failure |
| `--dry-run` | Show what would change or be uploaded; write and send nothing |
| `--json` | Machine-readable output |

`inject` is idempotent: run it twice and the second run changes nothing.
Run it **before** you upload and **before** you deploy, on the exact files you
deploy. Exit codes: `0` success, `1` some maps failed, `2` no key / no
release / key rejected, `64` usage error (`0` whatever happened with
`--best-effort`).

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

Inputs: `directory`, `key` (required: an upload-only `autter_rtu_…` key, or
the server key), `release` (default `GITHUB_SHA`), `url-prefix`, `endpoint`,
`inject` (`"false"` if a bundler plugin already injected),
`delete-after-upload`, `verify` (default `"true"`: runs `sourcemaps verify`
after the upload and fails the step on a problem; leftover maps only fail it
with `delete-after-upload: "true"`; skipped with a notice for runtime-cli
before 1.2.0), `verify-ignore` (space-separated globs of JS files that are not
bundles), `cli-version`.

## How the pieces fit

**The debug id** is the first 16 bytes of sha256(bundle bytes), formatted as a
version-4 UUID. A bundle whose bundler already wrote `//# debugId=` (Rollup's
`sourcemapDebugIds`, Turbopack, webpack `-debugids` devtools) keeps that id and
only gains the snippet.

**The snippet** is one line of ES5:

```js
;!function(){try{var g=…globalThis…,s=(new g.Error).stack;s&&((g._autterDebugIds=g._autterDebugIds||{})[s]="<id>")}catch(e){}}();
```

The stack's first frame names the URL the browser loaded the bundle from, or
the file Node or the edge runtime ran; `@autter/runtime-browser` maps that URL
to the id and attaches `debugIds: { "<script URL>": "<id>" }` (query and hash
removed) to exceptions, and the Node and edge SDKs attach
`autter.debug_ids` (`{ "<script path as in the stack>": "<id>" }`, a JSON
string, on the exception event or promoted log record), only for bundles that
appear in the exception's stack or its causes' stacks. The snippet goes on the
first line, so a bundle that throws while loading is still identified; the
map's `mappings` are shifted down one line to match. Bundles that start with a
directive (`"use strict"`, `"use client"`) get it appended instead, which moves
nothing. Running inject again changes nothing.

**Source contents.** Each map carries the original source of your own files
(`sourcesContent`, when the bundler wrote it; esbuild, tsup, Vite and webpack
do by default), so an issue shows the line of each in-app frame with up to 5
lines on each side. Only in-app sources are sent and kept: a source the map's
`ignoreList` names, or whose path is under `node_modules/`, `/.pnpm/`,
`/vendor/` and the like, gets `null`. Contents are kept whole (never cut, so
line numbers stay right), smallest first, while the map fits the 32 MiB limit
in UTF-8 bytes; a file that does not fit gets `null`. The CLI and the ingester
apply exactly the same rule, so the content hash the CLI computes is the one
stored. The lines attached to an occurrence are cut to 300 characters and
scrubbed like stacks (keys, tokens, emails). `--no-sources-content` (or
`sourcesContent: false` in a plugin) uploads maps without it, as before.

**Storage.** `runtime_source_maps` (ReplacingMergeTree, 30-day TTL) keeps one
map per org, repository, release and path, now with `debug_id` and
`content_hash`, in a ZSTD-compressed `String` column, with the in-app
`sourcesContent` described above. A stored map may be up to
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
the other maps, at the cost of fetching it again for the next event. A map's
`sourcesContent` is never part of its entry, so it caches exactly as it would
without it: the contents of a cached map are kept in a separate store, one
file per entry, bounded the same way (same budget, least recently used first,
a file over half the budget not kept) and dropped with the map. A frame whose
file was not kept resolves as usual, without context lines.

**Lookup.** Symbolication calls
`lookupSourceMap(client, database, { orgId, repositoryId, release, filename, debugId, suffix })`
(`packages/otlp-ingester/src/source-maps-lookup.ts`): by debug id first, then
by release + path (origin, query and hash removed). Server frames
(`suffix`) take the release's map stored under the longest tail of the
frame's path (`file://` URLs and Windows paths are made plain paths first):
one primary-key range scan of the release's paths, `ORDER BY
length(filename) DESC`.

## Troubleshooting

- **`403 upload_key_not_allowed`.** An upload-only key (`autter_rtu_…`) was
  used for telemetry. It only works on `/v1/sourcemaps` and
  `/v1/sourcemaps/check`; backends and the browser relay need the server key.
- **`the ingester rejected the key (401) … upload keys … need ingester
  1.7.0`.** The ingester predates upload keys (or the key is wrong). Upgrade
  the ingester, or use the server key.
- **`verify`: `upload: unverified … predates 1.7.0`.** The ingester can't
  check maps by debug id; the local checks still ran. Upgrade it to verify
  uploads too.

- **Frames stay minified.** Check that you deployed the files you injected
  (inject after any later minification or copying step), that the browser SDK
  is 1.6.0+, and that the ingester is 1.6.0+ (`GET /v1/compat` lists
  `source_map_debug_ids`). Without debug ids, the SDK `release` must equal the
  upload release and `--url-prefix` must match the served path.
- **Server frames stay bundled** (`/app/dist/server.js:1:90417`). Check that
  the deployed bundle is the injected one, and that either the SDK sends
  debug ids (the Node and edge SDKs do for injected bundles; a plain
  OpenTelemetry SDK does not) or the event's `service.version` equals the
  upload release and the stored path (`--url-prefix` + the path in the
  directory) is a tail of the path the process runs the bundle from.
- **No lines around a frame on the issue.** The map was uploaded without
  `sourcesContent` (the bundler did not write it, `--no-sources-content`, an
  older CLI or ingester, or the file did not fit the 32 MB limit), or the
  frame is not in-app.
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
