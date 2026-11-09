import express, {
	type Express,
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { extractKeyWithSource, KeyResolver, redactKeyFromUrl } from "./auth.js";
import {
	clientAddress,
	connectRedis,
	type LimitStore,
	MemoryLimitStore,
	RateLimits,
	RedisLimitStore,
	retryAfterSeconds,
	WINDOW_MS,
} from "./limits.js";
import { countTruncations } from "./context.js";
import {
	autterKeyHash,
	caughtLimitedRecords,
	cumulativeHttpHistogramPoints,
	dataPointsInRequest,
	dropRoute,
	IngestDropCounter,
	PARTIAL_MESSAGES,
	partialSuccess,
	recordsInBody,
	spansInRequest,
	type DropReason,
	type PartialSuccess,
} from "./ingest-drops.js";
import { ClickHouseStore, routeLatencyPoints } from "./clickhouse.js";
import { normalizeLatencyHistograms } from "./latency.js";
import { isLocalAddress, LOCAL_DEV_KEY, UPLOAD_KEY_PREFIX, type IngesterConfig } from "./config.js";
import { deriveFields, occurrenceIdFor } from "./fingerprint.js";
import { causeTexts, type CauseText } from "./cause-chain.js";
import { occurrenceIdentity, type CauseLink } from "./fingerprint-v3.js";
import { parseStackFrames } from "./stack-frames.js";
import { SourceMapCache, Symbolicator } from "./symbolicate.js";
import {
	logPromotionCandidates,
	promotionLookups,
	logRollups,
} from "./log-promotion.js";
import {
	normalizeBrowserPayload,
	parseBrowserPayload,
} from "./normalize-browser.js";
import {
	normalizeMetrics,
	normalizeTraces,
	type OtlpMetricsRequest,
	type OtlpTraceRequest,
} from "./normalize-otlp.js";
import { decodeMetricsRequest, decodeTraceRequest, decodeLogsRequest, encodeExportResponse } from "./otlp-proto.js";
import { DeliveryLog, deliveryKeyHash, ingestSummaryHeader, verifyIdOf } from "./delivery.js";

/** Response header naming what an accepted ingest request stored. */
export const INGEST_SUMMARY_HEADER = "x-autter-ingest";
import { MAX_LOG_RECORDS_PER_REQUEST, normalizeLogs, type OtlpLogsRequest } from "./logs.js";
import { decodeProfile } from "./profiles.js";
import {
	MAX_MEMORY_SAMPLES_PER_REQUEST,
	normalizeMemoryMetrics,
	normalizePlatformEvent,
	platformEventSchema,
} from "./memory.js";
import { SOURCE_MAP_MAX_BODY_BYTES, validateSourceMap, validateSourceMapCheck } from "./source-maps.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { SinkForwarder } from "./sink.js";
import { OutboxLockedError, SinkOutbox, type OutboxRecord } from "./sink-outbox.js";
import {
	CachedProbe,
	retryable,
	stateFor,
	WRITE_FAILURE_WINDOW_MS,
	type StorageState,
} from "./health.js";
import { InsertReceipts, requestDigest } from "./insert-receipts.js";
import type { SinkDeadLetterRow } from "./sink-dead-letters.js";
import { LoopCollapser } from "./loop-collapse.js";
import { applySuppression } from "./suppression.js";
import { configureRedaction, scrubOccurrence } from "./redact.js";
import {
	buildCompatReport,
	evaluateCompat,
	INGESTER_VERSION_HEADER,
} from "./compat.js";
import { MIGRATIONS } from "./migrations.js";
import {
	archiveSchedulerMode,
	LocalArchiveLease,
	RedisArchiveLease,
	RuntimeArchiver,
} from "./archive.js";
import {
	BROWSER_SDK_NAME,
	ingesterVersion,
	SdkVersionTracker,
	sdkSightingsFromOtlp,
	telemetryVia,
	type OtlpResourceRequest,
} from "./sdk-versions.js";
import type {
	IngestContext,
	RuntimeOccurrence,
	RuntimeOccurrenceInput,
	StackFrame,
} from "./types.js";

export interface IngesterApp {
	app: Express;
	store: ClickHouseStore;
	/** Present when AUTTER_SINK_URL is configured. */
	sink: SinkForwarder | null;
	/** Record this ingester's version + schema level in ClickHouse (for the
	 * Autter dashboard). Called after the boot schema warm-up; throttled. */
	reportIngesterInfo: () => Promise<void>;
	/** Rejection and drop counts per tenant (runtime_ingest_drops); `stop()` writes what is buffered. */
	drops: IngestDropCounter;
	/** Loop collapse (1.9.0): `stop()` stores every window's sample (call it before `drops.stop()`). */
	collapse: LoopCollapser;
	/** Tenant limits and the unknown-key budget (1.12.0); `close()` disconnects Redis. */
	limits: RateLimits;
	keys: KeyResolver;
	/**
	 * The archive job (archive.ts) when an archive is configured and this
	 * process may run it (Redis lease, or the only replica); null otherwise.
	 * Not started here: index.ts starts it after the schema warm-up.
	 */
	archiver: RuntimeArchiver | null;
}

export interface IngesterDeps {
	/**
	 * The shared limit store. Default: Redis at `config.redisUrl` when set,
	 * else none (each process counts alone). Tests pass their own.
	 */
	sharedLimits?: LimitStore | null;
}

/** The only routes an upload key (`autter_rtu_…`, scope "upload") may call. */
export const UPLOAD_KEY_ROUTES = ["/v1/sourcemaps", "/v1/sourcemaps/check"] as const;

/** The 403 an upload key gets on every other authenticated route. */
export const UPLOAD_KEY_NOT_ALLOWED = {
	error: "upload_key_not_allowed",
	detail:
		"autter_rtu_ keys can only upload source maps (POST /v1/sourcemaps and /v1/sourcemaps/check); " +
		"telemetry needs a server key (autter_rt_…), or a client key (autter_rtc_…) for /v1/browser",
} as const;

/**
 * The 401 a server or upload key gets in `?key=`. A URL is written to
 * proxy, CDN and access logs, so only publishable client keys may travel
 * there (navigator.sendBeacon cannot set headers).
 */
export const KEY_IN_URL = {
	error: "key_in_url",
	detail:
		"Only publishable client keys (autter_rtc_…) may be sent in the ?key= query parameter. " +
		"Send server and upload keys in the Authorization: Bearer header (or x-autter-key). " +
		"This key has been in a URL, which proxies and CDNs log: rotate it.",
} as const;

/** Prefix of secret server keys (`autter_rt_…`; `autter_rtc_` and `autter_rtu_` do not match). */
const SERVER_KEY_PREFIX = "autter_rt_";

/** Why a client key's request was refused for its Origin. */
function originRefusal(allowedOrigins: string[], origin: string | undefined) {
	return {
		error: "origin not allowed for this key",
		detail:
			allowedOrigins.length === 0
				? "This client key has no allowed origins, so it accepts no browser origin. " +
					"Add your site's exact origins (e.g. https://app.example.com, or http://localhost:3000 for local development) to the key."
				: origin
					? `Origin ${origin.slice(0, 200)} is not in this client key's allowed origins.`
					: "Client keys need an Origin header from one of the key's allowed origins.",
	};
}

/** What an authenticated route accepts: "otlp" (server keys), "browser"
 * (server and client keys), "sourcemaps" (server and upload keys). */
type Surface = "otlp" | "browser" | "sourcemaps";

/** The OTLP export routes, which take JSON or protobuf and answer with a partial success. */
type OtlpSignal = "traces" | "logs" | "metrics";

/** Express 4 drops a rejected handler promise: hand it to the error handler instead of crashing the process. */
function asyncRoute(
	handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
	return (req, res, next) => {
		handler(req, res, next).catch(next);
	};
}

/** Spans one traces request may carry (normalizeTraces' MAX_SPANS_PER_REQUEST). */
const SPANS_PER_REQUEST = 5000;

/** Re-report the ingester version at most this often (keeps the row inside
 * its TTL for long-running ingesters). */
const INGESTER_INFO_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createIngesterApp(config: IngesterConfig, deps: IngesterDeps = {}): IngesterApp {
	configureRedaction(config);
	const store = new ClickHouseStore(config);
	// Browser, Node and edge JS frames are resolved through uploaded source
	// maps before they are fingerprinted (frames-v3), with parsed maps cached
	// per release+file.
	const symbolicator = new Symbolicator(
		(key) => store.lookupSourceMap(key),
		new SourceMapCache({ maxBytes: (config.sourceMapCacheMb ?? 64) * 1024 * 1024 }),
	);
	// Fingerprinted occurrences feed the consumer's issue grouping, metric
	// points feed the request/error-rate rollups, LLM calls feed spend
	// watching. Delivery is at-least-once, through an on-disk outbox that
	// survives restarts when SINK_OUTBOX_DIR is set — see sink.ts.
	const sink = config.sinkUrl ? new SinkForwarder(config, fetch, {}, openOutbox(config)) : null;
	/** Names this process in runtime_ingester_heartbeat and dead letters. */
	const instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
	const keys = new KeyResolver(config);
	// Tenant request and record limits, the unknown-key budget and log
	// promotion lookups (limits.ts): shared through Redis when configured,
	// else per process with each limit divided by AUTTER_INGESTER_REPLICAS.
	// One Redis connection (AUTTER_REDIS_URL) for shared limits and shared
	// insert receipts; tests that pass their own limit store get neither.
	const redis = deps.sharedLimits === undefined && config.redisUrl ? connectRedis(config.redisUrl) : null;
	const limits = new RateLimits({
		shared:
			deps.sharedLimits !== undefined
				? deps.sharedLimits
				: redis
					? new RedisLimitStore(redis)
					: null,
		replicas: config.replicas ?? 1,
	});
	// The per-IP request limit: always this process's own count (it runs on
	// every POST before the body is read and must never wait on Redis).
	const addressLimiter = new MemoryLimitStore(100_000);
	const ipRateLimit = config.ipRateLimitPerMinute ?? 6_000;
	const ipUnknownKeyLookups = config.ipUnknownKeyLookupsPerMinute ?? 30;
	const unknownKeyLookups = config.unknownKeyLookupsPerMinute ?? 600;
	const recordLimit = config.recordLimitPerMinute ?? 600_000;
	const clientRecordLimit = config.clientRecordLimitPerMinute ?? 6_000;
	// ClickHouse dedupe lookups made by /v1/logs promotion, per tenant. Far
	// tighter than the request limit: each lookup is a query, not an insert.
	const promotionLookupLimit = config.promotionLookupsPerMinute ?? 30;
	const version = ingesterVersion();
	const sdkVersions = new SdkVersionTracker((ctx, rows) => store.insertSdkVersions(ctx, rows));
	// What was refused or not stored, per tenant and minute (EI-27). Written
	// in batches every few seconds, bounded, never retried: it can't slow
	// or fail ingest. Without ClickHouse there is nowhere to count.
	const drops = new IngestDropCounter((rows) => store.insertIngestDrops(rows), { enabled: store.configured });
	drops.start();
	if (sink) {
		sink.onDrop = (drop) => {
			drops.record({
				tenant: { orgId: drop.orgId, repositoryId: drop.repositoryId },
				route: "sink",
				reason: drop.reason,
				records: drop.occurrences,
			});
			// The batch's range, so a consumer knows what to replay. Written
			// right away (dead letters are rare); a failed write is logged and
			// the batch is still on disk under the outbox's dead/ directory.
			const row: SinkDeadLetterRow = { ...drop, instanceId, file: drop.file ?? "" };
			store.insertSinkDeadLetters([row]).catch((err: unknown) => {
				console.warn(
					`sink dead letter ${drop.batchId} not recorded in ClickHouse:`,
					err instanceof Error ? err.message : err,
				);
			});
		};
	}
	// Readiness (health.ts): a cached probe that writes a heartbeat row the
	// way ingest writes, plus the outcome of real ingest writes.
	const readiness = new CachedProbe(() => store.probe(instanceId, version));
	store.onWriteStateChange = () => readiness.invalidate();
	const receipts = new InsertReceipts({ file: config.insertReceiptsFile ?? null, redis });
	// Loop collapse (1.9.0, loop-collapse.ts): a looping error past its first
	// LOOP_COLLAPSE_AFTER occurrences of the minute is stored as one sample a
	// minute with an exact count. The minute's samples are written here, then
	// forwarded; a failed write is kept and retried by the collapser.
	const collapse = new LoopCollapser(
		async (ctx, samples) => {
			const occurrences = samples.map((entry) => entry.sample);
			await store.insertOccurrences(ctx, occurrences);
			sink?.enqueue(ctx, occurrences);
			for (const entry of samples) {
				// Payloads not stored: every folded occurrence but the sample itself.
				if (entry.folded > 1) {
					drops.record({ tenant: ctx, route: entry.route, reason: "collapsed", requests: 0, records: entry.folded - 1 });
				}
			}
		},
		{ after: config.loopCollapseAfter ?? 10 },
	);
	if (store.configured) collapse.start();

	/**
	 * Volume control on a request's fingerprinted occurrences (1.9.0): the
	 * tenant's suppression rules first, then loop collapse. `kept` is what to
	 * store and forward now. `commit()` once the request's writes succeeded
	 * (folds and suppressions are counted then), `rollback()` when they
	 * failed (the exporter retries, and must find the same windows).
	 */
	function admit(ctx: IngestContext, req: Request, occurrences: RuntimeOccurrence[]) {
		const route = dropRoute(req.path);
		const { kept, suppressed } = applySuppression(occurrences, ctx.suppression);
		const plan = collapse.plan(ctx, route, kept);
		return {
			kept: plan.kept,
			suppressed,
			collapsed: Math.max(0, kept.length - plan.kept.length),
			commit(): void {
				plan.commit();
				if (suppressed > 0) drops.record({ tenant: ctx, route, reason: "suppressed", requests: 0, records: suppressed });
			},
			rollback(): void {
				plan.rollback();
			},
		};
	}

	/** Volume control off: a `verify` request keeps every occurrence. */
	function admitAll(occurrences: RuntimeOccurrence[]) {
		return { kept: occurrences, suppressed: 0, collapsed: 0, commit(): void {}, rollback(): void {} };
	}

	const allMigrationIds = MIGRATIONS.map((migration) => migration.id);
	const compatReport = () => {
		const schema = store.schemaStatus();
		return buildCompatReport({
			version,
			schemaStatus: schema.status,
			applied: schema.applied,
			allMigrations: allMigrationIds,
		});
	};
	let lastInfoReport = 0;
	async function reportIngesterInfo(): Promise<void> {
		if (!store.configured) return;
		if (Date.now() - lastInfoReport < INGESTER_INFO_INTERVAL_MS) return;
		lastInfoReport = Date.now();
		try {
			// Only reached from boot and authenticated ingest, which run the
			// (memoized) schema bootstrap anyway.
			await store.ensureSchema();
			const report = compatReport();
			await store.insertIngesterInfo({ version, schemaLevel: report.schema.level, report });
		} catch (err) {
			// Retry in a minute, not on every request.
			lastInfoReport = Date.now() - INGESTER_INFO_INTERVAL_MS + 60_000;
			console.warn("ingester info report failed:", (err as Error)?.message ?? err);
		}
	}
	/** Fire-and-forget after a successful ingest: never delays or fails it. */
	function recordSdks(ctx: IngestContext, request: unknown, req: Request): void {
		void sdkVersions.observe(
			ctx,
			sdkSightingsFromOtlp(request as OtlpResourceRequest, { userAgent: req.headers["user-agent"] ?? null }),
		);
		void reportIngesterInfo();
	}

	/**
	 * Answer a refusal and count it. The response is written first; then the
	 * records in the body are counted (a walk of the parsed JSON, or a
	 * wire-format scan of protobuf: never a decode).
	 */
	function refuse(
		req: Request,
		res: Response,
		who: IngestContext | { keyHash: string } | null,
		reason: DropReason,
		status: number,
		body: unknown,
		records?: number,
	): void {
		res.locals.dropReason = reason;
		res.locals.dropError = (body as { error?: unknown } | null)?.error;
		res.status(status).json(body);
		const route = dropRoute(req.path);
		drops.record({
			tenant: who && "orgId" in who ? who : null,
			...(who && "keyHash" in who ? { keyHash: who.keyHash } : {}),
			route,
			reason,
			status,
			records: records ?? recordsInBody(route, req.body, Boolean(req.is("application/x-protobuf"))),
		});
	}

	/**
	 * Who sent a request, from what is already known about its key (static
	 * or cached; see KeyResolver.peek): never a validator call. Refusals made
	 * before a key is resolved (unknown routes, unparseable bodies, the wrong
	 * content type) are attributed with it, so they cost the validator nothing.
	 */
	function knownSender(req: Request): IngestContext | { keyHash: string } | null {
		const key = keys.extractKey(req);
		if (!key) return null;
		return keys.peek(key) ?? { keyHash: autterKeyHash(key) };
	}

	/** Count a refusal made before any route ran (body-parser errors, unknown routes). Never throws. */
	function countUnrouted(req: Request, reason: DropReason, status: number): void {
		if (!store.configured) return;
		const route = dropRoute(req.path);
		const records = recordsInBody(route, req.body, Boolean(req.is("application/x-protobuf")));
		const who = knownSender(req);
		drops.record({
			tenant: who && "orgId" in who ? who : null,
			...(who && "keyHash" in who ? { keyHash: who.keyHash } : {}),
			route,
			reason,
			status,
			records,
		});
	}

	/**
	 * The unknown-key budget, spent only when a key in neither key cache is
	 * about to go to the validator: per client address, then for the whole
	 * ingester (both shared when Redis is configured). A refused key gets 429.
	 */
	function unknownKeyGate(req: Request, retry: { ms: number }): () => Promise<boolean> {
		return async () => {
			const perAddress = await limits.take([
				{ key: `{addr:${clientAddress(req)}}:unknown-keys`, cost: 1, limit: ipUnknownKeyLookups },
			]);
			if (!perAddress.allowed) {
				retry.ms = perAddress.retryAfterMs;
				return false;
			}
			const overall = await limits.take([{ key: "{all}:unknown-keys", cost: 1, limit: unknownKeyLookups }]);
			if (!overall.allowed) {
				retry.ms = overall.retryAfterMs;
				return false;
			}
			return true;
		};
	}

	/**
	 * The tenant's request and record limits (sliding windows, limits.ts).
	 * Client keys have their own, tighter pair; upload keys count apart from
	 * telemetry with the server limits, so a CI upload can't starve ingest.
	 */
	async function withinTenantLimits(req: Request, res: Response, ctx: IngestContext): Promise<boolean> {
		const client = ctx.scope === "client";
		const tenant = `{${ctx.scope}:${ctx.orgId}:${ctx.repositoryId}}`;
		const records = Math.max(1, recordsInBody(dropRoute(req.path), req.body, Boolean(req.is("application/x-protobuf"))));
		const decision = await limits.take([
			{ key: `${tenant}:requests`, cost: 1, limit: client ? config.clientRateLimitPerMinute : config.rateLimitPerMinute },
			{ key: `${tenant}:records`, cost: records, limit: client ? clientRecordLimit : recordLimit },
		]);
		if (decision.allowed) return true;
		res.setHeader("retry-after", retryAfterSeconds(decision.retryAfterMs));
		refuse(req, res, ctx, "rate_limited", 429, { error: "rate limit exceeded" }, records);
		return false;
	}

	const app = express();
	app.disable("x-powered-by");
	const delivery = new DeliveryLog();
	// The client address per-IP limits count against: X-Forwarded-For from
	// this many trusted proxy hops (TRUST_PROXY, default 1).
	app.set("trust proxy", config.trustProxy ?? 1);
	// Every response names the ingester version, so SDKs (and the browser
	// relay) learn it for free from responses they already receive.
	app.use((req, res, next) => {
		res.setHeader(INGESTER_VERSION_HEADER, version);
		// `?key=` stays readable in req.query (already parsed) but is masked
		// in the URL, so nothing that logs req.url / req.originalUrl can
		// write a key into the ingester's logs.
		const url = redactKeyFromUrl(req.url);
		if (url !== req.url) {
			req.url = url;
			req.originalUrl = redactKeyFromUrl(req.originalUrl);
		}
		next();
	});
	// The last accepted / refused request per key (delivery.ts), read back
	// by its holder through GET /v1/verify. Hashed here, recorded when the
	// response is finished, whatever answered it.
	app.use((req, res, next) => {
		if (req.method === "POST") {
			const key = keys.extractKey(req);
			if (key) {
				const keyHash = deliveryKeyHash(key);
				res.on("finish", () => {
					const route = req.path;
					if (res.statusCode < 300) {
						delivery.accepted(keyHash, {
							route,
							status: res.statusCode,
							...(res.locals.ingestSummary ? { accepted: res.locals.ingestSummary as Record<string, number> } : {}),
						});
					} else if (res.statusCode >= 400) {
						delivery.rejected(keyHash, {
							route,
							status: res.statusCode,
							reason: typeof res.locals.dropReason === "string" ? res.locals.dropReason : `http_${res.statusCode}`,
							...(typeof res.locals.dropError === "string" ? { error: res.locals.dropError } : {}),
						});
					}
				});
			}
		}
		next();
	});
	// Per-address request limit (1.12.0), before any body is read or key
	// looked at: one address can't make the ingester parse, resolve keys or
	// count drops faster than this, whatever keys and paths it sends.
	app.use((req, res, next) => {
		if (req.method !== "POST" || ipRateLimit <= 0) {
			next();
			return;
		}
		const decision = addressLimiter.takeSync([{ key: clientAddress(req), cost: 1, limit: ipRateLimit }]);
		if (decision.allowed) {
			next();
			return;
		}
		res.setHeader("retry-after", retryAfterSeconds(decision.retryAfterMs));
		res.status(429).json({ error: "too many requests from this address" });
		if (store.configured) {
			// The body is not read: nothing to count but the request.
			drops.record({ tenant: null, route: dropRoute(req.path), reason: "rate_limited", status: 429, records: 0 });
		}
	});
	app.use(express.raw({ limit: "1mb", type: ["application/x-pprof"] }));
	// A check names at most 500 maps: well under 1 MB, whatever MAX_BODY_BYTES is.
	app.use("/v1/sourcemaps/check", express.json({ limit: "1mb" }));
	// Source map uploads (up to 32 MiB of JSON, usually gzipped) are routed
	// before the small-body parsers below, and read their body only once the
	// key is checked: an anonymous client can't make the ingester inflate and
	// parse one. body-parser inflates gzip/deflate and applies the limit to
	// the inflated bytes, so a small compressed body can't expand past it.
	const sourceMapBody = express.json({ limit: SOURCE_MAP_MAX_BODY_BYTES });
	app.post("/v1/sourcemaps", asyncRoute(async (req, res, next) => {
		// On failure the body is never read (Node discards it).
		const ctx = await authenticate(req, res, "sourcemaps");
		if (!ctx) return;
		sourceMapBody(req, res, (err?: unknown) => {
			if (err) {
				// 413 / bad JSON: the error handler answers and counts it.
				next(err);
				return;
			}
			void (async () => {
				const sourceMap = validateSourceMap(req.body);
				if (!sourceMap) {
					refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid source map" });
					return;
				}
				// Idempotent: the same release + path replaces the earlier row
				// (ReplacingMergeTree), so CI retries and re-runs are harmless.
				try {
					await store.insertSourceMap(ctx, sourceMap);
				} catch (storeErr) {
					storageError(req, res, ctx, storeErr);
					return;
				}
				res.status(202).json({ accepted: true });
			})().catch(next);
		});
	}));
	app.use(
		express.json({
			limit: config.maxBodyBytes,
			type: ["application/json"],
		}),
	);
	// Cross-origin sendBeacon can only send CORS-safelisted content types
	// without a preflight, so direct-from-browser payloads arrive as
	// text/plain and are parsed in the /v1/browser handler.
	app.use(
		express.text({
			limit: config.maxBodyBytes,
			type: ["text/plain"],
		}),
	);
	// OTLP protobuf — the default wire format of most OTel SDKs (Go, Rust,
	// Python, Java, .NET, JS proto exporters). body-parser inflates
	// gzip/deflate request bodies automatically for all three parsers.
	app.use(
		express.raw({
			limit: config.maxBodyBytes,
			type: ["application/x-protobuf"],
		}),
	);

	// CORS for direct browser ingest (publishable client keys). Auth and the
	// per-key origin allow-list are enforced at POST time; the CORS response
	// itself is permissive so preflights never need key knowledge.
	app.use("/v1/browser", (req, res, next) => {
		res.setHeader("access-control-allow-origin", "*");
		res.setHeader("access-control-allow-methods", "POST, OPTIONS");
		res.setHeader(
			"access-control-allow-headers",
			"content-type, authorization, x-autter-key",
		);
		// retry-after: a browser reads it on a 503 (key not checkable right now) or 429.
		res.setHeader("access-control-expose-headers", `${INGESTER_VERSION_HEADER}, ${INGEST_SUMMARY_HEADER}, retry-after`);
		res.setHeader("access-control-max-age", "86400");
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}
		next();
	});

	/**
	 * Readiness (1.12): 200 only when this ingester can store what it is
	 * sent. The probe makes sure the schema exists and inserts a heartbeat
	 * row with the configured credentials (cached for a few seconds, shared
	 * by concurrent callers), and a failed real ingest write in the last
	 * minute also makes it unready — so a wrong password, a dropped table or
	 * a missing grant answer 503 here, as ingest does. `clickhouse` says
	 * which: `up`, `down` (retry), `auth_failed` or `schema_missing` (fix
	 * the deployment), `unconfigured`. Counters only (no tenant data):
	 * /healthz is public. Liveness without storage is /livez.
	 */
	app.get("/healthz", async (_req, res) => {
		const report = await readinessReport();
		if (!report.ok && report.retryable) res.setHeader("retry-after", "5");
		res.setHeader("cache-control", "no-store");
		res.status(report.ok ? 200 : 503).json(report);
	});

	/** Liveness: the process is up and serving. For container restart
	 * policies, which must not restart the ingester for a storage outage. */
	app.get("/livez", (_req, res) => {
		res.setHeader("cache-control", "no-store");
		res.status(200).json({ ok: true, version });
	});

	/** Prometheus text: drop, sink and write counters (no tenant data). */
	app.get("/metrics", async (_req, res) => {
		const report = await readinessReport();
		res.setHeader("cache-control", "no-store");
		res.type("text/plain; version=0.0.4").send(prometheusText(report));
	});

	async function readinessReport() {
		const probe = await readiness.get();
		const writes = store.writes.stats(WRITE_FAILURE_WINDOW_MS);
		let state: StorageState = probe.state;
		// The probe passing does not clear real writes that keep failing (a
		// table the probe does not touch, a grant on one table).
		if (state === "up" && store.writes.failing(WRITE_FAILURE_WINDOW_MS)) {
			state = stateFor(store.writes.lastCategoryOrNull(WRITE_FAILURE_WINDOW_MS) ?? "error");
		}
		const ok = state === "up";
		const dropTotals = drops.totals();
		return {
			ok,
			status: ok ? "ready" : "unready",
			clickhouse: state,
			/** Will this clear on its own (retry later), or does the deployment need a fix? */
			retryable: !ok && retryable(state),
			checkedAt: probe.checkedAt,
			probeLatencyMs: probe.latencyMs,
			clickhouseVersion: store.serverVersion,
			// How a retried request is kept from writing rows twice: the
			// receipts (memory, journal file, Redis) — see insert-receipts.ts.
			insertReceipts: receipts.stats(),
			writes,
			drops: {
				// Since this process started, kept in memory: readable while
				// ClickHouse (where the per-minute rows go) is down.
				requests: dropTotals.reduce((sum, t) => sum + t.requests, 0),
				records: dropTotals.reduce((sum, t) => sum + t.records, 0),
				byReason: dropTotals,
				writer: drops.stats(),
			},
			...(sink ? { sink: sink.stats() } : {}),
			...(collapse.enabled ? { collapse: collapse.stats() } : {}),
		};
	}

	/**
	 * Fan-out writes of one ingest request, idempotent across retries: each
	 * insert carries `<request digest>:<table>` as its ClickHouse dedupe
	 * token, and tables this process already wrote for the same request
	 * are skipped (insert-receipts.ts). A request with nothing to write
	 * still has to find storage writable — an empty export must not get a
	 * 2xx from an ingester that cannot store anything. Throws on failure.
	 */
	async function writeAll(
		digest: string,
		writes: Array<{ table: string; rows: number; run: (token: string) => Promise<void> }>,
	): Promise<void> {
		const pending = writes.filter((write) => write.rows > 0);
		if (pending.length === 0) {
			await requireWritable();
			return;
		}
		await receipts.coalesce(digest, async () => {
			const done = await receipts.committed(digest, pending.map((write) => write.table));
			// allSettled, not all: when one insert is refused at once (a
			// privilege, a missing table) its siblings are still in flight —
			// an async insert is acknowledged only after its buffer flushes.
			// Answering 503 before they settle would let the exporter's retry
			// overtake them, find no receipt and write those rows twice.
			const results = await Promise.allSettled(
				pending
					.filter((write) => !done.has(write.table))
					.map(async (write) => {
						await write.run(digest);
						await receipts.add(digest, write.table);
					}),
			);
			const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
			if (failed) throw failed.reason;
		});
	}

	/** Throw unless storage can take writes (cached readiness). */
	async function requireWritable(): Promise<void> {
		if (store.writes.failing(WRITE_FAILURE_WINDOW_MS)) {
			throw new Error(`storage is failing writes (${store.writes.lastCategoryOrNull(WRITE_FAILURE_WINDOW_MS) ?? "error"})`);
		}
		const probe = await readiness.get();
		if (probe.state !== "up") throw new Error(`storage not writable (${probe.state})`);
	}

	/**
	 * Version compatibility (public, like /healthz; no tenant data): this
	 * ingester's version, its ClickHouse schema level, and every feature in
	 * the compat manifest with whether it is available here. Optional
	 * `?features=a,b&sdk=<name>@<version>` adds the evaluated `issues`.
	 * Never triggers schema DDL.
	 */
	app.get("/v1/compat", (req, res) => {
		const report = compatReport();
		const features =
			typeof req.query.features === "string"
				? req.query.features.split(",").map((f) => f.trim()).filter(Boolean).slice(0, 50)
				: [];
		const sdkParam = typeof req.query.sdk === "string" ? req.query.sdk.slice(0, 120) : "";
		const at = sdkParam.lastIndexOf("@");
		const sdk = at > 0 ? { name: sdkParam.slice(0, at), version: sdkParam.slice(at + 1) } : null;
		const body =
			features.length || sdk
				? {
						...report,
						issues: evaluateCompat({
							features: features.length
								? features
								: report.features.filter((f) => sdk && f.sdks[sdk.name]).map((f) => f.id),
							ingester: { version, schema: { status: report.schema.status, applied: report.schema.applied } },
							sdk,
						}),
					}
				: report;
		res.setHeader("cache-control", "no-store");
		res.status(200).json(body);
	});

	/**
	 * Auth + scope + rate limit; returns null (response sent) on failure.
	 * Server keys pass everywhere; client keys only on "browser"; upload
	 * keys only on "sourcemaps". A new route that passes "otlp" is closed to
	 * client and upload keys without further changes.
	 */
	async function authenticate(
		req: Request,
		res: Response,
		surface: Surface,
	): Promise<IngestContext | null> {
		// A storage-less ingester must refuse, not accept-and-drop: exporters
		// retry on 503, so telemetry survives a misconfigured deploy. Not
		// counted: without ClickHouse there is nowhere to count it.
		if (!store.configured) {
			res.status(503).json({ error: "storage not configured" });
			return null;
		}
		const extracted = extractKeyWithSource(req);
		if (!extracted) {
			refuse(req, res, null, "missing_key", 401, { error: "missing ingest key" });
			return null;
		}
		const { key, source } = extracted;
		// A secret key in the URL: refused on its prefix, before any lookup.
		if (source === "query" && (key.startsWith(SERVER_KEY_PREFIX) || key.startsWith(UPLOAD_KEY_PREFIX))) {
			refuse(req, res, { keyHash: autterKeyHash(key) }, "key_in_url", 401, KEY_IN_URL);
			return null;
		}
		const retry = { ms: WINDOW_MS };
		const resolution = await keys.resolveDetailed(key, unknownKeyGate(req, retry));
		const ctx = resolution.ctx;
		if (!ctx) {
			// No tenant: counted against the null tenant, with the key's hash
			// when it is an Autter key (ingest-drops.ts autterKeyHash).
			if (resolution.failure === "lookup_limited") {
				// Not verified, not refused: the exporter retries after this.
				res.setHeader("retry-after", retryAfterSeconds(retry.ms));
				refuse(req, res, { keyHash: autterKeyHash(key) }, "rate_limited", 429, { error: "too many unrecognised keys, retry later" });
				return null;
			}
			if (resolution.failure === "key_unverified") {
				// The validator could not answer and nothing recent enough is
				// cached. Exporters drop a batch for good on 401 but retry a
				// 503, so a validator outage must not look like a bad key.
				res.setHeader("retry-after", String(resolution.retryAfterSeconds));
				refuse(req, res, { keyHash: autterKeyHash(key) }, "key_unverified", 503, {
					error: "ingest key could not be checked right now, retry later",
				});
				return null;
			}
			refuse(req, res, { keyHash: autterKeyHash(key) }, "unknown_key", 401, { error: "invalid ingest key" });
			return null;
		}
		// The built-in local key (local dev mode only, see config.ts): from
		// this machine or a Docker bridge, never from another network. The
		// socket address, not X-Forwarded-For, which a caller can write.
		if (key === LOCAL_DEV_KEY && !isLocalAddress(req.socket.remoteAddress)) {
			refuse(req, res, ctx, "unknown_key", 401, {
				error: `${LOCAL_DEV_KEY} is accepted only from this machine — use a real ingest key`,
			});
			return null;
		}
		// Any key without an Autter prefix (self-host static keys) is judged
		// on its resolved scope: only client keys may come in the URL.
		if (source === "query" && ctx.scope !== "client") {
			refuse(req, res, ctx, "key_in_url", 401, KEY_IN_URL);
			return null;
		}
		if (ctx.scope === "upload") {
			// CI keys: source map upload and check only. Server rate window
			// (each key has its own).
			if (surface !== "sourcemaps") {
				refuse(req, res, ctx, "upload_key_not_allowed", 403, UPLOAD_KEY_NOT_ALLOWED);
				return null;
			}
		} else if (ctx.scope === "client") {
			// Publishable keys: browser surface only, origin allow-list, and
			// the tighter rate window.
			if (surface !== "browser") {
				refuse(req, res, ctx, "client_key_not_allowed", 403, {
					error:
						surface === "sourcemaps"
							? "client keys cannot upload source maps — use an upload key (autter_rtu_…) or a server key"
							: "client keys cannot send OTLP — use a server key",
				});
				return null;
			}
			// Exact match only. A key with no allowed origins accepts none: a
			// publishable key is public, so "any origin" would let every site
			// send as this repository.
			const origin = req.headers.origin;
			if (!origin || !ctx.allowedOrigins.includes(origin)) {
				refuse(req, res, ctx, "origin_not_allowed", 403, originRefusal(ctx.allowedOrigins, origin));
				return null;
			}
			return (await withinTenantLimits(req, res, ctx)) ? ctx : null;
		} else if (ctx.scope !== "server") {
			// KeyResolver never yields another scope; refuse rather than
			// treat an unknown one as a server key.
			refuse(req, res, ctx, "key_scope_not_allowed", 403, { error: "key scope not allowed" });
			return null;
		}
		return (await withinTenantLimits(req, res, ctx)) ? ctx : null;
	}

	/** A stack's frames, innermost first; none when it does not parse. */
	function parsedFrames(stack: string | null | undefined): StackFrame[] {
		try {
			return parseStackFrames(stack);
		} catch (err) {
			console.warn("stack parse failed — no frames:", err instanceof Error ? err.message : err);
			return [];
		}
	}

	/**
	 * Frames resolved through the release's source maps: minified browser
	 * bundles, and bundled Node and edge code (RF-05: tsup, esbuild, webpack
	 * and Next.js server output) — only JS frames a map was uploaded for
	 * change. Never fails ingest (it falls back to the parsed frames).
	 */
	function symbolicated(
		ctx: IngestContext,
		input: RuntimeOccurrenceInput,
		frames: StackFrame[],
	): Promise<StackFrame[]> {
		if (frames.length === 0) return Promise.resolve(frames);
		return symbolicator.symbolicate(frames, {
			orgId: ctx.orgId,
			repositoryId: ctx.repositoryId,
			release: input.release,
			debugIds: input.debugIds ?? null,
			server: input.source !== "browser",
		});
	}

	/**
	 * Structured frames for the frames-v3 identity and the platform's stack
	 * view: parsed innermost-first, then resolved through the release's
	 * source maps, with context lines on in-app frames when the map carries
	 * their source.
	 */
	function framesFor(
		ctx: IngestContext,
		input: RuntimeOccurrenceInput,
	): Promise<StackFrame[]> {
		return symbolicated(ctx, input, parsedFrames(input.stack));
	}

	/**
	 * The reported exception's causes, nearest first, with their frames
	 * resolved like the reported one's (RF-06: the cause-v1 identity hashes
	 * the root cause's innermost in-app frame, which must read the same as
	 * when that error is reported unwrapped). Only used for the identity:
	 * cause frames are not stored.
	 */
	async function causesFor(
		ctx: IngestContext,
		input: RuntimeOccurrenceInput,
	): Promise<CauseLink[]> {
		let causes: CauseText[];
		try {
			causes = causeTexts(input.stack, input.attributes);
		} catch (err) {
			console.warn("cause chain parse failed — no causes:", err instanceof Error ? err.message : err);
			return [];
		}
		return Promise.all(
			causes.map(async (cause) => ({
				type: cause.type,
				frames: await symbolicated(ctx, input, parsedFrames(cause.stack)),
			})),
		);
	}

	/** Ids are content-derived (occurrenceIdFor), NOT random: an exporter
	 * that retries a batch — after a 503 from a partially-failed ClickHouse
	 * write, or when only our 2xx got lost — must produce the same ids, so
	 * the sink consumer's per-occurrence dedupe holds across transport
	 * retries and duplicated ClickHouse rows stay identifiable.
	 *
	 * `fingerprint` / `fingerprintScheme` stay the legacy identity
	 * (message-v1 or code-v1) byte-for-byte; `fingerprints` carries every
	 * candidate (manual-v1, code-v1, frames-v3, message-v1, cause-v1) for
	 * the platform to resolve the issue from.
	 *
	 * `batchIndexes` (traces): each occurrence's position among the batch's
	 * signals before the per-trace dedupe, so a merged occurrence keeps the
	 * id of the recording it kept and a drop never shifts another's id.
	 * Defaults to the position in `inputs`. */
	async function fingerprintAll(
		ctx: IngestContext,
		inputs: RuntimeOccurrenceInput[],
		batchIndexes?: number[],
	): Promise<RuntimeOccurrence[]> {
		return Promise.all(
			inputs.map(async (raw, index) => {
				// Second line of defence, before fingerprinting, storage, and the
				// sink (which feeds LLM fix generation): scrub secrets from the
				// free-text fields old SDKs and third-party OTLP senders pass
				// through verbatim. Attributes were already sanitised by the
				// normalisers (sanitizeRuntimeContext).
				const input = scrubOccurrence(raw);
				const [frames, causes] = await Promise.all([framesFor(ctx, input), causesFor(ctx, input)]);
				const identity = occurrenceIdentity(input, frames, causes);
				const { fingerprint, scheme } = identity.legacy;
				// Debug ids only locate source maps; they are not stored or forwarded.
				const { debugIds: _debugIds, ...stored } = input;
				return {
					...stored,
					occurrenceId: occurrenceIdFor(ctx, input, fingerprint, batchIndexes?.[index] ?? index),
					fingerprint,
					fingerprintScheme: scheme,
					...deriveFields(input),
					...(frames.length > 0 ? { frames } : {}),
					fingerprints: identity.candidates,
					...(identity.record ? { fingerprintRecord: identity.record } : {}),
				};
			}),
		);
	}

	/** Fingerprint log-promotion candidates and drop the ones whose trace
	 * already produced an occurrence (in this batch, or within ±60 s). Ids
	 * are assigned BEFORE the lookup so they stay stable across retries
	 * whatever the lookup returns. */
	async function promoteLogs(
		ctx: IngestContext,
		logs: ReturnType<typeof normalizeLogs>,
	): Promise<RuntimeOccurrence[]> {
		const candidates = logPromotionCandidates(logs);
		if (candidates.length === 0) return [];
		const fingerprinted = await fingerprintAll(ctx, candidates);
		const seen = new Set<string>();
		const ownIds = fingerprinted.map((o) => o.occurrenceId);
		for (const lookup of promotionLookups(candidates)) {
			const budget = await limits.take([
				{ key: `{server:${ctx.orgId}:${ctx.repositoryId}}:promotion-lookups`, cost: 1, limit: promotionLookupLimit },
			]);
			if (!budget.allowed) break;
			try {
				const found = await store.recentOccurrenceTraceIds(
					ctx,
					lookup.traceIds,
					lookup.from,
					lookup.to,
					ownIds,
				);
				for (const traceId of found) seen.add(traceId);
			} catch (err) {
				console.warn(
					"log promotion dedupe lookup failed — promoting without it:",
					err instanceof Error ? err.message : err,
				);
			}
		}
		return fingerprinted.filter((o) => !o.traceId || !seen.has(o.traceId));
	}

	function storageError(req: Request, res: Response, ctx: IngestContext, err: unknown, records?: number): void {
		console.error("clickhouse write failed:", err);
		refuse(req, res, ctx, "storage_unavailable", 503, { error: "storage unavailable, retry later" }, records);
	}

	/**
	 * OTLP/HTTP is JSON or protobuf; anything else gets a 415 (OTLP spec)
	 * instead of an empty success that stores nothing. A request with no
	 * body at all is an empty export, not a wrong type.
	 */
	function unsupportedOtlpBody(req: Request): boolean {
		const match = req.is(["application/json", "application/x-protobuf"]);
		return match === false && req.headers["content-length"] !== "0";
	}

	const UNSUPPORTED_OTLP = { error: "expected application/json or application/x-protobuf" } as const;

	/** Count what an accepted request did not store, or stored cut. */
	function countAccepted(
		ctx: IngestContext,
		req: Request,
		parts: Array<{ reason: DropReason; records: number }>,
	): void {
		const route = dropRoute(req.path);
		for (const part of parts) {
			if (part.records > 0) drops.record({ tenant: ctx, route, reason: part.reason, records: part.records });
		}
	}

	/**
	 * OTLP success responses mirror the request encoding: protobuf for proto
	 * clients (an empty message when everything was accepted), JSON
	 * otherwise. When some records were not stored, `partial_success` names
	 * how many and why (OTLP spec), so collectors and SDKs log it.
	 */
	function otlpSuccess(
		req: Request,
		res: Response,
		signal: OtlpSignal,
		partial: PartialSuccess | null,
		summary: Record<string, number> = {},
	): void {
		acceptedSummary(res, { ...summary, rejected: partial?.rejected ?? 0 });
		if (req.is("application/x-protobuf")) {
			res.status(200).type("application/x-protobuf").end(Buffer.from(encodeExportResponse(partial)));
			return;
		}
		const rejectedField =
			signal === "traces" ? "rejectedSpans" : signal === "logs" ? "rejectedLogRecords" : "rejectedDataPoints";
		// int64 is a decimal string in proto3 JSON; OTLP decoders take both.
		res.status(200).json({
			partialSuccess: partial ? { [rejectedField]: String(partial.rejected), errorMessage: partial.errorMessage } : {},
		});
	}

	/**
	 * `x-autter-ingest` on every accepted ingest response: what was
	 * stored, and what was not stored as its own row (suppressed, collapsed)
	 * or was cut (truncated_values). OTLP's partial_success only carries
	 * rejections, so an all-accepted answer is an empty `partialSuccess: {}`;
	 * this header says what that request actually became.
	 */
	function acceptedSummary(res: Response, counts: Record<string, number>): void {
		res.locals.ingestSummary = counts;
		res.setHeader(INGEST_SUMMARY_HEADER, ingestSummaryHeader(counts));
	}

	app.post("/v1/profiles", asyncRoute(async (req, res) => {
		// Checked before the key: a request that can't be stored never costs a lookup.
		if (!req.is("application/x-pprof") || !Buffer.isBuffer(req.body)) {
			refuse(req, res, knownSender(req), "unsupported_media_type", 415, { error: "expected application/x-pprof" });
			return;
		}
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		const service = req.header("x-autter-service")?.trim() ?? "";
		const environment = req.header("x-autter-environment")?.trim() || "production";
		const release = req.header("x-autter-release")?.trim() ?? "";
		const traceId = req.header("x-autter-trace-id")?.trim() ?? "";
		const instanceId = req.header("x-autter-instance-id")?.trim() ?? "";
		if (!/^[a-zA-Z0-9._-]{1,200}$/.test(service) || environment.length > 100 || release.length > 200 || instanceId.length > 128 || (traceId && !/^[a-f0-9]{32}$/.test(traceId))) {
			refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid profile metadata" });
			return;
		}
		let samples;
		const stats = { overLimit: 0 };
		try {
			samples = decodeProfile(req.body, { service, environment, release, traceId, instanceId }, stats);
			if (!samples.length) throw new Error("empty profile");
		} catch {
			refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid or unsymbolized profile" });
			return;
		}
		try {
			await store.insertProfileSamples(ctx, samples);
		} catch (err) {
			storageError(req, res, ctx, err, samples.length + stats.overLimit);
			return;
		}
		res.status(202).json({ profileId: samples[0]!.profileId, samples: samples.length });
		countAccepted(ctx, req, [{ reason: "profile_samples_over_limit", records: stats.overLimit }]);
	}));

	/** Which of these maps does this tenant already have? Lets
	 * `autter-runtime sourcemaps upload` skip unchanged maps (1.6.0+). */
	app.post("/v1/sourcemaps/check", asyncRoute(async (req, res) => {
		const ctx = await authenticate(req, res, "sourcemaps");
		if (!ctx) return;
		const check = validateSourceMapCheck(req.body);
		if (!check) {
			refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid source map check" });
			return;
		}
		let present: number[];
		try {
			present = await store.sourceMapsPresent(ctx, check);
		} catch (err) {
			storageError(req, res, ctx, err);
			return;
		}
		res.status(200).json({ present });
	}));

	/** ECS/Kubernetes event forwarders use the same server key as OTLP. */
	app.post("/v1/platform-events", asyncRoute(async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		const parsed = platformEventSchema.safeParse(req.body);
		if (!parsed.success) {
			refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid platform event" });
			return;
		}
		const event = normalizePlatformEvent(parsed.data);
		if (!event) {
			refuse(req, res, ctx, "invalid_payload", 400, { error: "event timestamp outside retention window" });
			return;
		}
		try {
			await store.insertPlatformEvent(ctx, event);
		} catch (err) {
			storageError(req, res, ctx, err);
			return;
		}
		res.status(202).json({ accepted: true });
	}));

	app.post("/v1/traces", asyncRoute(async (req, res) => {
		// Checked before the key: a request that can't be stored never costs a lookup.
		if (unsupportedOtlpBody(req)) {
			refuse(req, res, knownSender(req), "unsupported_media_type", 415, UNSUPPORTED_OTLP);
			return;
		}
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		let request: OtlpTraceRequest;
		if (req.is("application/x-protobuf")) {
			try {
				request = decodeTraceRequest(req.body as Buffer);
			} catch {
				refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid protobuf payload" });
				return;
			}
		} else {
			request = req.body as OtlpTraceRequest;
		}
		const totalSpans = spansInRequest(request);
		let normalized: ReturnType<typeof normalizeTraces>;
		let truncated: number;
		try {
			({ result: normalized, truncated } = countTruncations(() => normalizeTraces(request)));
		} catch {
			// A value the normaliser can't read (a timestamp that is not an
			// integer, a list that is not one): before 1.8.0 this threw out of
			// the handler, an unhandled rejection that stopped the process.
			refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid OTLP traces payload" }, totalSpans);
			return;
		}
		// A `verify` test request (delivery.ts): its spans and occurrences
		// are stored, so the CLI can read them back, but it feeds no rollup,
		// suppression or loop window, records no SDK and never reaches the
		// sink, so a check never opens an issue or moves a dashboard.
		const verifyId = verifyIdOf(request, "resourceSpans");
		const { occurrences, occurrenceBatchIndexes, spans } = normalized;
		const metricPoints = verifyId ? [] : normalized.metricPoints;
		const llmCalls = verifyId ? [] : normalized.llmCalls;
		const fingerprinted = await fingerprintAll(ctx, occurrences, occurrenceBatchIndexes);
		const admitted = verifyId ? admitAll(fingerprinted) : admit(ctx, req, fingerprinted);
		// ClickHouse has no cross-table transaction, so these four inserts can
		// partially commit. Recovery boundary: any failure → 503 → the exporter
		// retries the whole batch, and writeAll makes that retry idempotent:
		// tables that already committed are skipped (same process) or deduped
		// by ClickHouse (insert_deduplication_token), so summed metrics and
		// spans are not added twice. Nothing reaches the sink queue unless
		// every insert succeeded, and the sink batch id comes from the same
		// request digest, so a re-sent request is one batch to the consumer.
		const digest = requestDigest(ctx, req.path, req.body);
		try {
			await writeAll(digest, [
				{ table: "runtime_error_occurrences", rows: admitted.kept.length, run: (token) => store.insertOccurrences(ctx, admitted.kept, token) },
				{ table: "runtime_spans", rows: spans.length, run: (token) => store.insertSpans(ctx, spans, token) },
				{ table: "runtime_metrics_1m", rows: metricPoints.length, run: (token) => store.insertMetricPoints(ctx, metricPoints, token) },
				{ table: "runtime_route_latency_input", rows: routeLatencyPoints(metricPoints).length, run: (token) => store.insertRouteLatency(ctx, metricPoints, token) },
				{ table: "runtime_llm_calls", rows: llmCalls.length, run: (token) => store.insertLlmCalls(ctx, llmCalls, token) },
			]);
		} catch (err) {
			admitted.rollback();
			storageError(req, res, ctx, err, totalSpans);
			return;
		}
		admitted.commit();
		if (!verifyId) {
			sink?.enqueue(ctx, admitted.kept, metricPoints, llmCalls, digest);
			recordSdks(ctx, request, req);
		}
		// normalizeTraces stops at SPANS_PER_REQUEST; the rest were not read.
		const overLimit = Math.max(0, totalSpans - normalized.spanCount);
		otlpSuccess(req, res, "traces", partialSuccess([
			{ rejected: overLimit, message: PARTIAL_MESSAGES.spans(overLimit, SPANS_PER_REQUEST) },
		]), {
			spans: spans.length,
			occurrences: admitted.kept.length,
			metric_points: metricPoints.length,
			llm_calls: llmCalls.length,
			suppressed: admitted.suppressed,
			collapsed: admitted.collapsed,
			truncated_values: truncated,
		});
		countAccepted(ctx, req, [
			{ reason: "spans_over_limit", records: overLimit },
			{ reason: "attributes_truncated", records: truncated },
			{ reason: "caught_limited", records: caughtLimitedRecords(occurrences.map((o) => o.attributes)) },
		]);
	}));

	app.post("/v1/logs", asyncRoute(async (req, res) => {
		// Checked before the key: a request that can't be stored never costs a lookup.
		if (unsupportedOtlpBody(req)) {
			refuse(req, res, knownSender(req), "unsupported_media_type", 415, UNSUPPORTED_OTLP);
			return;
		}
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		let logs: ReturnType<typeof normalizeLogs>;
		let logsRequest: OtlpLogsRequest;
		let truncated: number;
		const stats = { overLimit: 0 };
		try {
			logsRequest = req.is("application/x-protobuf") ? decodeLogsRequest(req.body as Buffer) : req.body as OtlpLogsRequest;
			({ result: logs, truncated } = countTruncations(() => normalizeLogs(logsRequest, stats)));
		} catch {
			refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid OTLP logs payload" });
			return;
		}
		// Logs are diagnostic evidence; exceptions and failed outcomes normally
		// reach grouping through the trace path. The exception: logger-only /
		// edge SDKs mark span-less error records `autter.capture.mode = "log"`,
		// and those are promoted to occurrences here — see log-promotion.ts.
		const promoted = await promoteLogs(ctx, logs);
		// A `verify` test request: stored, nothing else (see /v1/traces).
		const verifyId = verifyIdOf(logsRequest, "resourceLogs");
		// Rollups count every promoted error, collapsed or suppressed ones too.
		const metricPoints = verifyId ? [] : logRollups(logs, promoted);
		const admitted = verifyId ? admitAll(promoted) : admit(ctx, req, promoted);
		const digest = requestDigest(ctx, req.path, req.body);
		try {
			await writeAll(digest, [
				{ table: "runtime_logs", rows: logs.length, run: (token) => store.insertLogs(ctx, logs, token) },
				{ table: "runtime_error_occurrences", rows: admitted.kept.length, run: (token) => store.insertOccurrences(ctx, admitted.kept, token) },
				{ table: "runtime_metrics_1m", rows: metricPoints.length, run: (token) => store.insertMetricPoints(ctx, metricPoints, token) },
				{ table: "runtime_route_latency_input", rows: routeLatencyPoints(metricPoints).length, run: (token) => store.insertRouteLatency(ctx, metricPoints, token) },
			]);
		} catch (err) {
			admitted.rollback();
			storageError(req, res, ctx, err, logs.length + stats.overLimit);
			return;
		}
		admitted.commit();
		if (!verifyId) {
			sink?.enqueue(ctx, admitted.kept, metricPoints, [], digest);
			recordSdks(ctx, logsRequest, req);
		}
		otlpSuccess(req, res, "logs", partialSuccess([
			{ rejected: stats.overLimit, message: PARTIAL_MESSAGES.logRecords(stats.overLimit, MAX_LOG_RECORDS_PER_REQUEST) },
		]), {
			log_records: logs.length,
			occurrences: admitted.kept.length,
			metric_points: metricPoints.length,
			suppressed: admitted.suppressed,
			collapsed: admitted.collapsed,
			truncated_values: truncated,
		});
		countAccepted(ctx, req, [
			{ reason: "log_records_over_limit", records: stats.overLimit },
			{ reason: "attributes_truncated", records: truncated },
			// Every record, promoted or not (the SDK's own count records too).
			{ reason: "caught_limited", records: caughtLimitedRecords(logs.map((row) => row.attributes)) },
		]);
	}));

	app.post("/v1/metrics", asyncRoute(async (req, res) => {
		// Checked before the key: a request that can't be stored never costs a lookup.
		if (unsupportedOtlpBody(req)) {
			refuse(req, res, knownSender(req), "unsupported_media_type", 415, UNSUPPORTED_OTLP);
			return;
		}
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		let request: OtlpMetricsRequest;
		if (req.is("application/x-protobuf")) {
			try {
				request = decodeMetricsRequest(req.body as Buffer);
			} catch {
				refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid protobuf payload" });
				return;
			}
		} else {
			request = req.body as OtlpMetricsRequest;
		}
		const memoryStats = { invalid: 0, overLimit: 0 };
		let metricPoints: ReturnType<typeof normalizeMetrics>;
		let memorySamples: ReturnType<typeof normalizeMemoryMetrics>;
		let latency: ReturnType<typeof normalizeLatencyHistograms>;
		let cumulative: number;
		try {
			metricPoints = normalizeMetrics(request);
			memorySamples = normalizeMemoryMetrics(request, memoryStats);
			latency = normalizeLatencyHistograms(request);
			cumulative = cumulativeHttpHistogramPoints(request);
		} catch {
			refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid OTLP metrics payload" }, dataPointsInRequest(request));
			return;
		}
		const digest = requestDigest(ctx, req.path, req.body);
		try {
			await writeAll(digest, [
				{ table: "runtime_latency_histograms", rows: latency.length, run: (token) => store.insertLatencyHistograms(ctx, latency, token) },
				{ table: "runtime_metrics_1m", rows: metricPoints.length, run: (token) => store.insertMetricPoints(ctx, metricPoints, token) },
				{ table: "runtime_route_latency_input", rows: routeLatencyPoints(metricPoints).length, run: (token) => store.insertRouteLatency(ctx, metricPoints, token) },
				{ table: "runtime_memory_samples", rows: memorySamples.length, run: (token) => store.insertMemorySamples(ctx, memorySamples, token) },
			]);
		} catch (err) {
			storageError(req, res, ctx, err, dataPointsInRequest(request));
			return;
		}
		sink?.enqueue(ctx, [], metricPoints, [], digest);
		recordSdks(ctx, request, req);
		// Metrics the ingester has no use for (anything but HTTP server
		// duration histograms and the memory/GC instruments) are ignored,
		// not rejected: they are neither answered nor counted.
		const metricsSummary = {
			metric_points: metricPoints.length,
			latency_histograms: latency.length,
			memory_samples: memorySamples.length,
		};
		otlpSuccess(req, res, "metrics", partialSuccess([
			{ rejected: cumulative, message: PARTIAL_MESSAGES.cumulative(cumulative) },
			{ rejected: memoryStats.invalid, message: PARTIAL_MESSAGES.memoryInvalid(memoryStats.invalid) },
			{
				rejected: memoryStats.overLimit,
				message: PARTIAL_MESSAGES.memoryOverLimit(memoryStats.overLimit, MAX_MEMORY_SAMPLES_PER_REQUEST),
			},
		]), metricsSummary);
		countAccepted(ctx, req, [
			{ reason: "cumulative_histogram", records: cumulative },
			{ reason: "memory_point_invalid", records: memoryStats.invalid },
			{ reason: "memory_points_over_limit", records: memoryStats.overLimit },
		]);
	}));

	app.post("/v1/browser", asyncRoute(async (req, res) => {
		let body: unknown = req.body;
		if (typeof body === "string") {
			// text/plain from a cross-origin sendBeacon — see CORS note above.
			// Parsed before the key (like JSON bodies, which body-parser reads
			// before any route): unparseable beacons never cost a lookup.
			try {
				body = JSON.parse(body);
			} catch {
				refuse(req, res, knownSender(req), "invalid_payload", 400, { error: "invalid json" }, 0);
				return;
			}
		}
		const ctx = await authenticate(req, res, "browser");
		if (!ctx) return;
		// The envelope must be valid; each event is validated on its own and
		// an invalid one is dropped and counted (1.8.0), not the whole beacon.
		const parsed = parseBrowserPayload(body);
		if (!parsed.success) {
			refuse(
				req,
				res,
				ctx,
				"invalid_payload",
				400,
				{ error: "invalid payload", issues: parsed.issues },
				recordsInBody("/v1/browser", body, false),
			);
			return;
		}
		const { payload, invalidEvents, overLimitEvents, issues } = parsed.data;
		let normalized: ReturnType<typeof normalizeBrowserPayload>;
		let truncated: number;
		try {
			({ result: normalized, truncated } = countTruncations(() => normalizeBrowserPayload(payload)));
		} catch {
			refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid payload" }, recordsInBody("/v1/browser", body, false));
			return;
		}
		const { occurrences, metricPoints } = normalized;
		const fingerprinted = await fingerprintAll(ctx, occurrences);
		const admitted = admit(ctx, req, fingerprinted);
		const digest = requestDigest(ctx, req.path, req.body);
		try {
			await writeAll(digest, [
				{ table: "runtime_error_occurrences", rows: admitted.kept.length, run: (token) => store.insertOccurrences(ctx, admitted.kept, token) },
				{ table: "runtime_metrics_1m", rows: metricPoints.length, run: (token) => store.insertMetricPoints(ctx, metricPoints, token) },
				{ table: "runtime_route_latency_input", rows: routeLatencyPoints(metricPoints).length, run: (token) => store.insertRouteLatency(ctx, metricPoints, token) },
			]);
		} catch (err) {
			admitted.rollback();
			storageError(req, res, ctx, err, payload.events.length + invalidEvents + overLimitEvents);
			return;
		}
		admitted.commit();
		sink?.enqueue(ctx, admitted.kept, metricPoints, [], digest);
		if (payload.sdk) {
			void sdkVersions.observe(ctx, [{
				service: payload.service,
				environment: payload.environment,
				sdkName: BROWSER_SDK_NAME,
				sdkVersion: payload.sdk,
				sdkLanguage: "webjs",
				via: telemetryVia({ userAgent: req.headers["user-agent"] ?? null, browserKeyScope: ctx.scope }),
			}]);
		}
		void reportIngesterInfo();
		const rejected = invalidEvents + overLimitEvents;
		acceptedSummary(res, {
			events: payload.events.length,
			occurrences: admitted.kept.length,
			metric_points: metricPoints.length,
			suppressed: admitted.suppressed,
			collapsed: admitted.collapsed,
			truncated_values: truncated,
			rejected,
		});
		res.status(202).json({ accepted: fingerprinted.length, ...(rejected > 0 ? { rejected, issues } : {}) });
		countAccepted(ctx, req, [
			{ reason: "invalid_event", records: invalidEvents },
			{ reason: "events_over_limit", records: overLimitEvents },
			{ reason: "attributes_truncated", records: truncated },
		]);
	}));

	/**
	 * Delivery check for the key's holder, used by `autter-runtime
	 * verify`: this key's last accepted and last refused request as this
	 * process saw them, storage readiness, and — with a trace id — what was
	 * stored for it in the last day (spans, occurrences, logs, with their
	 * services and releases). Server keys only; never another key's data.
	 */
	const verifyRoute = asyncRoute(async (req, res) => {
		res.setHeader("cache-control", "no-store");
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		const traceId = typeof req.params.traceId === "string" ? req.params.traceId.toLowerCase() : null;
		if (traceId !== null && !/^[a-f0-9]{32}$/.test(traceId)) {
			res.status(400).json({ error: "trace id must be 32 hex characters" });
			return;
		}
		const key = keys.extractKey(req);
		const readinessState = await readiness.get();
		const body: Record<string, unknown> = {
			ingester: { version },
			storage: readinessState.state,
			delivery: key ? delivery.get(deliveryKeyHash(key)) : null,
		};
		if (traceId) {
			try {
				body.traceId = traceId;
				body.stored = await store.verifyLookup(ctx, traceId);
			} catch (err) {
				console.error("verify lookup failed:", err);
				res.status(503).json({ ...body, error: "storage unavailable, retry later" });
				return;
			}
		}
		res.status(200).json(body);
	});
	app.get("/v1/verify", verifyRoute);
	app.get("/v1/verify/:traceId", verifyRoute);

	// A POST to a path nobody serves (a collector endpoint with /v1/traces
	// twice, an exporter on the wrong base path): counted, then Express's
	// usual 404. Its key is never resolved (knownSender: cache only).
	app.use((req: Request, _res: Response, next: NextFunction) => {
		if (req.method === "POST") countUnrouted(req, "unknown_route", 404);
		next();
	});

	// Body-parser errors (oversized/malformed JSON) → clean 4xx, not a stack.
	// They happen before any route ran: the tenant comes from the key caches
	// only (knownSender), never from a validator call.
	app.use(
		(
			err: Error & { type?: string; status?: number },
			req: Request,
			res: Response,
			next: (err?: Error) => void,
		) => {
			if (res.headersSent) return next(err);
			if (err.type === "entity.too.large") {
				res.status(413).json({ error: "payload too large" });
				countUnrouted(req, "payload_too_large", 413);
				return;
			}
			if (err.status && err.status < 500) {
				res.status(err.status).json({ error: "bad request" });
				countUnrouted(
					req,
					err.status === 415 ? "unsupported_media_type" : err.type === "request.aborted" ? "request_aborted" : "invalid_payload",
					err.status,
				);
				return;
			}
			console.error("unhandled error:", err);
			res.status(500).json({ error: "internal error" });
			countUnrouted(req, "internal_error", 500);
		},
	);

	return { app, store, sink, reportIngesterInfo, drops, collapse, limits, keys, archiver: createArchiver(config, store, redis) };
}

