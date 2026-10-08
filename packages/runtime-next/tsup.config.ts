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
		entry: { edge: "src/edge.ts" },
		format: ["esm", "cjs"],
		dts: true,
		target: "es2022",
		platform: "neutral",
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
