import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { index: "src/index.ts", server: "src/server.ts" },
		format: ["esm", "cjs"],
		dts: true,
		target: "node20",
		clean: true,
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
