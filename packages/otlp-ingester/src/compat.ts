/**
 * Version compatibility between Autter Runtime SDKs, this ingester and its
 * ClickHouse schema — the single source of truth.
 *
 * `compat-manifest.json` lists every feature that needs a minimum ingester
 * version, a ClickHouse migration, a dedicated ingest route, or a minimum SDK
 * version. Everything else derives from it:
 *
 * - the ingester serves it (evaluated against its own version and applied
 *   migrations) at `GET /v1/compat`;
 * - `@autter/runtime-node` / `@autter/runtime-next` bundle this file at build
 *   time to warn once when an enabled feature needs a newer ingester, and to
 *   power `npx @autter/runtime-node doctor`;
 * - the Python adapter (`adapters/python/compat.py`) embeds a copy that a
 *   parity test keeps identical.
 *
 * This module is dependency-free and side-effect-free on purpose: it is
 * bundled into the Node SDK. Keep it that way.
 *
 * Adding a feature: append an entry to compat-manifest.json with the first
 * ingester release that handles it, the migrations it writes to, its route
 * (if it has its own), and the first SDK release that emits it. The
 * consistency test in compat.test.ts checks ids, migrations and routes.
 */

import manifestJson from "./compat-manifest.json" with { type: "json" };

export interface CompatFeature {
	id: string;
	title: string;
	/** First ingester release that stores this feature correctly. */
	ingester: string;
	/** ClickHouse migrations (migrations.ts ids) the feature writes to. */
	migrations: string[];
	/** Dedicated ingest route, when the feature has one. */
	route?: string;
	/** First release of each SDK package that emits the feature. */
	sdks: Record<string, string>;
	/** Browser payload event types that belong to this feature. */
	browserEvents?: string[];
}

export interface CompatManifest {
	manifestVersion: number;
	docs: string;
	upgrade: { ingester: string; sdk: string };
	features: CompatFeature[];
}

export const COMPAT_MANIFEST: CompatManifest = manifestJson as CompatManifest;

export const INGESTER_PACKAGE = "@autter/otlp-ingester";
/** Response header carrying the ingester version on every ingest response. */
export const INGESTER_VERSION_HEADER = "x-autter-ingester-version";

// ── versions ────────────────────────────────────────────────────────────

/** [major, minor, patch, isPrerelease] or null when unparsable. */
function parseVersion(
	version: string | null | undefined,
): [number, number, number, number] | null {
	if (typeof version !== "string") return null;
	const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]+)?/.exec(
		version.trim(),
	);
	if (!match) return null;
	return [
		Number(match[1]),
		Number(match[2]),
		Number(match[3]),
		// A prerelease sorts before its release: 1.4.0-rc.1 < 1.4.0.
		match[4] ? 0 : 1,
	];
}

/** Semver-ish comparison; null when either side is unparsable. */
export function compareVersions(a: string, b: string): number | null {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return null;
	for (let i = 0; i < 4; i++) {
		if (left[i]! !== right[i]!) return left[i]! < right[i]! ? -1 : 1;
	}
	return 0;
}

/** True/false when comparable, null when the version is unknown/unparsable. */
export function versionAtLeast(
	version: string | null | undefined,
	minimum: string,
): boolean | null {
	if (!version) return null;
	const result = compareVersions(version, minimum);
	return result === null ? null : result >= 0;
}

// ── evaluation ──────────────────────────────────────────────────────────

export type SchemaStatus = "ready" | "pending" | "failed" | "unconfigured";

/** What is known about the ingester an SDK talks to. */
export interface IngesterCompatInfo {
	/** Exact version, or null when the ingester predates /v1/compat. */
	version: string | null;
	/** True when /v1/compat returned 404 (ingester 1.4.0 or older). */
	legacy?: boolean;
	schema?: { status: SchemaStatus; applied: string[] };
	/** Legacy ingesters: route → exists, learned by probing. */
	routes?: Record<string, boolean>;
}

export type CompatIssueKind =
	| "ingester_too_old"
	| "schema_not_applied"
	| "sdk_too_old";