/**
 * The archive job for this process, or null: no archive configured, no
 * ClickHouse, or another process runs it (archiveSchedulerMode).
 */
function createArchiver(
	config: IngesterConfig,
	store: ClickHouseStore,
	redis: ReturnType<typeof connectRedis> | null,
): RuntimeArchiver | null {
	const archive = config.archive;
	if (!archive || !store.configured) return null;
	const mode = archiveSchedulerMode({ scheduler: archive.scheduler, hasRedis: Boolean(redis), replicas: config.replicas ?? 1 });
	if (mode.mode === "none") {
		const level = archive.scheduler === "off" ? "log" : "warn";
		console[level](`runtime archive: this process does not run the archive job (${mode.reason})`);
		return null;
	}
	const lease =
		mode.mode === "redis" && redis
			? new RedisArchiveLease(redis, `autter:runtime-archive:${config.clickhouseDatabase}`)
			: new LocalArchiveLease();
	return new RuntimeArchiver({
		db: store.archiveDb(),
		database: config.clickhouseDatabase,
		config: archive,
		hotDays: store.hotDays(),
		lease,
	});
}

/**
 * Open the sink outbox (sink-outbox.ts) and read what the last run left.
 * Never throws: an unusable directory (permissions, another live process
 * holding it) falls back to memory-only delivery, loudly.
 */
