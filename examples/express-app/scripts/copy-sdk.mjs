/**
 * Copies the built @autter/runtime-browser into public/sdk/ so the page can
 * import it without a bundler. Every built .js file is copied, not only
 * index.js: index.js imports shared chunks (chunk-*.js), and a page missing
 * one fails to load the tracker with nothing but a 404 in the console.
 * Plain Node, so it runs the same on Windows, macOS and Linux.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "public", "sdk");

let entry;
try {
	entry = createRequire(import.meta.url).resolve("@autter/runtime-browser");
} catch {
	console.error(
		"Can't find a built @autter/runtime-browser. In the autter-runtime repo, run `npm install` and " +
			"`npm run build -w @autter/runtime-browser` first; elsewhere, `npm install @autter/runtime-browser`.",
	);
	process.exit(1);
}
const dist = dirname(entry);
const files = readdirSync(dist).filter((name) => name.endsWith(".js") || name.endsWith(".js.map"));

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of files) copyFileSync(join(dist, name), join(target, name));

// Fail here, loudly, rather than in the browser: every relative import of
// every copied file must be there too.
const missing = [];
for (const name of files.filter((n) => n.endsWith(".js"))) {
	const source = readFileSync(join(target, name), "utf8");
	for (const [, spec] of source.matchAll(/(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
		if (!existsSync(join(target, spec))) missing.push(`${name} imports ${spec}`);
	}
}
if (missing.length) {
	console.error(`public/sdk is incomplete:\n  ${missing.join("\n  ")}`);
	process.exit(1);
}
console.log(`Copied ${files.length} file(s) from ${dist} to public/sdk/`);
