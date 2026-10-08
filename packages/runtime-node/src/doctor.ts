import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	COMPAT_MANIFEST,
	compatRequest,
	evaluateCompat,
	fetchIngesterCompat,
	SDK_IDENTITY,
	type CompatIssue,
	type IngesterCompatInfo,
	type SdkIdentity,
} from "./compat.js";
import { versionAtLeast } from "../../otlp-ingester/src/compat.js";

/**
 * `npx @autter/runtime-node doctor` — one-shot version compatibility report:
 * installed Autter SDK versions, the ingester's version and ClickHouse schema
 * level, the ingest key (optional), and every feature the installed SDKs can
 * use that the ingester can't store. Exit codes: 0 compatible, 1 a mismatch
 * or rejected key, 2 the ingester could not be reached or identified.
 */

export interface DoctorOptions {
	endpoint?: string;
	key?: string;
	features?: string[];
	json?: boolean;
	cwd?: string;
	timeoutMs?: number;
}

export interface DoctorReport {
	endpoint: string;
	sdks: SdkIdentity[];
	ingester: IngesterCompatInfo | null;
	ingesterError?: string;
	key?: "accepted" | "rejected" | "client_key" | "storage_unavailable" | "unknown";
	features: Array<{ id: string; title: string; status: "ok" | "incompatible" | "unknown" }>;
	issues: CompatIssue[];
	exitCode: 0 | 1 | 2;
}

const SDK_PACKAGES = ["@autter/runtime-node", "@autter/runtime-next", "@autter/runtime-browser"];
const DEFAULT_ENDPOINT = "https://otlp.autter.dev";

export function resolveEndpoint(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
	return (
		flag ||
		env.AUTTER_ENDPOINT ||
		env.AUTTER_RUNTIME_ENDPOINT ||
		env.OTEL_EXPORTER_OTLP_ENDPOINT ||
		DEFAULT_ENDPOINT
	).replace(/\/$/, "");
}

/** Autter SDKs installed in the project at `cwd` (walking up node_modules). */
export function installedSdks(cwd: string): SdkIdentity[] {
	const found = new Map<string, string>();
	for (let dir = cwd; ; dir = dirname(dir)) {
		for (const name of SDK_PACKAGES) {
			if (found.has(name)) continue;
			const file = join(dir, "node_modules", ...name.split("/"), "package.json");
			if (!existsSync(file)) continue;
			try {
				const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
				if (typeof version === "string") found.set(name, version);
			} catch {
				// unreadable manifest: skip
			}
		}
		if (dirname(dir) === dir) break;
	}
	// The doctor itself is always an installed runtime-node.
	if (!found.has(SDK_IDENTITY.name)) found.set(SDK_IDENTITY.name, SDK_IDENTITY.version);
	return [...found].map(([name, version]) => ({ name, version }));
}

/** Features any installed SDK is new enough to emit. */
function featuresInUse(sdks: SdkIdentity[]): string[] {
	return COMPAT_MANIFEST.features
		.filter((feature) =>
			sdks.some((sdk) => {
				const min = feature.sdks[sdk.name];
				return min !== undefined && versionAtLeast(sdk.version, min) === true;
			}),
		)
		.map((feature) => feature.id);
}

