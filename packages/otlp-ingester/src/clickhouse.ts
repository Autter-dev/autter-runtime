import {
	createClient,
	type ClickHouseClient,
	type ClickHouseSettings,
} from "@clickhouse/client";
import type { IngesterConfig } from "./config.js";
import {
	latencyTableDDL,
	routeLatencyInputDDL,
	routeLatencyTableDDL,
	routeLatencyViewDDL,
	type LatencyHistogram,
} from "./latency.js";
import { profileTableDDL, type ProfileSample } from "./profiles.js";
import { memoryTableDDL, platformEventTableDDL, type MemorySample, type PlatformEvent } from "./memory.js";
import { sourceMapTableDDL, type SourceMapCheck, type ValidSourceMap } from "./source-maps.js";
import { attributesWithBreadcrumbs } from "./breadcrumbs.js";
import { lookupSourceMap, presentSourceMaps, type SourceMapKey } from "./source-maps-lookup.js";
import {
	logTableDDL,
	requestRollupTableDDL,
	type RuntimeLogRecord,
} from "./logs.js";
import {
	ingesterInfoTableDDL,
	sdkVersionTableDDL,
	type SdkVersionRow,
} from "./sdk-versions.js";
import { ingestDropsTableDDL, type IngestDropRow } from "./ingest-drops.js";
import {
	heartbeatTableDDL,
	stateFor,
	storageErrorCategory,
	WriteHealth,
	type ProbeResult,
} from "./health.js";
import { sinkDeadLettersTableDDL, type SinkDeadLetterRow } from "./sink-dead-letters.js";
import { inAppFrameResolution } from "./symbolicate.js";
import type { SchemaStatus } from "./compat.js";
import {
	MIGRATIONS,
	OCCURRENCE_CODE_COLUMNS,
	OCCURRENCE_COLLAPSE_COLUMNS,
	OCCURRENCE_FRAME_RESOLUTION_COLUMNS,
	OCCURRENCE_GROUPING_COLUMNS,
	OCCURRENCE_REQUEST_ID_INDEX,
	migrationsTableDDL,
	type Migration,
} from "./migrations.js";
import type {
	IngestContext,
	RuntimeLlmCall,
	RuntimeMetricPoint,
	RuntimeOccurrence,
	RuntimeSpanRow,
} from "./types.js";

/**
 * ClickHouse persistence. The schema is idempotent and applied lazily once
 * per process. Every row is keyed by (org_id, repository_id) — tenant
 * isolation is enforced by always writing the authenticated context, never
 * anything from the payload.
 */

const INSERT_SETTINGS: ClickHouseSettings = {
	date_time_input_format: "best_effort",
	async_insert: 1,
	wait_for_async_insert: 1,
};

/** Tables whose fan-out inserts carry a dedup token (insert_deduplication_token):
 * a request retried after a partial failure must not add its rows twice.
 * A plain (non-replicated) MergeTree only keeps the hashes it dedupes
 * against when non_replicated_deduplication_window > 0, set at boot by
 * applyDedupWindow; Replicated and Shared engines keep them by default. */
export const DEDUP_TABLES = [
	"runtime_error_occurrences",
	"runtime_spans",
	"runtime_metrics_1m",
	"runtime_llm_calls",
	"runtime_logs",
	"runtime_latency_histograms",
	"runtime_memory_samples",
] as const;

/** Inserted blocks remembered per table for dedupe. Exporters retry within
 * minutes; this covers far more inserts than a retry window holds. */
export const DEDUP_WINDOW = 10_000;

/** Errors a server can answer for dedupe settings it does not support
 * (UNKNOWN_SETTING, BAD_ARGUMENTS, NOT_IMPLEMENTED, UNSUPPORTED_METHOD,
 * SUPPORT_IS_DISABLED). Ingest then goes on without them: dedupe is a
 * guard, never a reason to refuse telemetry. */
const DEDUP_SETTING_REFUSED = new Set(["115", "36", "48", "1", "344"]);

/** Source maps above this go in with a plain insert (below ClickHouse's
 * default async_insert_max_data_size of 10 MiB). */
const ASYNC_INSERT_MAX_MAP_CHARS = 8 * 1024 * 1024;

/**
 * Migration 0020 columns: browser occurrences only. Server frames are
 * symbolicated too since RF-05, but an unresolved server `.js` frame is
 * usually readable code (an unbundled Node app), so it would make the EI-14
 * "needs source maps" ratio cry wolf.
 */
function occurrenceFrameResolution(o: RuntimeOccurrence): { in_app_frames_resolved: number; in_app_frames_unresolved: number } {
	const counts = o.source === "browser" ? inAppFrameResolution(o.frames) : { resolved: 0, unresolved: 0 };
	return {
		in_app_frames_resolved: Math.min(65_535, counts.resolved),
		in_app_frames_unresolved: Math.min(65_535, counts.unresolved),
	};
}

