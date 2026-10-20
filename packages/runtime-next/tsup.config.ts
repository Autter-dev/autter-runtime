import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { index: "src/index.ts", server: "src/server.ts" },
		format: ["esm", "cjs"],
		dts: true,
		target: "node20",
		// No `clean` here: the three configs build in parallel and a clean in
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
