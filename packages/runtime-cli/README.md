# @autter/runtime-cli

Readable stack traces for Autter Runtime. Gives every JS bundle a
content-addressed **debug id** and uploads its **source map** to the ingester,
so minified browser frames and bundled Node and edge frames resolve to your
original source, with the lines around each frame of your code, even when the
release your SDK reports doesn't match the upload.

- `autter-runtime sourcemaps setup` wires it into a project; `verify` checks a build
- `autter-runtime sourcemaps inject <dir>` / `upload <dir>` CLI, for browser
  and server output alike (tsup, esbuild, a Worker)
- Vite/Rollup plugin: `@autter/runtime-cli/vite` (SSR builds and server
  environments too)
- webpack 5 plugin: `@autter/runtime-cli/webpack` (Node targets too)
- Next.js wrapper: `withAutterSourceMaps` from `@autter/runtime-cli/next`
  (client and `.next/server` output)

Bundlers are optional peer dependencies. Debug ids need ingester 1.6.0+ and
`@autter/runtime-browser` 1.6.0+ (older ingesters still match `.js` maps by
release + path). Server bundles and source contents need the current
ingester. Full guide: [docs/SOURCE-MAPS.md](../../docs/SOURCE-MAPS.md).

## Quick start (people and coding agents)

```bash
npx @autter/runtime-cli@latest sourcemaps setup          # in the app's directory
npm run build                                             # with AUTTER_RUNTIME_KEY set
npx autter-runtime sourcemaps verify dist                 # before deploying
```

**`setup [dir]`** is non-interactive and safe to re-run. It detects the build
tool (Vite and the frameworks built on it: SvelteKit, Nuxt, Astro, Remix,
React Router, Solid, Qwik; Next.js; webpack and Vue CLI; Rollup; Create React
App; Angular CLI; Parcel; esbuild), the package manager, the CI (GitHub
Actions, Vercel, Netlify, Cloudflare Pages, GitLab CI), the output directory,
existing source map settings, the installed browser SDK, and whether
`initAutterBrowser` gets a `release`. Then it:

- adds `@autter/runtime-cli` to `devDependencies` and prints the install
  command (`--install` runs it);
- adds the Vite/Rollup or webpack plugin, or wraps the Next.js config in
  `withAutterSourceMaps` (outermost), when the config has a shape it can edit
  safely: `export default defineConfig({...})`, `module.exports = {...}`, a
  config variable, a function returning an object, `withX(nextConfig)`
  wrappers. It parses the file (JavaScript or TypeScript) and changes only
  what it adds; anything else becomes a `manual` action with the exact snippet;
- for builds without a plugin (CRA, Angular, Parcel, esbuild), adds a
  `postbuild` step (appended to `build` for pnpm, Yarn 2+ and Bun, which skip
  `postbuild`) that runs `inject`, then `upload --delete-after-upload
  --best-effort`, and turns on hidden maps where the tool can
  (`GENERATE_SOURCEMAP=true`, Angular `"sourceMap": { "scripts": true, "hidden": true }`);
- reports, never edits, app code: a missing `release` gets a `manual` action
  showing how to pass the commit SHA through the tool's public env or define
  mechanism;
- never writes a key. It says where to store `AUTTER_RUNTIME_KEY` for each CI
  it found, with commands that read the value from a prompt or stdin, never
  from argv: `gh secret set AUTTER_RUNTIME_KEY --repo <owner/repo>`,
  `vercel env add AUTTER_RUNTIME_KEY production`, `netlify env:set …
  "$(cat)"`, and dashboard notes for Cloudflare Pages and GitLab.

`--dry-run` writes nothing; `--json` prints `{ detected, actions: [{ type:
"edit"|"add-dependency"|"add-script"|"manual"|"set-secret", file?,
description, snippet?, command? }], secret: { name, key, where }, next }`.
Exit codes: `0` everything applied, `2` manual actions remain, `1` error.

**`verify <dir>`** checks a production build before deploy: every JS bundle
has a debug id (the comment and the registration snippet), no `.map` file is
left and no `sourceMappingURL` points at a missing map (both deploy risks),
and, when `AUTTER_RUNTIME_KEY` is set, every bundle's map is on the ingester
(`/v1/sourcemaps/check` by debug id, ingester 1.7.0+). Without a key the
local checks still run and the upload is reported as unverified. Files copied
unchanged from `public/`, Next.js build manifests and polyfills, and service workers are
skipped; `--ignore <glob>` skips more. `--allow-maps` reports leftover maps
without failing. `--server` checks server output (a tsup or esbuild `dist/`,
`.next/server`), where leftover maps are a note, not a failure, and Next.js
server manifests are skipped. `--json` for machines; exit `1` on any failure,
with the reason per file.

## Keys