/** "YYYY-MM-DD hh:mm:ss.sss" (UTC) — the DateTime64 query-parameter form. */
function chDateTime(date: Date): string {
	return date.toISOString().replace("T", " ").replace("Z", "");
}

export class ClickHouseStore {
	private client: ClickHouseClient | null = null;
	private ensurePromise: Promise<void> | null = null;
	private schemaState: Exclude<SchemaStatus, "unconfigured"> = "pending";
	private appliedIds: string[] = [];
	/** Outcome of real ingest writes, for readiness (health.ts). */
	readonly writes = new WriteHealth();
	/** False once the server refused async_insert_deduplicate. */
	private asyncDedupSetting = true;
	/** False once the server refused insert_deduplication_token. */
	private dedupTokens = true;
	/** ClickHouse server version, read by the first successful probe. */
	serverVersion: string | null = null;
	/** Called when a write fails or succeeds after failing — lets the
	 * readiness probe drop a stale cached answer. */
	onWriteStateChange: (() => void) | null = null;

	constructor(private readonly config: IngesterConfig) {}

	get configured(): boolean {
		return Boolean(this.config.clickhouseUrl);
	}

	private getClient(): ClickHouseClient {
		if (!this.config.clickhouseUrl) {
			throw new Error("CLICKHOUSE_URL is not configured");
		}
		if (!this.client) {
			this.client = createClient({
				url: this.config.clickhouseUrl,
				username: this.config.clickhouseUser,
				password: this.config.clickhousePassword,
				application: "autter-otlp-ingester",
				clickhouse_settings: { date_time_input_format: "best_effort" },
			});
		}
		return this.client;
	}

	private table(name: string): string {
		return `${this.config.clickhouseDatabase}.${name}`;
	}

