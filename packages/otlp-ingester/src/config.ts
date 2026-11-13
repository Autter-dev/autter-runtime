import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveConfigFromEnv, type ArchiveConfig } from "./archive.js";
import { loadLlmPriceOverrides, type LlmPriceOverrides } from "./llm-pricing.js";
import type { IngestKeyScope } from "./types.js";

export const INGEST_KEY_SCOPES: readonly IngestKeyScope[] = ["server", "client", "upload"];

/** Prefix of upload-only keys (`autter_rtu_…`): source map uploads from CI. */
export const UPLOAD_KEY_PREFIX = "autter_rtu_";

/**
 * The built-in local development key. Accepted only by an ingester started
 * with AUTTER_LOCAL_DEV=1 (the repo's docker-compose.yml sets it), without a
 * key validator, and only from loopback and private addresses: see
 * localDevMode and isLocalAddress. Every other ingester refuses it, also when
 * it is listed in AUTTER_INGEST_KEYS. It is not a secret: never use it, or
 * AUTTER_LOCAL_DEV, on an ingester other machines can reach.
 */
export const LOCAL_DEV_KEY = "autter_rt_local_dev_only";

export function isIngestKeyScope(value: unknown): value is IngestKeyScope {
	return typeof value === "string" && (INGEST_KEY_SCOPES as readonly string[]).includes(value);
}

/**
 * The scope of a key whose static entry or validator answer names none:
 * "upload" for an `autter_rtu_…` key (its prefix promises no more than
 * that), else "server" as before 1.7.0.
 */
export function defaultScopeFor(key: string): IngestKeyScope {
	return key.startsWith(UPLOAD_KEY_PREFIX) ? "upload" : "server";
}

