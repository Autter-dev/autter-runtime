import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts" },
	format: ["esm", "cjs"],
	dts: { resolve: ["@autter/runtime-core"] },
	// Workers / Vercel Edge / Deno / Bun all run ES2022.
	target: "es2022",
	platform: "neutral",
	clean: true,
	// Private workspace package — inlined so the published package keeps
	// zero dependencies.
	noExternal: ["@autter/runtime-core"],
});