Set `AUTTER_RUNTIME_KEY` where your build runs. The recommended key for CI is
an **upload-only key** (`autter_rtu_…`): it can upload and check source maps
and nothing else, so a leaked CI secret can't send telemetry. The full server
key (`autter_rt_…`) also works. A publishable client key (`autter_rtc_…`) is
refused. Upload keys need ingester 1.7.0+. Without a key, the plugins turn no
source maps on and change nothing, and `upload --best-effort` uploads nothing
and exits 0.

## By hand

```bash
npm install -D @autter/runtime-cli
```

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
debug ids after the build, upload when a key is present, and then delete the
maps they created whether or not the upload succeeded (a rejected upload, an
unreachable ingester, a dry run), printing one line that says why; without a
key they turn none on. Maps you configured yourself are left alone.

Server bundles get the same: Vite SSR builds and Vite 6 server environments,
webpack builds for a Node target, and Next.js `.next/server` (Node and edge,
webpack and Turbopack). Their maps are stored under the output directory's
path in the project (`/dist/server/`, `/.next/server/`), which the ingester
matches against the path the server runs them from, never under the public
URL prefix.

Options (all optional): `release`, `urlPrefix`, `endpoint`, `key`,
`upload: false`, `deleteAfterUpload`, `dryRun`, `concurrency`, `failOnError`
(default `false`: a failed upload is logged and never fails the build),
`silent`, `sourcesContent: false` (upload maps without your files' source),
`serverBundles: false` (leave server output exactly as the bundler wrote it).

## CLI

```bash
npx autter-runtime sourcemaps inject dist
npx autter-runtime sourcemaps upload dist --url-prefix / --release "$GIT_SHA"
npx autter-runtime sourcemaps upload dist --dry-run

# A bundled Node server (tsup, esbuild): the same commands
npx autter-runtime sourcemaps inject dist
npx autter-runtime sourcemaps upload dist --url-prefix /dist/
npx autter-runtime sourcemaps verify dist --server
```

```
autter-runtime sourcemaps setup [dir] [--dry-run] [--install] [--json]
autter-runtime sourcemaps verify <dir> [--endpoint <url>] [--url-prefix <prefix>]
              [--ignore <glob>]... [--allow-maps] [--server] [--json]
autter-runtime sourcemaps inject <dir> [--dry-run] [--json]
autter-runtime sourcemaps upload <dir> [--release <r>] [--url-prefix <prefix>]
              [--endpoint <url>] [--concurrency <n>] [--delete-after-upload]
              [--no-sources-content] [--best-effort] [--dry-run] [--json]
```

- **inject** writes `//# debugId=<id>`, a one-line snippet that registers
  `globalThis._autterDebugIds[new Error().stack] = "<id>"`, and `"debugId"` in
  the `.map`, for each `.js`/`.mjs`/`.cjs` with a map. The id is derived from
  sha256 of the bundle bytes; running it again changes nothing. The browser
  SDK and the Node and edge SDKs read the snippet's registry and send the ids
  of the bundles in each exception's stack.
- **upload** posts each map (gzipped, up to 32 MB) to
  `<endpoint>/v1/sourcemaps`, in parallel, skipping maps the ingester already
  has. Each map carries the bundle's function scopes (`x_autter_scopes`),
  parsed from the file as served, so frames are named after the function they
  are in rather than their call site; a bundle that does not parse is uploaded
  without them, with a warning. It also carries the original source of your own
  files (`sourcesContent`; never your dependencies', whole files only, as many
  as fit the 32 MB limit), so issues show the lines around each frame;
  `--no-sources-content` leaves it out. For server output, `--url-prefix` is
  any tail of the path the server runs the files from (`/dist/` for
  `/app/dist/server.js`), or `/`. Release: `--release`, else `GITHUB_SHA`,
  `VERCEL_GIT_COMMIT_SHA`, `CF_PAGES_COMMIT_SHA`, `GIT_SHA`, then
  `git rev-parse HEAD`.
- **upload --best-effort** is for build scripts that also run locally and in
  fork PRs: without a key, or when the upload fails, it says so and exits 0;
  with `--delete-after-upload`, every `.map` under `<dir>` is then deleted
  anyway, so the output is the same with or without a key and never ships
  maps.

Exit codes: `0` ok, `1` some maps failed, `2` no key / no release / key
rejected, `64` usage error (`--best-effort`: always `0`). `setup` and `verify`
have their own, above.

## Programmatic API

```ts
import { injectDir, uploadDir, verifyDir } from "@autter/runtime-cli";

await injectDir("dist");
const summary = await uploadDir("dist", { urlPrefix: "/", release: process.env.GIT_SHA, deleteAfterUpload: true });
const check = await verifyDir("dist"); // check.ok, check.failures, check.upload.status
```
