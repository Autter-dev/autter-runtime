import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts", testing: "src/testing.ts" },
	format: ["esm", "cjs"],
	dts: { resolve: ["@autter/runtime-core"] },
	target: "node20",
	clean: true,
	// One shared chunk for logger state: `./testing` must observe the SAME
	// AsyncLocalStorage and sinks as the main entry, in ESM and CJS alike.
	splitting: true,
	// Private workspace package — inlined so the published package has no
	// dependency on it.
	noExternal: ["@autter/runtime-core"],
});
