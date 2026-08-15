/**
 * ClickHouse schema migrations.
 *
 * The baseline schema in clickhouse.ts uses `CREATE TABLE IF NOT EXISTS`,
 * which provisions FRESH databases but silently no-ops on existing ones —
 * so schema changes to already-deployed databases go here. Migrations run
 * automatically at ingester boot (and lazily before the first ingest),
 * strictly in array order, and each applied id is recorded in
 * `<db>.schema_migrations` so it runs exactly once per database.
 *
 * Rules for adding a migration:
 * 1. Statements MUST be idempotent (`ADD COLUMN IF NOT EXISTS`,
 *    `DROP COLUMN IF EXISTS`, `MODIFY TTL`, …) — multiple ingester
 *    replicas may boot concurrently and race; idempotency makes the race
 *    harmless. The tracking table is bookkeeping, not a lock.
 * 2. Additive only within a major version: new columns need a DEFAULT so
 *    old ingester replicas that are still running (rolling deploy) can
 *    keep inserting without naming them.
 * 3. ALSO update the baseline in clickhouse.ts `schemaStatements()` so
 *    fresh databases come up with the final shape — a migration alone
 *    only fixes existing databases.
 * 4. Never edit or reorder shipped migrations; append a corrective one.
 *
 * `{db}` is replaced with the configured database name at run time.
 *
 * Example (what adding a column looks like):
 *   {
 *     id: "0002-occurrences-sdk-version",
 *     statements: [
 *       `ALTER TABLE {db}.runtime_error_occurrences
 *          ADD COLUMN IF NOT EXISTS sdk_version String DEFAULT ''`,
 *     ],
 *   },
 */

export interface Migration {
	/** Unique, ordered id: "<serial>-<slug>". Never reuse or reorder. */
	id: string;
	statements: string[];
}

export const MIGRATIONS: Migration[] = [
	// 0001 intentionally reserved as the baseline marker: databases created
	// before the migration runner existed record it as applied without
	// running anything (the baseline CREATEs already shaped them).
	{ id: "0001-baseline", statements: [] },
	// Aggregation-ready occurrence shape: severity (warnings/info share the
	// table with errors), pre-normalised route/message, extracted stack
	// frames, and the request method — so later aggregations GROUP BY
	// stored columns instead of re-parsing stacks/routes in SQL.
	{
		id: "0002-occurrences-aggregation-columns",
		statements: [
			`ALTER TABLE {db}.runtime_error_occurrences
				ADD COLUMN IF NOT EXISTS severity LowCardinality(String) DEFAULT 'error' AFTER source`,
			`ALTER TABLE {db}.runtime_error_occurrences
				ADD COLUMN IF NOT EXISTS message_normalized String DEFAULT '' AFTER message`,
			`ALTER TABLE {db}.runtime_error_occurrences
				ADD COLUMN IF NOT EXISTS top_frames Array(String) DEFAULT [] AFTER stack`,
			`ALTER TABLE {db}.runtime_error_occurrences
				ADD COLUMN IF NOT EXISTS first_frame String DEFAULT '' AFTER top_frames`,
			`ALTER TABLE {db}.runtime_error_occurrences
				ADD COLUMN IF NOT EXISTS route_normalized String DEFAULT '' AFTER route`,
			`ALTER TABLE {db}.runtime_error_occurrences
				ADD COLUMN IF NOT EXISTS method LowCardinality(String) DEFAULT '' AFTER route_normalized`,
		],
	},
	// ZSTD compression on the fat text columns — stack traces and JSON
	// attributes compress several times better under ZSTD than the LZ4
	// default, and these columns dominate on-disk size. MODIFY COLUMN with
	// a codec is idempotent and cheap: new parts use it immediately, old
	// parts recompress on background merges.
	{
		id: "0003-compress-fat-columns",
		statements: [
			`ALTER TABLE {db}.runtime_error_occurrences
				MODIFY COLUMN stack String DEFAULT '' CODEC(ZSTD(3))`,
			`ALTER TABLE {db}.runtime_error_occurrences
				MODIFY COLUMN message String CODEC(ZSTD(1))`,
			`ALTER TABLE {db}.runtime_error_occurrences
				MODIFY COLUMN attributes String DEFAULT '{}' CODEC(ZSTD(1))`,
			`ALTER TABLE {db}.runtime_spans
				MODIFY COLUMN attributes String DEFAULT '{}' CODEC(ZSTD(1))`,
		],
	},
	// LLM observability: one row per provider call (model, tokens, cost,
	// latency, user) extracted from GenAI/Vercel-AI/Autter span attributes.
	// TTL is fixed at the 90-day default here; deployments that override
	// LLM_CALL_TTL_DAYS get it applied on fresh databases via the baseline.
	{
		id: "0004-llm-calls",
		statements: [
			`CREATE TABLE IF NOT EXISTS {db}.runtime_llm_calls (
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
			TTL toDateTime(started_at) + INTERVAL 90 DAY`,
		],
	},
];

/** The tracking table itself — created by the runner before anything else. */
export function migrationsTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.schema_migrations (
		id String,
		applied_at DateTime('UTC') DEFAULT now()
	)
	ENGINE = ReplacingMergeTree
	ORDER BY id`;
}
