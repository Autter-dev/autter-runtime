import { defineConfig } from "vite";
import { autterSourceMaps } from "@autter/runtime-cli/vite";

// AUTTER_RUNTIME_KEY / AUTTER_ENDPOINT / AUTTER_RELEASE come from the
// environment, as in CI. E2E_MINIFY picks the minifier ("oxc", Vite's
// default, or "terser"), so two builds of the same code differ.
export default defineConfig({
	define: { __AUTTER_RELEASE__: JSON.stringify(process.env.AUTTER_RELEASE ?? "") },
	build: {
		outDir: process.env.E2E_OUT_DIR ?? "dist/vite",
		emptyOutDir: true,
		minify: process.env.E2E_MINIFY ?? "oxc",
	},
	plugins: [autterSourceMaps({ release: process.env.AUTTER_RELEASE })],
});
