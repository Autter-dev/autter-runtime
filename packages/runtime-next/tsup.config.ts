import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { index: "src/index.ts", server: "src/server.ts" },
		format: ["esm", "cjs"],
		dts: true,
		target: "node20",
		// No `clean` here: the configs build in parallel and a clean in
		// one would race the others' declaration output. The build script
		// empties dist/ first instead.
		// Optional, resolved at runtime (after() wiring) — never bundled.
		external: ["next", "next/server"],
	},
	{
		// Runtime-neutral entries: no Node modules at the top level. The
		// default instrumentation build loads @autter/runtime-node lazily on
		// the Node runtime only; instrumentation-edge never references it.
		entry: {
			edge: "src/edge.ts",
			instrumentation: "src/instrumentation.ts",
			"instrumentation-edge": "src/instrumentation-edge.ts",
		},
		format: ["esm", "cjs"],
		dts: true,
		target: "es2022",
		platform: "neutral",
		// CJS: load @autter/runtime-node with require(), like the CJS root
		// entry does, so both reach the same module instance (and the same
		// tracker started by registerAutter). ESM keeps import().
		esbuildOptions(options, { format }) {
			if (format === "cjs") options.supported = { ...options.supported, "dynamic-import": false };
		},
	},
	{
		// Browser build of the root (the "browser" export condition): the
		// isomorphic error helpers and stand-ins for the server-only names.
		// No Node modules, no @autter/runtime-node, no React.
		entry: { "index.browser": "src/index.browser.ts" },
		format: ["esm", "cjs"],
		dts: { resolve: ["@autter/runtime-core"] },
		// es2020, not the client entry's es2019: runtime-core uses BigInt
		// literals (in code this entry tree-shakes away, but esbuild parses it).
		target: "es2020",
		platform: "browser",
		// Private workspace package: inlined, like runtime-node and runtime-edge do.
		noExternal: ["@autter/runtime-core"],
		// esbuild's browser platform would bake in NODE_ENV=development; leave
		// `process.env.NODE_ENV` for the app's bundler to replace.
		esbuildOptions(options) {
			options.define = { ...options.define, "process.env.NODE_ENV": "process.env.NODE_ENV" };
		},
	},
	{
		// Edge build of the root ("edge-light" / "worker"): the same contract,
		// error helpers from @autter/runtime-edge.
		entry: { "index.edge": "src/index.edge.ts" },
		format: ["esm", "cjs"],
		dts: { resolve: ["@autter/runtime-core"] },
		target: "es2022",
		platform: "neutral",
		noExternal: ["@autter/runtime-core"],
	},
	{
		entry: { client: "src/client.ts" },
		format: ["esm", "cjs"],
		dts: true,
		target: "es2019",
		external: ["react"],
		// Next.js needs the directive on the bundled file, or the error
		// boundary can't be used from server-component trees.
		banner: { js: '"use client";' },
	},
]);
