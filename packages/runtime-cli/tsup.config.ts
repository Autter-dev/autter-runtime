import { defineConfig } from "tsup";

export default defineConfig([
	{
		// Library entries: ESM + CJS, because next.config.js and
		// webpack.config.js are often CommonJS.
		entry: {
			index: "src/index.ts",
			vite: "src/vite.ts",
			webpack: "src/webpack.ts",
			next: "src/next.ts",
		},
		format: ["esm", "cjs"],
		dts: true,
		target: "node20",
		platform: "node",
		// No `clean`: both configs build in parallel; the build script empties dist/.
	},
	{
		// The `autter-runtime` bin (ESM; the shebang is kept by tsup).
		entry: { cli: "src/cli.ts" },
		format: ["esm"],
		target: "node20",
		platform: "node",
	},
]);