	private schemaStatements(): string[] {
		const db = this.config.clickhouseDatabase;
		const { occurrenceTtlDays, spanTtlDays, metricsTtlDays, llmCallTtlDays } =
			this.config;
		const logTtlDays = this.config.logTtlDays ?? 14;
		return [
			`CREATE DATABASE IF NOT EXISTS ${db}`,
			latencyTableDDL(db, metricsTtlDays),
			// Per-route p50/p95/p99 (IP-02): input, rollup, then its view.
			routeLatencyInputDDL(db),
			routeLatencyTableDDL(db, metricsTtlDays),
			routeLatencyViewDDL(db),
			profileTableDDL(db),
			memoryTableDDL(db),
			platformEventTableDDL(db),
			sourceMapTableDDL(db),
			logTableDDL(db, logTtlDays),
			// The table only: its materialized view reads 0012 columns that an
			// existing runtime_logs lacks until migrations run, so the view is
			// created by migration 0014 alone (migrations also run on fresh DBs).
			requestRollupTableDDL(db),
			sdkVersionTableDDL(db, metricsTtlDays),
			ingesterInfoTableDDL(db),
			ingestDropsTableDDL(db),
			heartbeatTableDDL(db),
			sinkDeadLettersTableDDL(db),
			`CREATE TABLE IF NOT EXISTS ${db}.runtime_error_occurrences (
				org_id             String,
				repository_id      String,
				occurrence_id      String,
				fingerprint        String,
				source             LowCardinality(String),
				severity           LowCardinality(String) DEFAULT 'error',
				service            LowCardinality(String),
				environment        LowCardinality(String),
				release            String DEFAULT '',
				error_type         String,
				message            String CODEC(ZSTD(1)),
				message_normalized String DEFAULT '',
				stack              String DEFAULT '' CODEC(ZSTD(3)),
				top_frames         Array(String) DEFAULT [],
				first_frame        String DEFAULT '',
				route              String DEFAULT '',
				route_normalized   String DEFAULT '',
				method             LowCardinality(String) DEFAULT '',
				status_code        UInt16 DEFAULT 0,
				trace_id           String DEFAULT '',
				session_id         String DEFAULT '',
				attributes         String DEFAULT '{}' CODEC(ZSTD(1)),
				occurred_at        DateTime64(3, 'UTC'),
				ingested_at        DateTime64(3, 'UTC') DEFAULT now64(3),
				${OCCURRENCE_CODE_COLUMNS.join(",\n\t\t\t\t")},
				${OCCURRENCE_GROUPING_COLUMNS.join(",\n\t\t\t\t")},
				${OCCURRENCE_FRAME_RESOLUTION_COLUMNS.join(",\n\t\t\t\t")},
				${OCCURRENCE_COLLAPSE_COLUMNS.join(",\n\t\t\t\t")},
				${OCCURRENCE_REQUEST_ID_INDEX}
			)
			ENGINE = MergeTree
			PARTITION BY toDate(occurred_at)
			ORDER BY (org_id, repository_id, fingerprint, occurred_at)
			TTL toDateTime(occurred_at) + INTERVAL ${occurrenceTtlDays} DAY`,
			`CREATE TABLE IF NOT EXISTS ${db}.runtime_spans (
				org_id           String,
				repository_id    String,
				service          LowCardinality(String),
				environment      LowCardinality(String),
				release          String DEFAULT '',
				trace_id         String,
				span_id          String,
				parent_span_id   String DEFAULT '',
				name             String,
				kind             LowCardinality(String) DEFAULT 'internal',
				status           LowCardinality(String) DEFAULT 'ok',
				route            String DEFAULT '',
				status_code      UInt16 DEFAULT 0,
				duration_ms      Float64,
				attributes       String DEFAULT '{}' CODEC(ZSTD(1)),
				started_at       DateTime64(3, 'UTC')
			)
			ENGINE = MergeTree
			PARTITION BY toDate(started_at)
			ORDER BY (org_id, repository_id, trace_id, started_at)
			TTL toDateTime(started_at) + INTERVAL ${spanTtlDays} DAY`,
			`CREATE TABLE IF NOT EXISTS ${db}.runtime_metrics_1m (
				org_id           String,
				repository_id    String,
				service          LowCardinality(String),
				environment      LowCardinality(String),
				release          String DEFAULT '',
				route            String DEFAULT '',
				bucket_at        DateTime('UTC'),
				request_count    UInt64,
				error_count      UInt64,
				duration_sum_ms  Float64,
				session_count    UInt64 DEFAULT 0
			)
			ENGINE = SummingMergeTree((request_count, error_count, duration_sum_ms, session_count))
			PARTITION BY toYYYYMM(bucket_at)
			ORDER BY (org_id, repository_id, service, environment, release, route, bucket_at)
			TTL bucket_at + INTERVAL ${metricsTtlDays} DAY`,
			`CREATE TABLE IF NOT EXISTS ${db}.runtime_llm_calls (
				org_id          String,
				repository_id   String,
				service         LowCardinality(String),
				environment     LowCardinality(String),
				release         String DEFAULT '',
				trace_id        String DEFAULT '',
				span_id         String DEFAULT '',
				provider        LowCardinality(String) DEFAULT '',
				model           LowCardinality(String) DEFAULT '',
				operation       LowCardinality(String) DEFAULT '',
				input_tokens    UInt64 DEFAULT 0,
				output_tokens   UInt64 DEFAULT 0,
				cost_usd        Float64 DEFAULT 0,
				cost_source     LowCardinality(String) DEFAULT 'none',
				duration_ms     Float64 DEFAULT 0,
				status          LowCardinality(String) DEFAULT 'ok',
				error_type      String DEFAULT '',
				user_id         String DEFAULT '',
				session_id      String DEFAULT '',
				attributes      String DEFAULT '{}' CODEC(ZSTD(1)),
				started_at      DateTime64(3, 'UTC'),
				ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3)
			)
			ENGINE = MergeTree
			PARTITION BY toDate(started_at)
			ORDER BY (org_id, repository_id, started_at)
			TTL toDateTime(started_at) + INTERVAL ${llmCallTtlDays} DAY`,
		];
	}

	/**
	 * Baseline `CREATE ... IF NOT EXISTS` for fresh databases, then the
	 * versioned migrations from migrations.ts for existing ones — the
	 * CREATEs no-op on tables that already exist, so schema changes only
	 * reach deployed databases through migrations. Runs once per process
	 * (boot + lazily before first ingest); a failure clears the memo so the
	 * next request retries.
	 */
	ensureSchema(migrations: Migration[] = MIGRATIONS): Promise<void> {
		if (this.ensurePromise) return this.ensurePromise;
		this.ensurePromise = (async () => {
			const client = this.getClient();
			const db = this.config.clickhouseDatabase;
			for (const statement of this.schemaStatements()) {
				await client.command({ query: statement });
			}
			await client.command({ query: migrationsTableDDL(db) });

			const rows = await client.query({
				query: `SELECT DISTINCT id FROM ${db}.schema_migrations`,
				format: "JSONEachRow",
			});
			const applied = new Set(
				(await rows.json<{ id: string }>()).map((row) => row.id),
			);

			for (const migration of migrations) {
				if (applied.has(migration.id)) continue;
				for (const statement of migration.statements) {
					await client.command({
						query: statement.replaceAll("{db}", db),
					});
				}
				await client.insert({
					table: `${db}.schema_migrations`,
					format: "JSONEachRow",
					values: [{ id: migration.id }],
				});
				console.log(`clickhouse migration applied: ${migration.id}`);
			}
			await this.applyLogTtl();
			await this.applyDedupWindow();
			this.appliedIds = migrations.map((migration) => migration.id);
			this.schemaState = "ready";
			// Every table exists again: a "table missing" failure is resolved.
			if (this.writes.clearCategory("schema")) this.onWriteStateChange?.();
		})().catch((err) => {
			this.ensurePromise = null;
			this.schemaState = "failed";
			throw err;
		});
		return this.ensurePromise;
	}

