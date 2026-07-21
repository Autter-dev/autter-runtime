import {
	createClient,
	type ClickHouseClient,
	type ClickHouseSettings,
} from "@clickhouse/client";
import type { IngesterConfig } from "./config.js";
import type {
	IngestContext,
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

export class ClickHouseStore {
	private client: ClickHouseClient | null = null;
	private ensurePromise: Promise<void> | null = null;

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
		const { occurrenceTtlDays, spanTtlDays, metricsTtlDays } = this.config;
		return [
			`CREATE DATABASE IF NOT EXISTS ${db}`,
			`CREATE TABLE IF NOT EXISTS ${db}.runtime_error_occurrences (
				org_id           String,
				repository_id    String,
				occurrence_id    String,
				fingerprint      String,
				source           LowCardinality(String),
				service          LowCardinality(String),
				environment      LowCardinality(String),
				release          String DEFAULT '',
				error_type       String,
				message          String,
				stack            String DEFAULT '',
				route            String DEFAULT '',
				status_code      UInt16 DEFAULT 0,
				trace_id         String DEFAULT '',
				session_id       String DEFAULT '',
				attributes       String DEFAULT '{}',
				occurred_at      DateTime64(3, 'UTC'),
				ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)
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
				attributes       String DEFAULT '{}',
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
		];
	}

	ensureSchema(): Promise<void> {
		if (this.ensurePromise) return this.ensurePromise;
		this.ensurePromise = (async () => {
			const client = this.getClient();
			for (const statement of this.schemaStatements()) {
				await client.command({ query: statement });
			}
		})().catch((err) => {
			this.ensurePromise = null;
			throw err;
		});
		return this.ensurePromise;
	}

	async ping(): Promise<boolean> {
		if (!this.configured) return false;
		const result = await this.getClient().ping();
		return result.success;
	}

	async insertOccurrences(
		ctx: IngestContext,
		occurrences: RuntimeOccurrence[],
	): Promise<void> {
		if (occurrences.length === 0 || !this.configured) return;
		await this.ensureSchema();
		await this.getClient().insert({
			table: this.table("runtime_error_occurrences"),
			format: "JSONEachRow",
			clickhouse_settings: INSERT_SETTINGS,
			values: occurrences.map((o) => ({
				org_id: ctx.orgId,
				repository_id: ctx.repositoryId,
				occurrence_id: o.occurrenceId,
				fingerprint: o.fingerprint,
				source: o.source,
				service: o.service,
				environment: o.environment,
				release: o.release ?? "",
				error_type: o.errorType,
				message: o.message.slice(0, 4000),
				stack: (o.stack ?? "").slice(0, 32000),
				route: o.route ?? "",
				status_code: o.statusCode ?? 0,
				trace_id: o.traceId ?? "",
				session_id: o.sessionId ?? "",
				attributes: JSON.stringify(o.attributes ?? {}),
				occurred_at: o.occurredAt.toISOString(),
			})),
		});
	}

	async insertSpans(ctx: IngestContext, spans: RuntimeSpanRow[]): Promise<void> {
		if (spans.length === 0 || !this.configured) return;
		await this.ensureSchema();
		await this.getClient().insert({
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
		});
	}

	async insertMetricPoints(
		ctx: IngestContext,
		points: RuntimeMetricPoint[],
	): Promise<void> {
		if (points.length === 0 || !this.configured) return;
		await this.ensureSchema();
		await this.getClient().insert({
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
		});
	}

	async close(): Promise<void> {
		if (!this.client) return;
		const client = this.client;
		this.client = null;
		await client.close().catch(() => {});
	}
}