function openOutbox(config: IngesterConfig): { outbox: SinkOutbox; pending: OutboxRecord[] } | null {
	if (!config.sinkOutboxDir) {
		if (config.sinkUrl) {
			console.warn("sink outbox off (SINK_OUTBOX_DIR=off): undelivered sink batches are lost on restart");
		}
		return null;
	}
	const outbox = new SinkOutbox(config.sinkOutboxDir, {
		fsync: config.sinkOutboxFsync,
		deadLetterMaxBytes: (config.sinkDeadLetterMaxMb ?? 256) * 1024 * 1024,
		shared: config.sinkOutboxShared,
		instance: `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
	});
	try {
		return { outbox, pending: outbox.open() };
	} catch (err) {
		console.error(
			err instanceof OutboxLockedError
				? `${err.message} — give each ingester process its own SINK_OUTBOX_DIR; delivering from memory only`
				: `sink outbox ${config.sinkOutboxDir} unusable (${(err as Error).message}) — delivering from memory only`,
		);
		return null;
	}
}

/** Prometheus exposition of the readiness report (counters and gauges). */
function prometheusText(report: {
	ok: boolean;
	clickhouse: StorageState;
	writes: { consecutiveFailures: number; lagSeconds: number; okWrites: number; failedWrites: number };
	drops: { byReason: Array<{ route: string; reason: string; kind: string; requests: number; records: number }> };
	sink?: ReturnType<SinkForwarder["stats"]>;
}): string {
	const lines: string[] = [];
	const metric = (name: string, type: "counter" | "gauge", help: string, samples: Array<[Record<string, string>, number]>) => {
		lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
		for (const [labels, value] of samples) {
			const rendered = Object.entries(labels)
				.map(([key, val]) => `${key}="${val.replace(/["\\\n]/g, "_")}"`)
				.join(",");
			lines.push(`${name}${rendered ? `{${rendered}}` : ""} ${value}`);
		}
	};
	metric("autter_ingester_ready", "gauge", "1 when the ingester can store what it is sent.", [[{}, report.ok ? 1 : 0]]);
	metric("autter_ingester_storage_state", "gauge", "Storage state (1 for the current one).", (
		["up", "down", "auth_failed", "schema_missing", "unconfigured"] as const
	).map((state) => [{ state }, report.clickhouse === state ? 1 : 0]));
	metric("autter_ingester_writes_total", "counter", "ClickHouse ingest writes by outcome.", [
		[{ outcome: "ok" }, report.writes.okWrites],
		[{ outcome: "failed" }, report.writes.failedWrites],
	]);
	metric("autter_ingester_write_lag_seconds", "gauge", "Seconds since the last successful write while writes fail.", [[{}, report.writes.lagSeconds]]);
	metric("autter_ingester_dropped_requests_total", "counter", "Requests refused or with records not stored, by route and reason.",
		report.drops.byReason.map((t) => [{ route: t.route, reason: t.reason, kind: t.kind }, t.requests]));
	metric("autter_ingester_dropped_records_total", "counter", "Records not stored or not forwarded, by route and reason.",
		report.drops.byReason.map((t) => [{ route: t.route, reason: t.reason, kind: t.kind }, t.records]));
	if (report.sink) {
		const sink = report.sink;
		metric("autter_sink_queued_batches", "gauge", "Sink batches waiting for delivery.", [[{}, sink.queued + sink.inFlight]]);
		metric("autter_sink_oldest_queued_age_seconds", "gauge", "Age of the oldest undelivered sink batch.", [[{}, sink.oldestQueuedAgeSeconds]]);
		metric("autter_sink_batches_total", "counter", "Sink batches by outcome.", [
			[{ outcome: "delivered" }, sink.delivered],
			[{ outcome: "retried" }, sink.retried],
			[{ outcome: "dead_lettered" }, sink.deadLettered],
			[{ outcome: "restored" }, sink.restored],
		]);
		metric("autter_sink_dead_letter_files", "gauge", "Dead-lettered sink batches kept on disk.", [[{}, sink.deadLetterFiles]]);
		metric("autter_sink_outbox_write_failures_total", "counter", "Sink batches that could not be written to the outbox.", [[{}, sink.outboxWriteFailures]]);
		metric("autter_sink_durable", "gauge", "1 when undelivered sink batches survive a restart.", [[{}, sink.durable ? 1 : 0]]);
	}
	return `${lines.join("\n")}\n`;
}
