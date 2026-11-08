import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import webpack from "webpack";
import { AutterSourceMapsWebpackPlugin } from "@autter/runtime-cli/webpack";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, process.env.E2E_OUT_DIR ?? "dist/webpack");

/** index.html with the content-hashed bundle in place of Vite's dev entry. */
class HtmlPlugin {
	apply(compiler) {
		compiler.hooks.thisCompilation.tap("e2e-html", (compilation) => {
			compilation.hooks.processAssets.tap({ name: "e2e-html", stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE }, () => {
				const entry = [...compilation.entrypoints.get("main").getFiles()].find((file) => file.endsWith(".js"));
				const html = readFileSync(join(here, "index.html"), "utf8").replace(
					'<script type="module" src="/src/main.js"></script>',
					`<script defer src="/${entry}"></script>`,
				);
				compilation.emitAsset("index.html", new webpack.sources.RawSource(html));
			});
		});
	}
}

// Production webpack 5 with its default minifier (terser), so the bundle is
// minified differently from the Vite builds of the same code.
export default {
	mode: "production",
	context: here,
	entry: "./src/main.js",
	output: { path: out, publicPath: "/", filename: "static/js/[name].[contenthash:8].js", clean: true },
	plugins: [
		new webpack.DefinePlugin({ __AUTTER_RELEASE__: JSON.stringify(process.env.AUTTER_RELEASE ?? "") }),
		new HtmlPlugin(),
		new AutterSourceMapsWebpackPlugin({ release: process.env.AUTTER_RELEASE }),
	],
};
