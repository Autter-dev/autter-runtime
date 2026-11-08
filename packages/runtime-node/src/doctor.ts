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
import { diagnoseConnectivity, type ConnectivityReport } from "./connectivity.js";
import { refusalReason } from "./ingest-auth.js";

/**
 * `npx @autter/runtime-node doctor` — one-shot setup report: installed
 * Autter SDK versions against the ingester's (version skew), which features
 * are active, whether the ingester can store anything right now (`/healthz`),
 * and the ingest key ("not checked" when none is given). When the ingester
 * can't be reached it says where the path breaks (DNS, TCP, TLS, HTTP).
 * Exit codes: 0 everything checked is fine, 1 a mismatch, rejected key or
 * unready storage, 2 the ingester could not be reached or identified.
 * `verify` goes further: it sends a test event and reads it back.
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
	/** Always set: "not_checked" when no key was given. */
	key: "accepted" | "rejected" | "client_key" | "storage_unavailable" | "unverified" | "unknown" | "not_checked";
	/** The ingester's reason when it refused the key. */
	keyDetail?: string;
	/** `/healthz`: can the ingester store what it is sent right now? */
	storage: StorageReport | null;
	/** "ok" = active: the SDK sends it and the ingester stores it. */
	features: Array<{ id: string; title: string; status: "ok" | "incompatible" | "unknown" }>;
	/** Each SDK against the ingester: who is behind, and on what. */
	skew: SkewLine[];
	issues: CompatIssue[];
	/** Only when the ingester could not be reached. */
	connectivity?: ConnectivityReport;
	exitCode: 0 | 1 | 2;
}

export interface StorageReport {
	/** up | down | auth_failed | schema_missing | unconfigured | unknown */
	state: string;
	ok: boolean;
	/** False for ingesters before 1.12, whose /healthz only pinged ClickHouse. */
	writeChecked: boolean;
	detail: string;
}