async function checkKey(endpoint: string, key: string, timeoutMs: number): Promise<DoctorReport["key"]> {
	// An empty OTLP batch: authenticates and stores nothing.
	const res = await compatRequest("POST", `${endpoint}/v1/traces`, {
		body: JSON.stringify({ resourceSpans: [] }),
		headers: { authorization: `Bearer ${key}` },
		unref: false,
		timeoutMs,
	});
	if (!res) return "unknown";
	if (res.status >= 200 && res.status < 300) return "accepted";
	if (res.status === 401) return "rejected";
	if (res.status === 403) return "client_key";
	if (res.status === 503) return "storage_unavailable";
	return "unknown";
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
	const endpoint = resolveEndpoint(options.endpoint);
	const timeoutMs = options.timeoutMs ?? 5000;
	const sdks = installedSdks(options.cwd ?? process.cwd());
	const features = options.features?.length ? options.features : featuresInUse(sdks);
	const routes = [
		...new Set(
			features
				.map((id) => COMPAT_MANIFEST.features.find((f) => f.id === id)?.route)
				.filter((route): route is string => Boolean(route)),
		),
	];
	const { info, error } = await fetchIngesterCompat(endpoint, { probeRoutes: routes, unref: false, timeoutMs });

	const issues: CompatIssue[] = [];
	const seen = new Set<string>();
	const add = (issue: CompatIssue) => {
		const key = `${issue.feature}:${issue.kind}:${issue.component}`;
		if (!seen.has(key)) {
			seen.add(key);
			issues.push(issue);
		}
	};
	evaluateCompat({ features, ingester: info }).forEach(add);
	for (const sdk of sdks) {
		// SDK-side gaps only for features explicitly requested.
		if (options.features?.length) {
			evaluateCompat({ features: options.features, ingester: null, sdk }).forEach(add);
		}
	}

	const key = options.key ? await checkKey(endpoint, options.key, timeoutMs) : undefined;
	const featureRows = features.flatMap((id) => {
		const feature = COMPAT_MANIFEST.features.find((f) => f.id === id);
		if (!feature) return [];
		const bad = issues.some((issue) => issue.feature === id);
		const known =
			info?.version != null ||
			(feature.route !== undefined && info?.routes?.[feature.route] !== undefined);
		return [{ id, title: feature.title, status: bad ? "incompatible" as const : known ? "ok" as const : "unknown" as const }];
	});
	const exitCode: DoctorReport["exitCode"] = !info
		? 2
		: issues.length || key === "rejected" || key === "client_key" || key === "storage_unavailable"
			? 1
			: 0;
	return {
		endpoint,
		sdks,
		ingester: info,
		...(error && !info ? { ingesterError: error } : {}),
		...(key ? { key } : {}),
		features: featureRows,
		issues,
		exitCode,
	};
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = [];
	lines.push(`Autter Runtime doctor`);
	lines.push(`  endpoint   ${report.endpoint}`);
	for (const sdk of report.sdks) lines.push(`  sdk        ${sdk.name}@${sdk.version}`);
	if (!report.ingester) {
		lines.push(`  ingester   unreachable or unidentified (${report.ingesterError ?? "unknown error"})`);
	} else if (report.ingester.version) {
		lines.push(`  ingester   @autter/otlp-ingester@${report.ingester.version}`);
		const schema = report.ingester.schema;
		if (schema) {
			lines.push(
				`  schema     ${schema.status}${schema.applied.length ? ` (level ${schema.applied[schema.applied.length - 1]})` : ""}`,
			);
		}
	} else {
		lines.push(`  ingester   1.4.0 or older (no /v1/compat endpoint; upgrade for a full report)`);
	}
	if (report.key) {
		const text = {
			accepted: "accepted",
			rejected: "REJECTED (401): check AUTTER_RUNTIME_KEY",
			client_key: "is a client/browser key; server SDKs need a server key",
			storage_unavailable: "accepted, but the ingester's ClickHouse is unavailable (503)",
			unknown: "could not be verified",
		}[report.key];
		lines.push(`  key        ${text}`);
	}
	if (report.features.length) {
		lines.push("", "Features");
		for (const feature of report.features) {
			const mark = feature.status === "ok" ? "ok  " : feature.status === "incompatible" ? "FAIL" : "??  ";
			lines.push(`  ${mark} ${feature.title} (${feature.id})`);
		}
	}
	if (report.issues.length) {
		lines.push("", "Problems");
		for (const issue of report.issues) lines.push(`  - ${issue.message}`);
	}
	lines.push(
		"",
		report.exitCode === 0
			? "Compatible."
			: report.exitCode === 1
				? "Incompatible: see the problems above."
				: "Could not check the ingester. Pass --endpoint <url> (or set AUTTER_ENDPOINT).",
	);
	return lines.join("\n");
}

export const DOCTOR_USAGE = `Usage: npx @autter/runtime-node doctor [options]

Checks that your Autter SDKs, ingester and ClickHouse schema versions match.

Options:
  --endpoint <url>    Ingester base URL (default: $AUTTER_ENDPOINT, $OTEL_EXPORTER_OTLP_ENDPOINT, or ${DEFAULT_ENDPOINT})
  --key <key>         Also verify an ingest key (default: $AUTTER_RUNTIME_KEY)
  --features <a,b>    Only check these features (${COMPAT_MANIFEST.features.map((f) => f.id).join(", ")})
  --json              Machine-readable output
  --timeout <ms>      Per-request timeout (default 5000)

Exit codes: 0 compatible, 1 mismatch or rejected key, 2 ingester unreachable.`;

export function parseDoctorArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DoctorOptions | { help: true } | { error: string } {
	const options: DoctorOptions = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		const value = () => inline ?? argv[++i];
		switch (flag) {
			case "-h":
			case "--help":
				return { help: true };
			case "--endpoint":
				options.endpoint = value();
				break;
			case "--key":
				options.key = value();
				break;
			case "--features":
				options.features = (value() ?? "").split(",").map((f) => f.trim()).filter(Boolean);
				break;
			case "--json":
				options.json = true;
				break;
			case "--timeout": {
				const ms = Number(value());
				if (!Number.isFinite(ms) || ms <= 0) return { error: "--timeout needs a positive number of ms" };
				options.timeoutMs = ms;
				break;
			}
			default:
				return { error: `unknown option ${arg}` };
		}
	}
	if (!options.key && env.AUTTER_RUNTIME_KEY) options.key = env.AUTTER_RUNTIME_KEY;
	return options;
}
