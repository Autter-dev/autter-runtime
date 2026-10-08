import { createRequire } from "node:module";
import type { IngestContext } from "./types.js";

/**
 * Which SDK (name + version) each service sends with, recorded cheaply so the
 * Autter dashboard and `/v1/compat` consumers can spot version mismatches.
 *
 * Sources, in priority order:
 * - OTLP resource `telemetry.distro.name` / `telemetry.distro.version` — set
 *   by `@autter/runtime-node` and `@autter/runtime-next` (OTel semconv for
 *   SDK distributions);
 * - otherwise `telemetry.sdk.language` / `telemetry.sdk.version` — any plain
 *   OpenTelemetry SDK (Python, Go, Java, …), recorded as
 *   `opentelemetry-<language>`;
 * - browser payloads: the `sdk` field sent by `@autter/runtime-browser`.
 *
 * Writes are deduplicated in memory: one row per (tenant, service,
 * environment, sdk, version) per `refreshMs`, bounded map, fire-and-forget —
 * a failed write is logged and never fails ingest.
 */

let cachedVersion: string | null = null;
/** This ingester's own version (package.json — present in the npm package
 * and the Docker image). */
export function ingesterVersion(): string {
	if (cachedVersion) return cachedVersion;
	try {
		const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
		cachedVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		cachedVersion = "0.0.0";
	}
	return cachedVersion;
}

export interface SdkSighting {
	service: string;
	environment: string;
	sdkName: string;
	sdkVersion: string;
	sdkLanguage: string;
}

interface KeyValue {
	key?: string;
	value?: { stringValue?: string };
}
interface ResourceHolder {
	resource?: { attributes?: KeyValue[] };
}
export interface OtlpResourceRequest {
	resourceSpans?: ResourceHolder[];
	resourceMetrics?: ResourceHolder[];
	resourceLogs?: ResourceHolder[];
}

const CLEAN = /^[\w.@/+:-]{1,100}$/;
function clean(value: string | undefined, max = 100): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim().slice(0, max);
	return CLEAN.test(trimmed) ? trimmed : "";
}

/** SDK identity per OTLP resource. Reads only a handful of resource keys. */
export function sdkSightingsFromOtlp(request: OtlpResourceRequest | null | undefined): SdkSighting[] {
	if (!request || typeof request !== "object") return [];
	const holders = [
		...(Array.isArray(request.resourceSpans) ? request.resourceSpans : []),
		...(Array.isArray(request.resourceMetrics) ? request.resourceMetrics : []),
		...(Array.isArray(request.resourceLogs) ? request.resourceLogs : []),
	].slice(0, 64);
	const out: SdkSighting[] = [];
	for (const holder of holders) {
		const attrs = holder?.resource?.attributes;
		if (!Array.isArray(attrs)) continue;
		const get: Record<string, string> = {};
		for (const attr of attrs.slice(0, 256)) {
			const key = attr?.key;
			const value = attr?.value?.stringValue;
			if (typeof key === "string" && typeof value === "string" && key.length < 64) get[key] = value;
		}
		const service = clean(get["service.name"], 200);
		if (!service) continue;
		const language = clean(get["telemetry.sdk.language"]);
		let sdkName = clean(get["telemetry.distro.name"]);
		let sdkVersion = clean(get["telemetry.distro.version"]);
		if (!sdkName || !sdkVersion) {
			sdkVersion = clean(get["telemetry.sdk.version"]);
			sdkName = sdkVersion ? `opentelemetry-${language || "unknown"}` : "";
		}
		if (!sdkName || !sdkVersion) continue;
		out.push({
			service,
			environment:
				clean(get["deployment.environment.name"]) ||
				clean(get["deployment.environment"]) ||
				"production",
			sdkName,
			sdkVersion,
			sdkLanguage: language,
		});
	}
	return out;
}

export const BROWSER_SDK_NAME = "@autter/runtime-browser";

export interface SdkVersionRow extends SdkSighting {
	ingesterVersion: string;
	seenAt: Date;
}

export interface SdkVersionTrackerOptions {
	/** Re-write an unchanged sighting at most this often. Default 1 h. */
	refreshMs?: number;
	/** Dedupe map bound; cleared (not grown) past this. Default 10 000. */
	maxKeys?: number;
	now?: () => number;
	onError?: (err: unknown) => void;
}

export class SdkVersionTracker {
	private readonly lastWritten = new Map<string, number>();
	private readonly refreshMs: number;
	private readonly maxKeys: number;
	private readonly now: () => number;
	private readonly onError: (err: unknown) => void;
	private lastErrorLog = 0;

	constructor(
		private readonly write: (ctx: IngestContext, rows: SdkVersionRow[]) => Promise<void>,
		options: SdkVersionTrackerOptions = {},
	) {
		this.refreshMs = options.refreshMs ?? 60 * 60 * 1000;
		this.maxKeys = options.maxKeys ?? 10_000;
		this.now = options.now ?? Date.now;
		this.onError =
			options.onError ??
			((err) => {
				// One line per minute at most: a missing table on a broken schema
				// must not flood the logs on every ingest request.
				if (this.now() - this.lastErrorLog < 60_000) return;
				this.lastErrorLog = this.now();
				console.warn("sdk version tracking write failed:", (err as Error)?.message ?? err);
			});
	}

	/** Fire-and-forget. Returns the write promise (resolved) for tests. */
	observe(ctx: IngestContext, sightings: SdkSighting[]): Promise<void> {
		if (!sightings.length) return Promise.resolve();
		const now = this.now();
		const rows: SdkVersionRow[] = [];
		const keys: string[] = [];
		for (const sighting of sightings) {
			const key = [
				ctx.orgId,
				ctx.repositoryId,
				sighting.service,
				sighting.environment,
				sighting.sdkName,
				sighting.sdkVersion,
			].join("\u0000");
			const last = this.lastWritten.get(key);
			if (last !== undefined && now - last < this.refreshMs) continue;
			if (keys.includes(key)) continue;
			keys.push(key);
			rows.push({ ...sighting, ingesterVersion: ingesterVersion(), seenAt: new Date(now) });
		}
		if (!rows.length) return Promise.resolve();
		if (this.lastWritten.size + keys.length > this.maxKeys) this.lastWritten.clear();
		for (const key of keys) this.lastWritten.set(key, now);
		return this.write(ctx, rows).catch((err) => {
			// Let the next request retry instead of waiting out refreshMs.
			for (const key of keys) this.lastWritten.delete(key);
			this.onError(err);
		});
	}
}

export function sdkVersionTableDDL(db: string, ttlDays = 90): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_sdk_versions (
		org_id String, repository_id String, service LowCardinality(String),
		environment LowCardinality(String), sdk_name LowCardinality(String),
		sdk_version String, sdk_language LowCardinality(String) DEFAULT '',
		ingester_version String DEFAULT '', last_seen DateTime('UTC')
	) ENGINE = ReplacingMergeTree(last_seen)
	ORDER BY (org_id, repository_id, service, environment, sdk_name, sdk_version)
	TTL last_seen + INTERVAL ${ttlDays} DAY`;
}

/** One row per ingester version (latest report wins); not tenant data. */
export function ingesterInfoTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_ingester_info (
		ingester_version String, schema_level String DEFAULT '',
		report String DEFAULT '{}' CODEC(ZSTD(1)), reported_at DateTime('UTC')
	) ENGINE = ReplacingMergeTree(reported_at)
	ORDER BY ingester_version
	TTL reported_at + INTERVAL 90 DAY`;
}