	/**
	 * Bring runtime_logs' TTL in line with LOG_TTL_DAYS. Idempotent: reads the
	 * current TTL from system.tables and only issues `MODIFY TTL` when it
	 * differs (MODIFY TTL rewrites TTL info for existing parts, so it must not
	 * run on every boot). Best-effort — a failure is logged and never blocks
	 * ingest; the next boot retries.
	 */
	async applyLogTtl(): Promise<void> {
		const days = this.config.logTtlDays ?? 14;
		const db = this.config.clickhouseDatabase;
		try {
			const client = this.getClient();
			const rows = await client.query({
				query: `SELECT engine_full FROM system.tables WHERE database = {db:String} AND name = 'runtime_logs'`,
				query_params: { db },
				format: "JSONEachRow",
			});
			const [table] = await rows.json<{ engine_full: string }>();
			if (!table) return;
			const current = /\bTTL\b[^]*?toIntervalDay\((\d+)\)/.exec(table.engine_full);
			if (!current) {
				console.warn(
					"runtime_logs TTL not recognised — LOG_TTL_DAYS not applied",
				);
				return;
			}
			if (Number(current[1]) === days) return;
			await client.command({
				query: `ALTER TABLE ${db}.runtime_logs MODIFY TTL toDateTime(occurred_at) + INTERVAL ${days} DAY`,
			});
			console.log(
				`runtime_logs TTL changed from ${current[1]} to ${days} days (LOG_TTL_DAYS)`,
			);
		} catch (err) {
			console.warn(
				"applying LOG_TTL_DAYS to runtime_logs failed (will retry next boot):",
				err instanceof Error ? err.message : err,
			);
		}
	}

	/**
	 * Turn on insert dedupe for the fan-out tables (DEDUP_TABLES) where the
	 * engine needs it: a non-replicated MergeTree remembers no inserted
	 * blocks unless non_replicated_deduplication_window > 0. Replicated and
	 * Shared engines (ClickHouse Cloud) already do and are left alone.
	 * Idempotent and best-effort like applyLogTtl: a failure is logged and
	 * never blocks ingest (the in-process receipts in server.ts still cover
	 * retries that reach this replica).
	 */
	async applyDedupWindow(): Promise<void> {
		const db = this.config.clickhouseDatabase;
		try {
			const client = this.getClient();
			const rows = await client.query({
				query: `SELECT name, engine, engine_full FROM system.tables WHERE database = {db:String} AND has({names:Array(String)}, name)`,
				query_params: { db, names: [...DEDUP_TABLES] },
				format: "JSONEachRow",
			});
			const tables = await rows.json<{ name: string; engine: string; engine_full: string }>();
			for (const table of tables) {
				if (!/^(Summing|Replacing|Aggregating)?MergeTree$/.test(table.engine)) continue;
				const current = /non_replicated_deduplication_window\s*=\s*(\d+)/.exec(table.engine_full);
				if (current && Number(current[1]) >= DEDUP_WINDOW) continue;
				await client.command({
					query: `ALTER TABLE ${db}.${table.name} MODIFY SETTING non_replicated_deduplication_window = ${DEDUP_WINDOW}`,
				});
				console.log(`clickhouse: insert dedupe window on ${table.name} set to ${DEDUP_WINDOW}`);
			}
		} catch (err) {
			console.warn(
				"turning on insert dedupe failed (will retry next boot):",
				err instanceof Error ? err.message : err,
			);
		}
	}