export interface SkewLine {
	sdk: string;
	version: string;
	/** "in_sync", "ingester_behind" (features it can't store), "sdk_behind" (features it doesn't send yet). */
	status: "in_sync" | "ingester_behind" | "sdk_behind" | "unknown";
	detail: string;
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

export async function checkKey(
	endpoint: string,
	key: string,
	timeoutMs: number,
): Promise<{ key: Exclude<DoctorReport["key"], "not_checked">; detail?: string }> {
	// An empty OTLP batch: authenticates and stores nothing.
	const res = await compatRequest("POST", `${endpoint}/v1/traces`, {
		body: JSON.stringify({ resourceSpans: [] }),
		headers: { authorization: `Bearer ${key}` },
		unref: false,
		timeoutMs,
	});
	if (!res) return { key: "unknown" };
	const detail = refusalReason(res.body) || undefined;
	const withDetail = (key: Exclude<DoctorReport["key"], "not_checked">) => (detail ? { key, detail } : { key });
	if (res.status >= 200 && res.status < 300) return { key: "accepted" };
	if (res.status === 401) return withDetail("rejected");
	if (res.status === 403) return withDetail("client_key");
	// 503 with Retry-After (ingester 1.12.0+): it could not check the key right now.
	if (res.status === 503) return withDetail(res.headers["retry-after"] ? "unverified" : "storage_unavailable");
	return withDetail("unknown");
}

const STORAGE_TEXT: Record<string, string> = {
	up: "ready: ClickHouse accepts writes",
	down: "ClickHouse is unreachable or failing writes (retryable): ingest answers 503 and exporters retry",
	auth_failed: "ClickHouse refuses the ingester's credentials: fix CLICKHOUSE_USER/CLICKHOUSE_PASSWORD on the ingester",
	schema_missing: "ClickHouse tables are missing: check the ingester logs for the boot migrations, then restart it",
	unconfigured: "no ClickHouse configured (CLICKHOUSE_URL unset): every ingest request is refused with 503",
};

/** `GET /healthz` (public): 1.12+ reports whether a real write succeeds. */
export async function checkStorage(endpoint: string, timeoutMs: number): Promise<StorageReport | null> {
	const res = await compatRequest("GET", `${endpoint}/healthz`, { unref: false, timeoutMs });
	if (!res) return null;
	let body: { ok?: unknown; clickhouse?: unknown; status?: unknown } = {};
	try {
		body = JSON.parse(res.body) as typeof body;
	} catch {
		// not JSON: judged on the status alone
	}
	const reported = typeof body.clickhouse === "string" ? body.clickhouse : null;
	if (res.status === 404) {
		return { state: "unknown", ok: true, writeChecked: false, detail: "not checked: this ingester has no /healthz" };
	}
	if (!reported) {
		if (res.status >= 200 && res.status < 300) {
			return {
				state: "up",
				ok: true,
				writeChecked: false,
				detail: "reachable (this ingester predates 1.12 and does not check writes; `verify` does)",
			};
		}
		// A 503 is the ingester saying it is not ready; anything else (an
		// auth proxy in front of /healthz, say) tells nothing about storage.
		return res.status === 503
			? { state: "down", ok: false, writeChecked: false, detail: "/healthz answered 503: the ingester is not ready" }
			: { state: "unknown", ok: true, writeChecked: false, detail: `not checked: /healthz answered ${res.status}` };
	}
	const ok = res.status >= 200 && res.status < 300 && reported === "up";
	return { state: reported, ok, writeChecked: true, detail: STORAGE_TEXT[reported] ?? `ClickHouse ${reported}` };
}

/** Each installed SDK against the ingester's version. */
export function versionSkew(sdks: SdkIdentity[], info: IngesterCompatInfo | null): SkewLine[] {
	return sdks.map((sdk) => {
		const emitted = COMPAT_MANIFEST.features.filter((f) => {
			const min = f.sdks[sdk.name];
			return min !== undefined && versionAtLeast(sdk.version, min) === true;
		});
		const notYet = COMPAT_MANIFEST.features.filter((f) => {
			const min = f.sdks[sdk.name];
			return min !== undefined && versionAtLeast(sdk.version, min) === false;
		});
		if (!info?.version) {
			return { sdk: sdk.name, version: sdk.version, status: "unknown" as const, detail: "ingester version unknown" };
		}
		const unstored = emitted.filter((f) => versionAtLeast(info.version, f.ingester) === false);
		if (unstored.length) {
			const need = unstored.map((f) => f.ingester).sort((a, b) => (versionAtLeast(a, b) ? -1 : 1))[0]!;
			return {
				sdk: sdk.name,
				version: sdk.version,
				status: "ingester_behind" as const,
				detail: `ingester ${info.version} is behind: ${unstored.length} feature(s) this SDK sends need ingester >= ${need} (${unstored.map((f) => f.id).join(", ")})`,
			};
		}
		const available = notYet.filter((f) => versionAtLeast(info.version, f.ingester) === true);
		if (available.length) {
			const need = available.map((f) => f.sdks[sdk.name]!).sort((a, b) => (versionAtLeast(a, b) ? -1 : 1))[0]!;
			return {
				sdk: sdk.name,
				version: sdk.version,
				status: "sdk_behind" as const,
				detail: `the ingester stores ${available.length} feature(s) this SDK does not send yet; ${sdk.name} >= ${need} adds them (${available.map((f) => f.id).join(", ")})`,
			};
		}
		return { sdk: sdk.name, version: sdk.version, status: "in_sync" as const, detail: `in sync with ingester ${info.version}` };
	});
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

	const keyCheck = options.key ? await checkKey(endpoint, options.key, timeoutMs) : null;
	const key: DoctorReport["key"] = keyCheck?.key ?? "not_checked";
	const storage = info ? await checkStorage(endpoint, timeoutMs) : null;
	const connectivity = info ? undefined : await diagnoseConnectivity(endpoint, { timeoutMs });
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
		: issues.length ||
			  storage?.ok === false ||
			  key === "rejected" ||
			  key === "client_key" ||
			  key === "storage_unavailable" ||
			  key === "unverified"
			? 1
			: 0;
	return {
		endpoint,
		sdks,
		ingester: info,
		...(error && !info ? { ingesterError: error } : {}),
		key,
		...(keyCheck?.detail ? { keyDetail: keyCheck.detail } : {}),
		storage,
		features: featureRows,
		skew: versionSkew(sdks, info),
		issues,
		...(connectivity ? { connectivity } : {}),
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
	if (report.storage) lines.push(`  storage    ${report.storage.ok ? "" : "NOT READY: "}${report.storage.detail}`);
	{
		const reason = report.keyDetail ? ` (${report.keyDetail})` : "";
		const text = {
			accepted: "accepted",
			rejected: `REJECTED (401${reason}): check AUTTER_RUNTIME_KEY`,
			client_key: `refused (403${reason}): server SDKs need a server key (autter_rt_…)`,
			storage_unavailable: "accepted, but the ingester's ClickHouse is unavailable (503)",
			unverified: "could not be checked: the ingester's key validator is unavailable (503); exporters retry",
			unknown: `could not be verified${reason}`,
			not_checked: "not checked (pass --key or set AUTTER_RUNTIME_KEY)",
		}[report.key];
		lines.push(`  key        ${text}`);
	}
	if (report.connectivity) {
		lines.push("", "Connection");
		for (const step of report.connectivity.steps) {
			lines.push(`  ${step.ok ? "ok  " : "FAIL"} ${step.step.padEnd(5)} ${step.detail}${step.ms ? ` (${step.ms} ms)` : ""}`);
		}
		if (report.connectivity.failed) lines.push(`  -> ${report.connectivity.failed.hint}`);
	}
	if (report.skew.some((line) => line.status !== "unknown")) {
		lines.push("", "Versions");
		for (const line of report.skew) {
			const mark = line.status === "in_sync" ? "ok  " : line.status === "ingester_behind" ? "FAIL" : line.status === "sdk_behind" ? "note" : "??  ";
			lines.push(`  ${mark} ${line.sdk}@${line.version}: ${line.detail}`);
		}
	}
	if (report.features.length) {
		lines.push("", "Features");
		for (const feature of report.features) {
			const mark = feature.status === "ok" ? "on  " : feature.status === "incompatible" ? "FAIL" : "??  ";
			lines.push(`  ${mark} ${feature.title} (${feature.id})`);
		}
	}
	if (report.issues.length) {
		lines.push("", "Problems");
		for (const issue of report.issues) lines.push(`  - ${issue.message}`);
	}
	if (report.storage && !report.storage.ok) lines.push(`${report.issues.length ? "" : "\nProblems\n"}  - Storage: ${report.storage.detail}`);
	lines.push("", verdict(report));
	return lines.join("\n");
}

function verdict(report: DoctorReport): string {
	if (report.exitCode === 2) {
		return report.connectivity?.failed
			? `Could not reach the ingester: the ${report.connectivity.failed.step.toUpperCase()} step failed (see Connection above).`
			: "Could not check the ingester. Pass --endpoint <url> (or set AUTTER_ENDPOINT).";
	}
	if (report.exitCode === 1) {
		if (report.storage && !report.storage.ok) return "Not ready: the ingester cannot store data right now (see storage above).";
		if (report.key !== "accepted" && report.key !== "not_checked" && !report.issues.length) return "Not ready: the key was not accepted (see key above).";
		return "Incompatible: see the problems above.";
	}
	if (report.key === "not_checked") {
		return "Versions compatible and storage ready. Key not checked: pass --key, or run `npx @autter/runtime-node verify` to send a test event end to end.";
	}
	return "Ready: versions compatible, storage ready, key accepted. `npx @autter/runtime-node verify` sends a test event end to end.";
}

export const DOCTOR_USAGE = `Usage: npx @autter/runtime-node doctor [options]

Checks that your Autter SDKs and the ingester's version, ClickHouse schema
and storage match, which features are active, and the ingest key. For an
end-to-end check that sends a test event, use: npx @autter/runtime-node verify

Options:
  --endpoint <url>    Ingester base URL (default: $AUTTER_ENDPOINT, $OTEL_EXPORTER_OTLP_ENDPOINT, or ${DEFAULT_ENDPOINT})
  --key <key>         Also verify an ingest key (default: $AUTTER_RUNTIME_KEY)
  --features <a,b>    Only check these features (${COMPAT_MANIFEST.features.map((f) => f.id).join(", ")})
  --json              Machine-readable output
  --timeout <ms>      Per-request timeout (default 5000)

Exit codes: 0 ready, 1 mismatch, rejected key or storage not ready, 2 ingester unreachable.`;

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
