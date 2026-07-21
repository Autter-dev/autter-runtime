export interface StaticIngestKey {
	key: string;
	orgId: string;
	repositoryId: string;
}

export interface IngesterConfig {
	port: number;
	/** e.g. http://localhost:8123 or https://xyz.clickhouse.cloud:8443 */
	clickhouseUrl: string | null;
	clickhouseUser: string;
	clickhousePassword: string;
	clickhouseDatabase: string;
	/** Static key → tenant mapping (self-host). JSON array. */
	ingestKeys: StaticIngestKey[];
	/** Webhook that maps a key to a tenant (cloud). POST {key} → {orgId, repositoryId}. */
	keyValidatorUrl: string | null;
	keyValidatorToken: string | null;
	/** Optional webhook receiving fingerprinted occurrences for issue grouping. */
	sinkUrl: string | null;
	sinkToken: string | null;
	maxBodyBytes: number;
	/** Per-key requests per minute. */
	rateLimitPerMinute: number;
	/** Retention, overridable per deployment. */
	occurrenceTtlDays: number;
	spanTtlDays: number;
	metricsTtlDays: number;
}

function intEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseIngestKeys(raw: string | undefined): StaticIngestKey[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is StaticIngestKey =>
				entry &&
				typeof entry.key === "string" &&
				typeof entry.orgId === "string" &&
				typeof entry.repositoryId === "string",
		);
	} catch {
		console.error("AUTTER_INGEST_KEYS is not valid JSON — ignoring");
		return [];
	}
}

export function loadConfig(): IngesterConfig {
	const config: IngesterConfig = {
		port: intEnv("PORT", 4318),
		clickhouseUrl: process.env.CLICKHOUSE_URL || null,
		clickhouseUser: process.env.CLICKHOUSE_USER || "default",
		clickhousePassword: process.env.CLICKHOUSE_PASSWORD || "",
		clickhouseDatabase: process.env.CLICKHOUSE_DATABASE || "autter_runtime",
		ingestKeys: parseIngestKeys(process.env.AUTTER_INGEST_KEYS),
		keyValidatorUrl: process.env.AUTTER_KEY_VALIDATOR_URL || null,
		keyValidatorToken: process.env.AUTTER_KEY_VALIDATOR_TOKEN || null,
		sinkUrl: process.env.AUTTER_SINK_URL || null,
		sinkToken: process.env.AUTTER_SINK_TOKEN || null,
		maxBodyBytes: intEnv("MAX_BODY_BYTES", 1024 * 1024),
		rateLimitPerMinute: intEnv("RATE_LIMIT_PER_MINUTE", 300),
		occurrenceTtlDays: intEnv("OCCURRENCE_TTL_DAYS", 14),
		spanTtlDays: intEnv("SPAN_TTL_DAYS", 7),
		metricsTtlDays: intEnv("METRICS_TTL_DAYS", 90),
	};
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.clickhouseDatabase)) {
		throw new Error(
			`Invalid CLICKHOUSE_DATABASE name: ${config.clickhouseDatabase}`,
		);
	}
	if (config.ingestKeys.length === 0 && !config.keyValidatorUrl) {
		console.warn(
			"No AUTTER_INGEST_KEYS and no AUTTER_KEY_VALIDATOR_URL configured — all ingest requests will be rejected with 401",
		);
	}
	return config;
}