	/**
	 * One insert, through the schema check, with its outcome recorded for
	 * readiness. `dedupToken` (fan-out tables) makes a retried insert of the
	 * same request a no-op in ClickHouse. A missing table or database
	 * clears the schema memo, so the next request recreates it instead of
	 * answering 503 until the process restarts.
	 */
	private async insertTracked(
		params: { table: string; format: "JSONEachRow"; clickhouse_settings?: ClickHouseSettings; values: unknown[] },
		dedupToken?: string,
		/** Count the outcome toward readiness: ingest writes do; background
		 * bookkeeping (SDK versions, drop counts, ingester info, dead
		 * letters) is best-effort and does not. */
		track = true,
	): Promise<void> {
		const wasFailing = this.writes.stats().consecutiveFailures > 0;
		try {
			await this.ensureSchema();
			const settings: ClickHouseSettings = { ...(params.clickhouse_settings ?? INSERT_SETTINGS) };
			if (dedupToken && this.dedupTokens) {
				settings.insert_deduplication_token = `${dedupToken}:${params.table}`;
				if (this.asyncDedupSetting && settings.async_insert === 1) settings.async_insert_deduplicate = 1;
			}
			// A refused dedupe setting: drop async_insert_deduplicate first,
			// then the token, each for the rest of the process, and insert.
			for (;;) {
				try {
					await this.getClient().insert({ ...params, clickhouse_settings: settings });
					break;
				} catch (err) {
					const code = String((err as { code?: unknown })?.code ?? "");
					if (!DEDUP_SETTING_REFUSED.has(code)) throw err;
					if (settings.async_insert_deduplicate) {
						this.asyncDedupSetting = false;
						delete settings.async_insert_deduplicate;
						console.warn(`clickhouse refused async_insert_deduplicate (code ${code}); inserting without it`);
					} else if (settings.insert_deduplication_token) {
						this.dedupTokens = false;
						delete settings.insert_deduplication_token;
						console.warn(`clickhouse refused insert_deduplication_token (code ${code}); inserting without insert dedupe tokens`);
					} else {
						throw err;
					}
				}
			}
			if (track) this.writes.recordOk(params.table);
			if (track && wasFailing) this.onWriteStateChange?.();
		} catch (err) {
			const category = storageErrorCategory(err);
			if (track) this.writes.recordFailure(category, params.table);
			if (category === "schema") this.resetSchema();
			if (track) this.onWriteStateChange?.();
			throw err;
		}
	}

	/** Forget that the schema is in place (a table or database vanished). */
	private resetSchema(): void {
		this.ensurePromise = null;
		this.schemaState = "pending";
	}