export interface StaticIngestKey {
	key: string;
	orgId: string;
	repositoryId: string;
	/**
	 * "server" = secret backend key, every route; "client" = publishable
	 * browser key, `/v1/browser` only; "upload" = CI key, `/v1/sourcemaps`
	 * and `/v1/sourcemaps/check` only. Default: "upload" for an
	 * `autter_rtu_…` key, else "server". An entry with any other value is
	 * ignored (never treated as a server key).
	 */
	scope?: IngestKeyScope;
	/**
	 * client keys: exact origins allowed to send (e.g. https://app.example.com,
	 * or http://localhost:3000 for local development). Required: a client key
	 * without one accepts no browser origin.
	 */
	allowedOrigins?: string[];
	/**
	 * Suppression rules for this key's repository (1.9.0, suppression.ts):
	 * `[{ "id": "…", "action": "drop" | "sample", "sampleRate"?: 0.1,
	 * "filters": [{ "key": "errorType", "op": "equals", "value": "…" }] }]`.
	 * Invalid rules are left out (logged once at startup).
	 */
	suppression?: unknown[];
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
	/**
	 * Local development mode (AUTTER_LOCAL_DEV=1): accept LOCAL_DEV_KEY from
	 * loopback and private addresses. Refused at startup with a key validator.
	 */
	localDev?: boolean;
	/** Optional webhook receiving fingerprinted occurrences for issue grouping. */
	sinkUrl: string | null;
	sinkToken: string | null;
	/**
	 * Sink delivery attempts per batch before it is dead-lettered
	 * (SINK_MAX_ATTEMPTS; 0 = no limit). Default: no limit with an outbox
	 * (the age limit applies), 12 (~8 min of backoff) without one.
	 */
	sinkMaxAttempts?: number;
	/** A batch still undelivered after this many hours is dead-lettered
	 * (SINK_MAX_AGE_HOURS, default 72). */
	sinkMaxAgeHours?: number;
	/** Bounds for the sink queue held in memory; past them the oldest batch
	 * of the heaviest tenant is dead-lettered. */
	sinkMaxBufferedBatches: number;
	sinkMaxBufferedMb: number;
	/**
	 * Directory where undelivered sink batches are kept so a restart resumes
	 * delivery (SINK_OUTBOX_DIR; `off` = memory only). loadConfig defaults
	 * it to a per-port directory under the OS temp dir when a sink is set;
	 * mount a volume there to survive container replacement. Unset (null or
	 * undefined) = memory only.
	 */
	sinkOutboxDir?: string | null;
	/** fsync each outbox write (SINK_OUTBOX_FSYNC=1): survives a host crash,
	 * not just a process crash. */
	sinkOutboxFsync?: boolean;
	/**
	 * SINK_OUTBOX_SHARED=1: SINK_OUTBOX_DIR is a volume every task mounts
	 * (EFS on Fargate). Each process uses its own subdirectory and adopts the
	 * batches of processes that are gone (sink-outbox.ts).
	 */
	sinkOutboxShared?: boolean;
	/** Budget for dead-lettered batches on disk (SINK_DEAD_LETTER_MAX_MB, default 256). */
	sinkDeadLetterMaxMb?: number;
	/**
	 * Journal of which tables each recent ingest request wrote
	 * (INSERT_RECEIPTS_FILE; `off` = memory only), so a retry after a restart
	 * does not insert committed rows again (insert-receipts.ts). loadConfig
	 * defaults it into the sink outbox directory, else the OS temp dir. Unset
	 * (null or undefined) = memory only.
	 */
	insertReceiptsFile?: string | null;
	maxBodyBytes: number;
	/** Requests per minute per tenant (repository) for server and upload keys; sliding window. */
	rateLimitPerMinute: number;
	/** Requests per minute per tenant for publishable client keys; sliding window. */
	clientRateLimitPerMinute: number;
	/**
	 * Records (spans, log records, data points, browser events, profile
	 * samples) per minute per tenant, server and upload keys
	 * (RECORD_LIMIT_PER_MINUTE, default 600,000). Checked with the request
	 * limit; a request is let in while budget is left and charged in full.
	 */
	recordLimitPerMinute?: number;
	/** Records per minute per tenant for client keys (CLIENT_RECORD_LIMIT_PER_MINUTE, default 6,000). */
	clientRecordLimitPerMinute?: number;
	/** ClickHouse dedupe lookups per tenant per minute for /v1/logs promotion. */
	promotionLookupsPerMinute?: number;
	/**
	 * POST requests per minute per client address (IPv6 per /64), checked
	 * before the body is read or a key is looked at (IP_RATE_LIMIT_PER_MINUTE,
	 * default 6,000; 0 turns it off). Always per process.
	 */
	ipRateLimitPerMinute?: number;
	/**
	 * Validator lookups per minute per client address for keys in neither
	 * key cache (IP_UNKNOWN_KEY_LOOKUPS_PER_MINUTE, default 30). Past it, such
	 * keys get 429 without the validator being asked.
	 */
	ipUnknownKeyLookupsPerMinute?: number;
	/** The same budget for the whole ingester (UNKNOWN_KEY_LOOKUPS_PER_MINUTE, default 600). */
	unknownKeyLookupsPerMinute?: number;
	/**
	 * Redis for limits shared by every replica (AUTTER_REDIS_URL, e.g.
	 * redis://host:6379 or rediss://…). Unset: each process counts alone.
	 */
	redisUrl?: string | null;
	/**
	 * Replicas behind the load balancer (AUTTER_INGESTER_REPLICAS, default 1).
	 * Without Redis, each process enforces limit / replicas, and more than one
	 * replica without Redis is warned about at startup.
	 */
	replicas?: number;
	/**
	 * Proxy hops in front of the ingester whose X-Forwarded-For is trusted
	 * for the client address (TRUST_PROXY, default 1: a load balancer or
	 * Caddy; 0 when the ingester is exposed directly).
	 */
	trustProxy?: number;
	/** Retention, overridable per deployment. */
	occurrenceTtlDays: number;
	spanTtlDays: number;
	metricsTtlDays: number;
	llmCallTtlDays: number;
	/**
	 * LLM prices merged over the built-in table (AUTTER_LLM_PRICES_FILE, a
	 * JSON file; see llm-pricing.ts). Read and validated at startup: an
	 * invalid file stops the ingester. Null: the built-in table only.
	 */
	llmPriceOverrides?: LlmPriceOverrides | null;
	/**
	 * runtime_logs retention (LOG_TTL_DAYS, default 14). Request summaries are
	 * always kept (never sampled), so this is the main volume knob. Applied to
	 * fresh tables by the baseline, and to existing ones at boot only when
	 * set (logTtlDaysExplicit).
	 */
	logTtlDays: number;
	/**
	 * LOG_TTL_DAYS was set: existing runtime_logs tables follow it at boot
	 * (a longer TTL at once, a shorter one only when no older rows would be
	 * deleted). Unset, an existing TTL is left as it is.
	 */
	logTtlDaysExplicit?: boolean;
	/**
	 * Extra regex sources scrubbed from stored/forwarded free text and
	 * attribute values, and extra regex sources for sensitive attribute
	 * keys — on top of the built-in secret/PII patterns (see redact.ts).
	 * Env: AUTTER_REDACT_VALUE_PATTERNS / AUTTER_REDACT_KEY_PATTERNS (JSON
	 * arrays of strings).
	 */
	redactValuePatterns?: string[];
	redactKeyPatterns?: string[];
	/**
	 * In-memory budget (MiB, decoded size) for parsed source maps used to
	 * symbolicate browser frames at ingest (SOURCE_MAP_CACHE_MB, default 64).
	 * A map that needs more than half of it is used without being kept.
	 */
	sourceMapCacheMb?: number;
	/**
	 * Loop collapse (1.9.0, loop-collapse.ts): identical occurrences stored
	 * per minute before the rest are folded into one sample with an exact
	 * count (LOOP_COLLAPSE_AFTER, default 10; 0 turns it off).
	 */
	loopCollapseAfter?: number;
	/**
	 * Tiered retention (1.14.0, archive.ts): Parquet in object storage for
	 * days older than each table's hot window (ARCHIVE_S3_URL or
	 * ARCHIVE_S3_NAMED_COLLECTION). Null/undefined = no archive: TTLs delete
	 * as before.
	 */
	archive?: ArchiveConfig | null;
}

