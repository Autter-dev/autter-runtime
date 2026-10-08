export interface StaticIngestKey {
	key: string;
	orgId: string;
	repositoryId: string;
	/** "server" (default) = secret backend key; "client" = publishable browser key. */
	scope?: "client" | "server";
	/** client keys: exact origins allowed to send (e.g. https://app.example.com). */
	allowedOrigins?: string[];
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
	/** Sink delivery attempts per batch before giving up (backoff-capped ~8 min). */
	sinkMaxAttempts: number;
	/** Bounds for the in-memory sink retry buffer; oldest batches drop first. */
	sinkMaxBufferedBatches: number;
	sinkMaxBufferedMb: number;
	maxBodyBytes: number;
	/** Per-key requests per minute (server keys). */
	rateLimitPerMinute: number;
	/** Per-key requests per minute for publishable client keys. */
	clientRateLimitPerMinute: number;
	/** ClickHouse dedupe lookups per tenant per minute for /v1/logs promotion. */
	promotionLookupsPerMinute?: number;
	/** Retention, overridable per deployment. */
	occurrenceTtlDays: number;
	spanTtlDays: number;
	metricsTtlDays: number;
	llmCallTtlDays: number;
	/**
	 * runtime_logs retention (LOG_TTL_DAYS, default 14). Request summaries are
	 * always kept (never sampled), so this is the main volume knob. Applied to
	 * fresh tables by the baseline and to existing ones at boot.
	 */
	logTtlDays: number;
	/**
	 * Extra regex sources scrubbed from stored/forwarded free text and
	 * attribute values, and extra regex sources for sensitive attribute
	 * keys — on top of the built-in secret/PII patterns (see redact.ts).
	 * Env: AUTTER_REDACT_VALUE_PATTERNS / AUTTER_REDACT_KEY_PATTERNS (JSON
	 * arrays of strings).
	 */
	redactValuePatterns?: string[];
	redactKeyPatterns?: string[];
}

function intEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** JSON array of regex sources; invalid input fails startup loudly rather
 * than silently running without the operator's extra patterns. */
function patternListEnv(name: string): string[] {
	const raw = process.env[name];
	if (!raw) return [];
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string")) {
		throw new Error(`${name} must be a JSON array of regex source strings`);
	}
	for (const source of parsed) new RegExp(source as string);
	return parsed as string[];
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
		// 12 attempts with 1s..60s exponential backoff spans ~8 minutes — long
		// enough to ride out a routine consumer deploy without unbounded memory.
		sinkMaxAttempts: intEnv("SINK_MAX_ATTEMPTS", 12),
		sinkMaxBufferedBatches: intEnv("SINK_MAX_BUFFERED_BATCHES", 1000),
		sinkMaxBufferedMb: intEnv("SINK_MAX_BUFFERED_MB", 64),
		maxBodyBytes: intEnv("MAX_BODY_BYTES", 1024 * 1024),
		rateLimitPerMinute: intEnv("RATE_LIMIT_PER_MINUTE", 300),
		clientRateLimitPerMinute: intEnv("CLIENT_RATE_LIMIT_PER_MINUTE", 120),
		promotionLookupsPerMinute: intEnv("PROMOTION_LOOKUPS_PER_MINUTE", 30),
		occurrenceTtlDays: intEnv("OCCURRENCE_TTL_DAYS", 14),
		spanTtlDays: intEnv("SPAN_TTL_DAYS", 7),
		metricsTtlDays: intEnv("METRICS_TTL_DAYS", 90),
		// LLM calls keep the metrics horizon, not the span one — cost trends
		// need months, and per-call volume is small next to HTTP spans.
		llmCallTtlDays: intEnv("LLM_CALL_TTL_DAYS", 90),
		logTtlDays: intEnv("LOG_TTL_DAYS", 14),
		redactValuePatterns: patternListEnv("AUTTER_REDACT_VALUE_PATTERNS"),
		redactKeyPatterns: patternListEnv("AUTTER_REDACT_KEY_PATTERNS"),
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