	/**
	 * Readiness probe: the schema check ingest runs, then a one-row insert
	 * with the configured credentials (runtime_ingester_heartbeat). It
	 * exercises the same path as ingest — authentication, grants, the
	 * database and its tables — which ClickHouse's /ping does not.
	 */
	async probe(instanceId: string, version: string, timeoutMs = 3_000): Promise<ProbeResult> {
		const started = Date.now();
		const checkedAt = () => new Date().toISOString();
		if (!this.configured) return { state: "unconfigured", checkedAt: checkedAt(), latencyMs: null };
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const err = new Error(`probe did not finish in ${timeoutMs} ms`);
				err.name = "TimeoutError";
				reject(err);
			}, timeoutMs);
			timer.unref();
		});
		try {
			await Promise.race([
				(async () => {
					await this.ensureSchema();
					await this.getClient().insert({
						table: this.table("runtime_ingester_heartbeat"),
						format: "JSONEachRow",
						clickhouse_settings: INSERT_SETTINGS,
						values: [{ instance_id: instanceId, version, checked_at: new Date().toISOString() }],
					});
					if (!this.serverVersion) {
						const rows = await this.getClient().query({ query: "SELECT version() AS v", format: "JSONEachRow" });
						this.serverVersion = (await rows.json<{ v: string }>())[0]?.v ?? null;
					}
				})(),
				timeout,
			]);
			return { state: "up", checkedAt: checkedAt(), latencyMs: Date.now() - started };
		} catch (err) {
			const category = storageErrorCategory(err);
			if (category === "schema") this.resetSchema();
			console.warn(
				`clickhouse readiness probe failed (${category}):`,
				err instanceof Error ? err.message : err,
			);
			return { state: stateFor(category), checkedAt: checkedAt(), latencyMs: Date.now() - started };
		} finally {
			clearTimeout(timer);
		}
	}

	/** Dead-lettered sink batches (sink-dead-letters.ts); rows carry their tenant. */
	async insertSinkDeadLetters(rows: SinkDeadLetterRow[]): Promise<void> {
		if (!rows.length || !this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_sink_dead_letters"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: rows.map((row) => ({
				org_id: row.orgId,
				repository_id: row.repositoryId,
				batch_id: row.batchId,
				reason: row.reason,
				occurrences: row.occurrences,
				metric_points: row.metricPoints,
				llm_calls: row.llmCalls,
				signals_from: row.signalsFrom ?? row.enqueuedAt,
				signals_to: row.signalsTo ?? row.enqueuedAt,
				attempts: row.attempts,
				enqueued_at: row.enqueuedAt,
				dropped_at: row.droppedAt,
				instance_id: row.instanceId,
				file: row.file,
			})),
		}, undefined, false);
	}

	/**
	 * Trace ids (from `traceIds`) that already produced an occurrence for
	 * this tenant in [from, to] — the cross-batch half of the log-promotion
	 * dedupe. `excludeIds` are the candidate occurrences' own deterministic
	 * ids, so a retried batch does not dedupe against its own earlier,
	 * partially-committed write. Browser occurrences share the server's trace
	 * id (runtime-browser traceparent) but are a different signal, so they
	 * never suppress a server error. Throws on failure; the caller decides.
	 */
	async recentOccurrenceTraceIds(
		ctx: IngestContext,
		traceIds: string[],
		from: Date,
		to: Date,
		excludeIds: string[],
	): Promise<Set<string>> {
		if (traceIds.length === 0 || !this.configured) return new Set();
		await this.ensureSchema();
		const rows = await this.getClient().query({
			query: `SELECT DISTINCT trace_id FROM ${this.table("runtime_error_occurrences")}
				WHERE org_id = {org:String} AND repository_id = {repo:String}
					AND occurred_at >= {from:DateTime64(3, 'UTC')} AND occurred_at <= {to:DateTime64(3, 'UTC')}
					AND source != 'browser'
					AND has({traces:Array(String)}, trace_id)
					AND NOT has({exclude:Array(String)}, occurrence_id)`,
			query_params: {
				org: ctx.orgId,
				repo: ctx.repositoryId,
				from: chDateTime(from),
				to: chDateTime(to),
				traces: traceIds,
				exclude: excludeIds,
			},
			format: "JSONEachRow",
		});
		return new Set(
			(await rows.json<{ trace_id: string }>()).map((row) => row.trace_id),
		);
	}

	/** Schema state as of the last ensureSchema attempt — never triggers DDL
	 * (it backs the unauthenticated /v1/compat endpoint). */
	schemaStatus(): { status: SchemaStatus; applied: string[] } {
		if (!this.configured) return { status: "unconfigured", applied: [] };
		return { status: this.schemaState, applied: [...this.appliedIds] };
	}

	async insertSdkVersions(ctx: IngestContext, rows: SdkVersionRow[]): Promise<void> {
		if (!rows.length || !this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_sdk_versions"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: rows.map((row) => ({
				org_id: ctx.orgId,
				repository_id: ctx.repositoryId,
				service: row.service,
				environment: row.environment,
				sdk_name: row.sdkName,
				sdk_version: row.sdkVersion,
				sdk_language: row.sdkLanguage,
				ingester_version: row.ingesterVersion,
				last_seen: row.seenAt.toISOString(),
				via: row.via,
			})),
		}, undefined, false);
	}

	/** Rejection and drop counts (ingest-drops.ts); rows carry their own tenant. */
	async insertIngestDrops(rows: IngestDropRow[]): Promise<void> {
		if (!rows.length || !this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_ingest_drops"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: rows.map((row) => ({
				org_id: row.orgId,
				repository_id: row.repositoryId,
				minute: row.minute.toISOString(),
				route: row.route,
				reason: row.reason,
				kind: row.kind,
				status: row.status,
				key_hash: row.keyHash,
				requests: row.requests,
				records: row.records,
			})),
		}, undefined, false);
	}

	/** Record this ingester's version and schema level (global, not tenant data). */
	async insertIngesterInfo(info: { version: string; schemaLevel: string; report: unknown }): Promise<void> {
		if (!this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_ingester_info"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: [{
				ingester_version: info.version,
				schema_level: info.schemaLevel,
				report: JSON.stringify(info.report),
				reported_at: new Date().toISOString(),
			}],
		}, undefined, false);
	}

	async ping(): Promise<boolean> {
		if (!this.configured) return false;
		const result = await this.getClient().ping();
		return result.success;
	}

	async insertOccurrences(
		ctx: IngestContext,
		occurrences: RuntimeOccurrence[],
		dedupToken?: string,
	): Promise<void> {
		if (occurrences.length === 0 || !this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_error_occurrences"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: occurrences.map((o) => ({
				...occurrenceFrameResolution(o),
				org_id: ctx.orgId,
				repository_id: ctx.repositoryId,
				occurrence_id: o.occurrenceId,
				fingerprint: o.fingerprint,
				source: o.source,
				severity: o.severity,
				service: o.service,
				environment: o.environment,
				release: o.release ?? "",
				error_type: o.errorType,
				message: o.message.slice(0, 4000),
				message_normalized: o.messageNormalized,
				stack: (o.stack ?? "").slice(0, 32000),
				top_frames: o.topFrames,
				first_frame: o.firstFrame,
				route: o.route ?? "",
				route_normalized: o.routeNormalized,
				method: o.method ?? "",
				status_code: o.statusCode ?? 0,
				trace_id: o.traceId ?? "",
				session_id: o.sessionId ?? "",
				attributes: JSON.stringify(attributesWithBreadcrumbs(o.attributes, o.breadcrumbs)),
				occurred_at: o.occurredAt.toISOString(),
				error_code: o.errorCode ?? "",
				error_why: o.why ?? "",
				error_fix: o.fix ?? "",
				error_link: o.link ?? "",
				expected: o.expected ? 1 : 0,
				request_id: o.requestId ?? "",
				fingerprint_scheme: o.fingerprintScheme,
				frames: o.frames?.length ? JSON.stringify(o.frames) : "",
				fingerprints: (o.fingerprints ?? []).map((candidate) => candidate.fingerprint),
				// Migration 0021: only collapsed samples name the column.
				...(o.collapsedCount ? { collapsed_count: Math.min(0xffff_ffff, Math.max(0, Math.round(o.collapsedCount))) } : {}),
			})),
		}, dedupToken);
	}

	async insertSpans(ctx: IngestContext, spans: RuntimeSpanRow[], dedupToken?: string): Promise<void> {
		if (spans.length === 0 || !this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_spans"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: spans.map((s) => ({
				org_id: ctx.orgId,
				repository_id: ctx.repositoryId,
				service: s.service,
				environment: s.environment,
				release: s.release ?? "",
				trace_id: s.traceId,
				span_id: s.spanId,
				parent_span_id: s.parentSpanId ?? "",
				name: s.name.slice(0, 500),
				kind: s.kind,
				status: s.status,
				route: s.route ?? "",
				status_code: s.statusCode ?? 0,
				duration_ms: s.durationMs,
				attributes: JSON.stringify(s.attributes ?? {}),
				started_at: s.startedAt.toISOString(),
			})),
		}, dedupToken);
	}

	async insertLogs(ctx: IngestContext, logs: RuntimeLogRecord[], dedupToken?: string): Promise<void> {
		if (!logs.length) return;
		if (!this.configured) throw new Error("CLICKHOUSE_URL is not configured");
		await this.insertTracked({ table: this.table("runtime_logs"), format: "JSONEachRow", clickhouse_settings: INSERT_SETTINGS,
			values: logs.map((row) => ({ org_id: ctx.orgId, repository_id: ctx.repositoryId, event_id: row.id,
				service: row.service, environment: row.environment, release: row.release, trace_id: row.traceId,
				span_id: row.spanId, operation_id: row.operationId, operation: row.operation, event_type: row.type,
				severity: row.severity, message: row.message, outcome: row.outcome, duration_ms: row.durationMs,
				attributes: JSON.stringify(row.attributes), occurred_at: row.occurredAt.toISOString(),
				kind: row.kind, request_id: row.requestId, route: row.route, status_code: row.statusCode,
				error_code: row.errorCode, ai_cost_usd: row.aiCostUsd, ai_calls: row.aiCalls })) }, dedupToken);
	}

	async insertProfileSamples(ctx: IngestContext, samples: ProfileSample[]): Promise<void> {
		if (!samples.length) return;
		if (!this.configured) throw new Error("CLICKHOUSE_URL is not configured");
		await this.insertTracked({
			table: this.table("runtime_profile_samples"), format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: samples.map((sample) => ({
				org_id: ctx.orgId, repository_id: ctx.repositoryId,
				profile_id: sample.profileId, sample_index: sample.sampleIndex, service: sample.service,
				environment: sample.environment, release: sample.release,
				trace_id: sample.traceId, instance_id: sample.instanceId, observed_at: sample.observedAt.toISOString(),
				sample_type: sample.sampleType, unit: sample.unit,
				stack: sample.stack, value: sample.value,
			})),
		});
	}

	async insertMemorySamples(ctx: IngestContext, samples: MemorySample[], dedupToken?: string): Promise<void> {
		if (!samples.length) return;
		if (!this.configured) throw new Error("CLICKHOUSE_URL is not configured");
		await this.insertTracked({ table: this.table("runtime_memory_samples"), format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: samples.map((s) => ({ org_id: ctx.orgId, repository_id: ctx.repositoryId,
				service: s.service, environment: s.environment, release: s.release,
				instance_id: s.instanceId, metric: s.metric, value: s.value, temporality: s.temporality,
				observed_at: s.observedAt.toISOString() })) }, dedupToken);
	}

	async insertPlatformEvent(ctx: IngestContext, event: PlatformEvent): Promise<void> {
		if (!this.configured) throw new Error("CLICKHOUSE_URL is not configured");
		await this.insertTracked({ table: this.table("runtime_platform_events"), format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: [{ org_id: ctx.orgId, repository_id: ctx.repositoryId, event_id: event.eventId,
				service: event.service, environment: event.environment, release: event.release,
				instance_id: event.instanceId, platform: event.platform, kind: event.kind,
				occurred_at: event.occurredAt }] });
	}

	async insertSourceMap(ctx: IngestContext, sourceMap: ValidSourceMap): Promise<void> {
		await this.insertTracked({
			table: this.table("runtime_source_maps"), format: "JSONEachRow",
			// One row of up to 32 MiB. Parallel parsing cuts input into
			// 10 MiB chunks, refuses single JSON rows far past that, and gains
			// nothing on one row. A map past the async-insert buffer (10 MiB
			// by default) is inserted directly rather than buffered.
			clickhouse_settings: {
				...INSERT_SETTINGS,
				input_format_parallel_parsing: 0,
				...(sourceMap.map.length > ASYNC_INSERT_MAX_MAP_CHARS ? { async_insert: 0 } : {}),
			},
			values: [{ org_id: ctx.orgId, repository_id: ctx.repositoryId, release: sourceMap.release,
				filename: sourceMap.filename, map: sourceMap.map, debug_id: sourceMap.debugId,
				content_hash: sourceMap.contentHash }],
		});
	}

	/** The uploaded source map for a minified file, or null (source-maps-lookup.ts). */
	async lookupSourceMap(key: SourceMapKey): Promise<string | null> {
		if (!this.configured) return null;
		await this.ensureSchema();
		return lookupSourceMap(this.getClient(), this.config.clickhouseDatabase, key);
	}

	/** Indexes of `check.entries` this tenant uploaded recently (see presentSourceMaps). */
	async sourceMapsPresent(ctx: IngestContext, check: SourceMapCheck): Promise<number[]> {
		await this.ensureSchema();
		return presentSourceMaps(this.getClient(), this.config.clickhouseDatabase, ctx, check);
	}

	async insertLlmCalls(
		ctx: IngestContext,
		calls: RuntimeLlmCall[],
		dedupToken?: string,
	): Promise<void> {
		if (calls.length === 0 || !this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_llm_calls"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: calls.map((c) => ({
				org_id: ctx.orgId,
				repository_id: ctx.repositoryId,
				service: c.service,
				environment: c.environment,
				release: c.release ?? "",
				trace_id: c.traceId,
				span_id: c.spanId,
				provider: c.provider,
				model: c.model,
				operation: c.operation,
				input_tokens: Math.max(0, Math.round(c.inputTokens)),
				output_tokens: Math.max(0, Math.round(c.outputTokens)),
				cost_usd: c.costUsd,
				cost_source: c.costSource,
				duration_ms: c.durationMs,
				status: c.status,
				error_type: c.errorType,
				user_id: c.userId,
				session_id: c.sessionId,
				attributes: JSON.stringify(c.attributes ?? {}),
				started_at: c.startedAt.toISOString(),
			})),
		}, dedupToken);
	}

	async insertMetricPoints(
		ctx: IngestContext,
		points: RuntimeMetricPoint[],
		dedupToken?: string,
	): Promise<void> {
		if (points.length === 0 || !this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_metrics_1m"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: points.map((p) => ({
				org_id: ctx.orgId,
				repository_id: ctx.repositoryId,
				service: p.service,
				environment: p.environment,
				release: p.release ?? "",
				route: p.route,
				bucket_at: p.bucketAt.toISOString(),
				request_count: Math.max(0, Math.round(p.requestCount)),
				error_count: Math.max(0, Math.round(p.errorCount)),
				duration_sum_ms: p.durationSumMs,
				session_count: Math.max(0, Math.round(p.sessionCount)),
			})),
		}, dedupToken);
		// Their percentiles: the view folds these into runtime_route_latency_1m.
		const latency = points.filter((p) => p.latency && p.latency.valuesMs.length > 0);
		if (latency.length === 0) return;
		await this.insertTracked({
			table: this.table("runtime_route_latency_input"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: latency.map((p) => ({
				org_id: ctx.orgId,
				repository_id: ctx.repositoryId,
				service: p.service,
				environment: p.environment,
				release: p.release ?? "",
				route: p.route,
				bucket_at: p.bucketAt.toISOString(),
				values_ms: p.latency!.valuesMs,
				weights: p.latency!.weights.map((weight) => Math.max(0, Math.round(weight))),
			})),
		}, dedupToken);
	}

	async insertLatencyHistograms(ctx: IngestContext, points: LatencyHistogram[], dedupToken?: string): Promise<void> {
		if (points.length === 0 || !this.configured) return;
		await this.insertTracked({
			table: this.table("runtime_latency_histograms"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: points.map((point) => ({
				org_id: ctx.orgId, repository_id: ctx.repositoryId, point_id: point.pointId,
				service: point.service, environment: point.environment, release: point.release,
				method: point.method, route: point.route, bucket_at: point.bucketAt.toISOString(),
				request_count: point.requestCount, error_count: point.errorCount,
				duration_sum_ms: point.durationSumMs, bounds_ms: point.boundsMs, counts: point.counts,
			})),
		}, dedupToken);
	}

	async close(): Promise<void> {
		if (!this.client) return;
		const client = this.client;
		this.client = null;
		await client.close().catch(() => {});
	}
}