export interface CompatIssue {
	feature: string;
	title: string;
	kind: CompatIssueKind;
	/** Package that must change: the ingester or an SDK package name. */
	component: string;
	required: string;
	/** What was found ("1.3.4", "1.4.0 or older", …). */
	actual: string;
	/** One line: what is wrong, versions, and the fix. */
	message: string;
	fix: string;
}

export interface SdkIdentity {
	name: string;
	version: string;
}

export function featureById(
	id: string,
	manifest: CompatManifest = COMPAT_MANIFEST,
): CompatFeature | undefined {
	return manifest.features.find((feature) => feature.id === id);
}

/** Features the given browser payload event types belong to. */
export function featuresForBrowserEvents(
	types: Iterable<string>,
	manifest: CompatManifest = COMPAT_MANIFEST,
): string[] {
	const wanted = new Set(types);
	return manifest.features
		.filter((feature) => feature.browserEvents?.some((type) => wanted.has(type)))
		.map((feature) => feature.id);
}

export function ingesterUpgradeHint(manifest: CompatManifest = COMPAT_MANIFEST): string {
	return `Upgrade the ingester: ${manifest.upgrade.ingester}. See ${manifest.docs}`;
}

function sdkUpgradeHint(pkg: string, manifest: CompatManifest): string {
	return `Upgrade the SDK: ${manifest.upgrade.sdk.replace("{package}", pkg)}. See ${manifest.docs}`;
}

/**
 * Every incompatibility for the features in use. Unknown is never an issue:
 * when the ingester version can't be determined (and a legacy route probe
 * didn't prove a route missing) nothing is reported, so the check has no
 * false positives.
 */
export function evaluateCompat(input: {
	features: Iterable<string>;
	ingester: IngesterCompatInfo | null;
	sdk?: SdkIdentity | null;
	manifest?: CompatManifest;
}): CompatIssue[] {
	const manifest = input.manifest ?? COMPAT_MANIFEST;
	const issues: CompatIssue[] = [];
	const seen = new Set<string>();
	for (const id of input.features) {
		if (seen.has(id)) continue;
		seen.add(id);
		const feature = featureById(id, manifest);
		if (!feature) continue;

		const sdkMin = input.sdk ? feature.sdks[input.sdk.name] : undefined;
		if (input.sdk && sdkMin && versionAtLeast(input.sdk.version, sdkMin) === false) {
			const fix = sdkUpgradeHint(input.sdk.name, manifest);
			issues.push({
				feature: id,
				title: feature.title,
				kind: "sdk_too_old",
				component: input.sdk.name,
				required: sdkMin,
				actual: input.sdk.version,
				message: `${feature.title} needs ${input.sdk.name} >= ${sdkMin}; yours is ${input.sdk.version}. ${fix}`,
				fix,
			});
		}

		const ingester = input.ingester;
		if (!ingester) continue;
		const fix = ingesterUpgradeHint(manifest);
		const atLeast = versionAtLeast(ingester.version, feature.ingester);
		if (atLeast === false) {
			issues.push({
				feature: id,
				title: feature.title,
				kind: "ingester_too_old",
				component: INGESTER_PACKAGE,
				required: feature.ingester,
				actual: ingester.version!,
				message: `${feature.title} needs ingester >= ${feature.ingester}; yours is ${ingester.version}. ${fix}`,
				fix,
			});
			continue;
		}
		if (
			ingester.version === null &&
			feature.route &&
			ingester.routes?.[feature.route] === false
		) {
			const actual = "1.4.0 or older (no /v1/compat)";
			issues.push({
				feature: id,
				title: feature.title,
				kind: "ingester_too_old",
				component: INGESTER_PACKAGE,
				required: feature.ingester,
				actual,
				message: `${feature.title} needs ingester >= ${feature.ingester}; yours is ${actual} and has no ${feature.route} route, so this data is dropped. ${fix}`,
				fix,
			});
			continue;
		}
		const schema = ingester.schema;
		if (atLeast && schema && feature.migrations.length) {
			const applied = new Set(schema.applied);
			const missing = feature.migrations.filter((m) => !applied.has(m));
			if (schema.status === "failed" || (schema.status === "ready" && missing.length)) {
				const schemaFix =
					"Check the ingester's CLICKHOUSE_URL/credentials and its logs, then restart it so the boot migrations run. " +
					`See ${manifest.docs}`;
				const what = missing.length ? missing.join(", ") : feature.migrations.join(", ");
				issues.push({
					feature: id,
					title: feature.title,
					kind: "schema_not_applied",
					component: INGESTER_PACKAGE,
					required: feature.migrations.join(", "),
					actual: schema.status === "failed" ? "migrations failed" : `missing ${what}`,
					message: `${feature.title} needs ClickHouse migration ${what}, which ingester ${ingester.version} has not applied (schema ${schema.status}). ${schemaFix}`,
					fix: schemaFix,
				});
			}
		}
	}
	return issues;
}