/** LOOP_COLLAPSE_AFTER: a whole number ≥ 0 (0 = off); anything else is the default, 10. */
export function loopCollapseAfterEnv(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return 10;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : 10;
}

/** A whole number ≥ 0 (0 allowed: "off" or "no proxy"); anything else is the fallback. */
function wholeEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** SINK_MAX_ATTEMPTS: a whole number ≥ 0 (0 = no limit), or undefined for the default. */
export function sinkMaxAttemptsEnv(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** SINK_OUTBOX_DIR: `off`/`none`/`false`/`0` disables the outbox; unset
 * defaults to a per-port directory under the OS temp dir when a sink is set. */
export function sinkOutboxDirEnv(raw: string | undefined, sinkUrl: string | null, port: number): string | null {
	if (!sinkUrl) return null;
	const value = raw?.trim();
	if (value && /^(off|none|false|0)$/i.test(value)) return null;
	return value || join(tmpdir(), `autter-sink-outbox-${port}`);
}

/** INSERT_RECEIPTS_FILE: `off`/`none`/`false`/`0` = memory only; unset = in
 * the sink outbox directory when there is one, else the OS temp dir. */
export function insertReceiptsFileEnv(raw: string | undefined, outboxDir: string | null, port: number): string | null {
	const value = raw?.trim();
	if (value && /^(off|none|false|0)$/i.test(value)) return null;
	if (value) return value;
	return outboxDir ? join(outboxDir, "insert-receipts.log") : join(tmpdir(), `autter-insert-receipts-${port}.log`);
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

/** Parse AUTTER_INGEST_KEYS. Entries without a string key, orgId and
 * repositoryId, or with an unknown scope, are dropped (a typo in `scope`
 * must not turn a restricted key into a server key). */
export function parseIngestKeys(raw: string | undefined): StaticIngestKey[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.error("AUTTER_INGEST_KEYS is not valid JSON — ignoring");
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const keys: StaticIngestKey[] = [];
	parsed.forEach((entry: Partial<StaticIngestKey> | null, index) => {
		if (!entry || typeof entry.key !== "string" || typeof entry.orgId !== "string" || typeof entry.repositoryId !== "string") return;
		if (entry.scope !== undefined && !isIngestKeyScope(entry.scope)) {
			console.error(
				`AUTTER_INGEST_KEYS[${index}] has scope ${JSON.stringify(entry.scope)}; expected one of ${INGEST_KEY_SCOPES.join(", ")} — ignoring this key`,
			);
			return;
		}
		keys.push({ ...entry, scope: entry.scope ?? defaultScopeFor(entry.key) } as StaticIngestKey);
	});
	return keys;
}

/**
 * AUTTER_LOCAL_DEV: true for 1/true/yes. Refused together with a key
 * validator (the hosted and cloud-connected setups), so the flag cannot open
 * a deployed ingester to the built-in key.
 */
export function localDevMode(raw: string | undefined, keyValidatorUrl: string | null): boolean {
	if (!/^(1|true|yes)$/i.test(raw?.trim() ?? "")) return false;
	if (keyValidatorUrl) {
		throw new Error(
			"AUTTER_LOCAL_DEV is for the local docker compose setup and cannot be combined with AUTTER_KEY_VALIDATOR_URL — unset AUTTER_LOCAL_DEV",
		);
	}
	return true;
}

/**
 * The static keys an ingester uses: LOCAL_DEV_KEY is added in local dev mode
 * and removed (with an error) everywhere else.
 */
export function withLocalDevKey(keys: StaticIngestKey[], localDev: boolean): StaticIngestKey[] {
	const others = keys.filter((entry) => entry.key !== LOCAL_DEV_KEY);
	if (!localDev) {
		if (others.length < keys.length) {
			console.error(
				`AUTTER_INGEST_KEYS lists the built-in local key ${LOCAL_DEV_KEY}, which only an ingester started with AUTTER_LOCAL_DEV=1 accepts — ignoring it`,
			);
		}
		return others;
	}
	return [...others, { key: LOCAL_DEV_KEY, orgId: "local", repositoryId: "local", scope: "server" }];
}

/**
 * Loopback or private-network addresses: this machine, or a Docker bridge
 * gateway in front of it. The local dev key is refused from anything else.
 */
export function isLocalAddress(address: string | undefined): boolean {
	let ip = (address ?? "").trim().toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
	if (mapped) ip = mapped[1]!;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
	}
	if (ip === "::1") return true;
	// fc00::/7 unique local, fe80::/10 link-local.
	return /^f[cd][0-9a-f]{0,2}:/.test(ip) || /^fe[89ab][0-9a-f]?:/.test(ip);
}

export function loadConfig(): IngesterConfig {
	const keyValidatorUrl = process.env.AUTTER_KEY_VALIDATOR_URL || null;
	const localDev = localDevMode(process.env.AUTTER_LOCAL_DEV, keyValidatorUrl);
	const config: IngesterConfig = {
		port: intEnv("PORT", 4318),
		clickhouseUrl: process.env.CLICKHOUSE_URL || null,
		clickhouseUser: process.env.CLICKHOUSE_USER || "default",
		clickhousePassword: process.env.CLICKHOUSE_PASSWORD || "",
		clickhouseDatabase: process.env.CLICKHOUSE_DATABASE || "autter_runtime",
		ingestKeys: withLocalDevKey(parseIngestKeys(process.env.AUTTER_INGEST_KEYS), localDev),
		keyValidatorUrl,
		localDev,
		keyValidatorToken: process.env.AUTTER_KEY_VALIDATOR_TOKEN || null,
		sinkUrl: process.env.AUTTER_SINK_URL || null,
		sinkToken: process.env.AUTTER_SINK_TOKEN || null,
		// 12 attempts with 1s..60s exponential backoff spans ~8 minutes — long
		// enough to ride out a routine consumer deploy without unbounded memory.
		sinkMaxAttempts: sinkMaxAttemptsEnv(process.env.SINK_MAX_ATTEMPTS),
		sinkMaxAgeHours: intEnv("SINK_MAX_AGE_HOURS", 72),
		sinkOutboxDir: sinkOutboxDirEnv(process.env.SINK_OUTBOX_DIR, process.env.AUTTER_SINK_URL || null, intEnv("PORT", 4318)),
		sinkOutboxFsync: /^(1|true|yes)$/i.test(process.env.SINK_OUTBOX_FSYNC ?? ""),
		sinkOutboxShared: /^(1|true|yes)$/i.test(process.env.SINK_OUTBOX_SHARED ?? ""),
		sinkDeadLetterMaxMb: intEnv("SINK_DEAD_LETTER_MAX_MB", 256),
		insertReceiptsFile: null,
		sinkMaxBufferedBatches: intEnv("SINK_MAX_BUFFERED_BATCHES", 1000),
		sinkMaxBufferedMb: intEnv("SINK_MAX_BUFFERED_MB", 64),
		maxBodyBytes: intEnv("MAX_BODY_BYTES", 1024 * 1024),
		rateLimitPerMinute: intEnv("RATE_LIMIT_PER_MINUTE", 300),
		clientRateLimitPerMinute: intEnv("CLIENT_RATE_LIMIT_PER_MINUTE", 120),
		recordLimitPerMinute: intEnv("RECORD_LIMIT_PER_MINUTE", 600_000),
		clientRecordLimitPerMinute: intEnv("CLIENT_RECORD_LIMIT_PER_MINUTE", 6_000),
		promotionLookupsPerMinute: intEnv("PROMOTION_LOOKUPS_PER_MINUTE", 30),
		ipRateLimitPerMinute: wholeEnv("IP_RATE_LIMIT_PER_MINUTE", 6_000),
		ipUnknownKeyLookupsPerMinute: intEnv("IP_UNKNOWN_KEY_LOOKUPS_PER_MINUTE", 30),
		unknownKeyLookupsPerMinute: intEnv("UNKNOWN_KEY_LOOKUPS_PER_MINUTE", 600),
		redisUrl: process.env.AUTTER_REDIS_URL || null,
		replicas: intEnv("AUTTER_INGESTER_REPLICAS", 1),
		trustProxy: wholeEnv("TRUST_PROXY", 1),
		occurrenceTtlDays: intEnv("OCCURRENCE_TTL_DAYS", 14),
		spanTtlDays: intEnv("SPAN_TTL_DAYS", 7),
		metricsTtlDays: intEnv("METRICS_TTL_DAYS", 90),
		// LLM calls keep the metrics horizon, not the span one — cost trends
		// need months, and per-call volume is small next to HTTP spans.
		llmCallTtlDays: intEnv("LLM_CALL_TTL_DAYS", 90),
		llmPriceOverrides: process.env.AUTTER_LLM_PRICES_FILE
			? loadLlmPriceOverrides(process.env.AUTTER_LLM_PRICES_FILE)
			: null,
		logTtlDays: intEnv("LOG_TTL_DAYS", 14),
		logTtlDaysExplicit: Number.parseInt(process.env.LOG_TTL_DAYS ?? "", 10) > 0,
		redactValuePatterns: patternListEnv("AUTTER_REDACT_VALUE_PATTERNS"),
		redactKeyPatterns: patternListEnv("AUTTER_REDACT_KEY_PATTERNS"),
		sourceMapCacheMb: intEnv("SOURCE_MAP_CACHE_MB", 64),
		loopCollapseAfter: loopCollapseAfterEnv(process.env.LOOP_COLLAPSE_AFTER),
		archive: archiveConfigFromEnv(process.env),
	};
	// A shared outbox is on a network volume every task mounts: keep the
	// receipts journal on the task's own disk (Redis shares receipts there).
	config.insertReceiptsFile = insertReceiptsFileEnv(
		process.env.INSERT_RECEIPTS_FILE,
		config.sinkOutboxShared ? null : (config.sinkOutboxDir ?? null),
		config.port,
	);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.clickhouseDatabase)) {
		throw new Error(
			`Invalid CLICKHOUSE_DATABASE name: ${config.clickhouseDatabase}`,
		);
	}
	if (localDev) {
		console.warn(
			`WARNING: local dev mode (AUTTER_LOCAL_DEV): accepting the built-in key ${LOCAL_DEV_KEY} from this machine and private networks. Never set AUTTER_LOCAL_DEV on a deployed ingester.`,
		);
	}
	if (config.ingestKeys.length === 0 && !config.keyValidatorUrl) {
		console.warn(
			"No AUTTER_INGEST_KEYS and no AUTTER_KEY_VALIDATOR_URL configured — all ingest requests will be rejected with 401 (for a local try-out, the repo's docker-compose.yml sets AUTTER_LOCAL_DEV=1)",
		);
	}
	return config;
}

/**
 * The startup warning for limits that are not shared: more than one replica
 * and no Redis. Null when there is nothing to warn about.
 */
export function limitsWarning(config: Pick<IngesterConfig, "redisUrl" | "replicas">): string | null {
	const replicas = config.replicas ?? 1;
	if (config.redisUrl || replicas <= 1) return null;
	return (
		`AUTTER_INGESTER_REPLICAS=${replicas} but AUTTER_REDIS_URL is not set: rate limits, the unknown-key budget ` +
		`and log promotion lookups are counted in each process, each enforcing 1/${replicas} of every limit. ` +
		`That holds only while the load balancer spreads each tenant evenly; set AUTTER_REDIS_URL to share them.`
	);
}
