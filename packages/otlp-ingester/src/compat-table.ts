/**
 * The one compatibility table (docs/COMPATIBILITY.md), generated from
 * compat-manifest.json so no page can state a different minimum version.
 * compat.test.ts fails when the document and the manifest disagree;
 * `node scripts/compat-table.mjs --write` (after building the ingester)
 * rewrites it.
 */
import { COMPAT_MANIFEST, type CompatManifest } from "./compat.js";

export const COMPAT_TABLE_START = "<!-- compat-table:start (generated from packages/otlp-ingester/src/compat-manifest.json: node scripts/compat-table.mjs --write) -->";
export const COMPAT_TABLE_END = "<!-- compat-table:end -->";

const SDK_COLUMNS: Array<[string, string]> = [
	["@autter/runtime-node", "runtime-node"],
	["@autter/runtime-next", "runtime-next"],
	["@autter/runtime-browser", "runtime-browser"],
	["@autter/runtime-edge", "runtime-edge"],
];

export function compatTableMarkdown(manifest: CompatManifest = COMPAT_MANIFEST): string {
	const header = ["Feature", "Ingester", ...SDK_COLUMNS.map(([, label]) => label), "Route", "ClickHouse migrations"];
	const rows = manifest.features.map((feature) => {
		const sdkCells = SDK_COLUMNS.map(([name]) => (feature.sdks[name] ? `${feature.sdks[name]}+` : "–"));
		return [
			`${feature.title} (\`${feature.id}\`)`,
			`${feature.ingester}+`,
			...sdkCells,
			feature.route ? `\`${feature.route}\`` : "",
			feature.migrations.map((m) => `\`${m}\``).join(", "),
		];
	});
	const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
	return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

/** Replace the generated block in a document; throws when the markers are missing. */
export function withCompatTable(document: string, manifest: CompatManifest = COMPAT_MANIFEST): string {
	const start = document.indexOf(COMPAT_TABLE_START);
	const end = document.indexOf(COMPAT_TABLE_END);
	if (start < 0 || end < start) throw new Error("compat table markers not found");
	return `${document.slice(0, start + COMPAT_TABLE_START.length)}\n${compatTableMarkdown(manifest)}\n${document.slice(end)}`;
}