// ── the /v1/compat document ─────────────────────────────────────────────

export interface CompatFeatureStatus {
	id: string;
	title: string;
	ingester: string;
	migrations: string[];
	route?: string;
	sdks: Record<string, string>;
	browserEvents?: string[];
	/** This ingester's version is new enough. */
	ingesterSupported: boolean;
	/** Migrations the feature needs that are not applied yet. */
	missingMigrations: string[];
	/** Ingester new enough AND schema ready with every migration applied. */
	available: boolean;
}

export interface CompatReport {
	ingester: { name: string; version: string };
	schema: {
		status: SchemaStatus;
		/** Highest applied migration id ("" when none known). */
		level: string;
		/** Highest migration this ingester ships. */
		latest: string;
		applied: string[];
	};
	features: CompatFeatureStatus[];
	manifestVersion: number;
	docs: string;
	upgrade: CompatManifest["upgrade"];
	/** Present when the request named features (and optionally an SDK). */
	issues?: CompatIssue[];
}

export function buildCompatReport(input: {
	version: string;
	schemaStatus: SchemaStatus;
	applied: string[];
	allMigrations: string[];
	manifest?: CompatManifest;
}): CompatReport {
	const manifest = input.manifest ?? COMPAT_MANIFEST;
	const applied = new Set(input.applied);
	const appliedOrdered = input.allMigrations.filter((id) => applied.has(id));
	return {
		ingester: { name: INGESTER_PACKAGE, version: input.version },
		schema: {
			status: input.schemaStatus,
			level: appliedOrdered[appliedOrdered.length - 1] ?? "",
			latest: input.allMigrations[input.allMigrations.length - 1] ?? "",
			applied: appliedOrdered,
		},
		features: manifest.features.map((feature) => {
			const ingesterSupported = versionAtLeast(input.version, feature.ingester) !== false;
			const missingMigrations = feature.migrations.filter((m) => !applied.has(m));
			return {
				...feature,
				ingesterSupported,
				missingMigrations,
				available:
					ingesterSupported &&
					(feature.migrations.length === 0 ||
						(input.schemaStatus === "ready" && missingMigrations.length === 0)),
			};
		}),
		manifestVersion: manifest.manifestVersion,
		docs: manifest.docs,
		upgrade: manifest.upgrade,
	};
}

/** IngesterCompatInfo from a /v1/compat response body (defensive: it's network input). */
export function ingesterInfoFromReport(body: unknown): IngesterCompatInfo | null {
	if (!body || typeof body !== "object") return null;
	const report = body as Partial<CompatReport>;
	const version = report.ingester?.version;
	if (typeof version !== "string" || !parseVersion(version)) return null;
	const schema = report.schema;
	const statuses: SchemaStatus[] = ["ready", "pending", "failed", "unconfigured"];
	return {
		version,
		...(schema && statuses.includes(schema.status) && Array.isArray(schema.applied)
			? {
					schema: {
						status: schema.status,
						applied: schema.applied.filter((id): id is string => typeof id === "string"),
					},
				}
			: {}),
	};
}
