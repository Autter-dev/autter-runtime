import express, {
	type Express,
	type NextFunction,
	type Request,
	type Response,
} from "express";
import { KeyResolver, RateLimiter } from "./auth.js";
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
import { ClickHouseStore } from "./clickhouse.js";
import { normalizeLatencyHistograms } from "./latency.js";
import type { IngesterConfig } from "./config.js";
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
import { MAX_LOG_RECORDS_PER_REQUEST, normalizeLogs, type OtlpLogsRequest } from "./logs.js";
import { decodeProfile } from "./profiles.js";
import {
	MAX_MEMORY_SAMPLES_PER_REQUEST,
	normalizeMemoryMetrics,
	normalizePlatformEvent,
	platformEventSchema,
} from "./memory.js";
import { SOURCE_MAP_MAX_BODY_BYTES, validateSourceMap, validateSourceMapCheck } from "./source-maps.js";
import { SinkForwarder } from "./sink.js";
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

export function createIngesterApp(config: IngesterConfig): IngesterApp {
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
	// watching. Delivery is at-least-once with bounded retries — see sink.ts.
	const sink = config.sinkUrl ? new SinkForwarder(config) : null;
	const keys = new KeyResolver(config);
	const serverRateLimiter = new RateLimiter(config.rateLimitPerMinute);
	const clientRateLimiter = new RateLimiter(config.clientRateLimitPerMinute);
	// ClickHouse dedupe lookups made by /v1/logs promotion, per tenant. Far
	// tighter than the request limit: each lookup is a query, not an insert.
	const promotionLookupLimiter = new RateLimiter(config.promotionLookupsPerMinute ?? 30);
	const version = ingesterVersion();
	const sdkVersions = new SdkVersionTracker((ctx, rows) => store.insertSdkVersions(ctx, rows));
	// What was refused or not stored, per tenant and minute (EI-27). Written
	// in batches every few seconds, bounded, never retried: it can't slow
	// or fail ingest. Without ClickHouse there is nowhere to count.
	const drops = new IngestDropCounter((rows) => store.insertIngestDrops(rows), { enabled: store.configured });
	drops.start();
	if (sink) {
		sink.onDrop = (drop) =>
			drops.record({
				tenant: { orgId: drop.orgId, repositoryId: drop.repositoryId },
				route: "sink",
				reason: drop.reason,
				records: drop.occurrences,
			});
	}
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
			commit(): void {
				plan.commit();
				if (suppressed > 0) drops.record({ tenant: ctx, route, reason: "suppressed", requests: 0, records: suppressed });
			},
			rollback(): void {
				plan.rollback();
			},
		};
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
	 * Count a refusal made before any route ran (body-parser errors, unknown
	 * routes): resolve the key in the background to find the tenant. Never
	 * delays the response, never throws.
	 */
	function countUnrouted(req: Request, reason: DropReason, status: number): void {
		if (!store.configured) return;
		const route = dropRoute(req.path);
		const records = recordsInBody(route, req.body, Boolean(req.is("application/x-protobuf")));
		const key = keys.extractKey(req);
		if (!key) {
			drops.record({ tenant: null, route, reason, status, records });
			return;
		}
		keys
			.resolveDetailed(key)
			.then((resolution) =>
				drops.record({
					tenant: resolution.ctx,
					...(resolution.ctx ? {} : { keyHash: autterKeyHash(key) }),
					route,
					reason,
					status,
					records,
				}),
			)
			.catch(() => {});
	}

	const app = express();
	app.disable("x-powered-by");
	// Every response names the ingester version, so SDKs (and the browser
	// relay) learn it for free from responses they already receive.
	app.use((_req, res, next) => {
		res.setHeader(INGESTER_VERSION_HEADER, version);
		next();
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
		res.setHeader("access-control-expose-headers", INGESTER_VERSION_HEADER);
		res.setHeader("access-control-max-age", "86400");
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}
		next();
	});

	app.get("/healthz", async (_req, res) => {
		const sinkStats = {
			...(sink ? { sink: sink.stats() } : {}),
			// Counters only (no tenant data): /healthz is public.
			...(collapse.enabled ? { collapse: collapse.stats() } : {}),
		};
		if (!store.configured) {
			res.status(200).json({ ok: true, clickhouse: "unconfigured", ...sinkStats });
			return;
		}
		try {
			const ok = await store.ping();
			res
				.status(ok ? 200 : 503)
				.json({ ok, clickhouse: ok ? "up" : "down", ...sinkStats });
		} catch {
			res.status(503).json({ ok: false, clickhouse: "down", ...sinkStats });
		}
	});

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
		const key = keys.extractKey(req);
		if (!key) {
			refuse(req, res, null, "missing_key", 401, { error: "missing ingest key" });
			return null;
		}
		const resolution = await keys.resolveDetailed(key);
		const ctx = resolution.ctx;
		if (!ctx) {
			// No tenant: counted against the null tenant, with the key's hash
			// when it is an Autter key (ingest-drops.ts autterKeyHash).
			refuse(req, res, { keyHash: autterKeyHash(key) }, resolution.failure, 401, { error: "invalid ingest key" });
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
			const origin = req.headers.origin;
			if (
				ctx.allowedOrigins.length > 0 &&
				(!origin || !ctx.allowedOrigins.includes(origin))
			) {
				refuse(req, res, ctx, "origin_not_allowed", 403, { error: "origin not allowed for this key" });
				return null;
			}
			if (!clientRateLimiter.allow(key)) {
				refuse(req, res, ctx, "rate_limited", 429, { error: "rate limit exceeded" });
				return null;
			}
			return ctx;
		} else if (ctx.scope !== "server") {
			// KeyResolver never yields another scope; refuse rather than
			// treat an unknown one as a server key.
			refuse(req, res, ctx, "key_scope_not_allowed", 403, { error: "key scope not allowed" });
			return null;
		}
		if (!serverRateLimiter.allow(key)) {
			refuse(req, res, ctx, "rate_limited", 429, { error: "rate limit exceeded" });
			return null;
		}
		return ctx;
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
			if (!promotionLookupLimiter.allow(`${ctx.orgId}:${ctx.repositoryId}`)) break;
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
	function otlpSuccess(req: Request, res: Response, signal: OtlpSignal, partial: PartialSuccess | null): void {
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

	app.post("/v1/profiles", asyncRoute(async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		if (!req.is("application/x-pprof") || !Buffer.isBuffer(req.body)) {
			refuse(req, res, ctx, "unsupported_media_type", 415, { error: "expected application/x-pprof" });
			return;
		}
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
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		if (unsupportedOtlpBody(req)) {
			refuse(req, res, ctx, "unsupported_media_type", 415, UNSUPPORTED_OTLP);
			return;
		}
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
		const { occurrences, occurrenceBatchIndexes, spans, metricPoints, llmCalls } = normalized;
		const fingerprinted = await fingerprintAll(ctx, occurrences, occurrenceBatchIndexes);
		const admitted = admit(ctx, req, fingerprinted);
		// ClickHouse has no cross-table transaction, so these four inserts can
		// partially commit. Recovery boundary: any failure → 503 → the exporter
		// retries the whole batch. Deterministic occurrence ids make the retry
		// idempotent downstream (consumer dedupes per id; duplicate ClickHouse
		// rows share an id, and the consumer's reconciler counts distinct ids),
		// and nothing reaches the sink queue unless every insert succeeded —
		// signals persisted by a partial write are picked up by the consumer's
		// ClickHouse reconciliation instead.
		try {
			await Promise.all([
				store.insertOccurrences(ctx, admitted.kept),
				store.insertSpans(ctx, spans),
				store.insertMetricPoints(ctx, metricPoints),
				store.insertLlmCalls(ctx, llmCalls),
			]);
		} catch (err) {
			admitted.rollback();
			storageError(req, res, ctx, err, totalSpans);
			return;
		}
		admitted.commit();
		sink?.enqueue(ctx, admitted.kept, metricPoints, llmCalls);
		recordSdks(ctx, request, req);
		// normalizeTraces stops at SPANS_PER_REQUEST; the rest were not read.
		const overLimit = Math.max(0, totalSpans - normalized.spanCount);
		otlpSuccess(req, res, "traces", partialSuccess([
			{ rejected: overLimit, message: PARTIAL_MESSAGES.spans(overLimit, SPANS_PER_REQUEST) },
		]));
		countAccepted(ctx, req, [
			{ reason: "spans_over_limit", records: overLimit },
			{ reason: "attributes_truncated", records: truncated },
			{ reason: "caught_limited", records: caughtLimitedRecords(occurrences.map((o) => o.attributes)) },
		]);
	}));

	app.post("/v1/logs", asyncRoute(async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		if (unsupportedOtlpBody(req)) {
			refuse(req, res, ctx, "unsupported_media_type", 415, UNSUPPORTED_OTLP);
			return;
		}
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
		// Rollups count every promoted error, collapsed or suppressed ones too.
		const metricPoints = logRollups(logs, promoted);
		const admitted = admit(ctx, req, promoted);
		try {
			await Promise.all([
				store.insertLogs(ctx, logs),
				store.insertOccurrences(ctx, admitted.kept),
				store.insertMetricPoints(ctx, metricPoints),
			]);
		} catch (err) {
			admitted.rollback();
			storageError(req, res, ctx, err, logs.length + stats.overLimit);
			return;
		}
		admitted.commit();
		sink?.enqueue(ctx, admitted.kept, metricPoints);
		recordSdks(ctx, logsRequest, req);
		otlpSuccess(req, res, "logs", partialSuccess([
			{ rejected: stats.overLimit, message: PARTIAL_MESSAGES.logRecords(stats.overLimit, MAX_LOG_RECORDS_PER_REQUEST) },
		]));
		countAccepted(ctx, req, [
			{ reason: "log_records_over_limit", records: stats.overLimit },
			{ reason: "attributes_truncated", records: truncated },
			// Every record, promoted or not (the SDK's own count records too).
			{ reason: "caught_limited", records: caughtLimitedRecords(logs.map((row) => row.attributes)) },
		]);
	}));

	app.post("/v1/metrics", asyncRoute(async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		if (unsupportedOtlpBody(req)) {
			refuse(req, res, ctx, "unsupported_media_type", 415, UNSUPPORTED_OTLP);
			return;
		}
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
		try {
			await store.insertLatencyHistograms(ctx, latency);
			await store.insertMetricPoints(ctx, metricPoints);
			await store.insertMemorySamples(ctx, memorySamples);
		} catch (err) {
			storageError(req, res, ctx, err, dataPointsInRequest(request));
			return;
		}
		sink?.enqueue(ctx, [], metricPoints);
		recordSdks(ctx, request, req);
		// Metrics the ingester has no use for (anything but HTTP server
		// duration histograms and the memory/GC instruments) are ignored,
		// not rejected: they are neither answered nor counted.
		otlpSuccess(req, res, "metrics", partialSuccess([
			{ rejected: cumulative, message: PARTIAL_MESSAGES.cumulative(cumulative) },
			{ rejected: memoryStats.invalid, message: PARTIAL_MESSAGES.memoryInvalid(memoryStats.invalid) },
			{
				rejected: memoryStats.overLimit,
				message: PARTIAL_MESSAGES.memoryOverLimit(memoryStats.overLimit, MAX_MEMORY_SAMPLES_PER_REQUEST),
			},
		]));
		countAccepted(ctx, req, [
			{ reason: "cumulative_histogram", records: cumulative },
			{ reason: "memory_point_invalid", records: memoryStats.invalid },
			{ reason: "memory_points_over_limit", records: memoryStats.overLimit },
		]);
	}));

	app.post("/v1/browser", asyncRoute(async (req, res) => {
		const ctx = await authenticate(req, res, "browser");
		if (!ctx) return;
		let body: unknown = req.body;
		if (typeof body === "string") {
			// text/plain from a cross-origin sendBeacon — see CORS note above.
			try {
				body = JSON.parse(body);
			} catch {
				refuse(req, res, ctx, "invalid_payload", 400, { error: "invalid json" }, 0);
				return;
			}
		}
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
		try {
			await Promise.all([
				store.insertOccurrences(ctx, admitted.kept),
				store.insertMetricPoints(ctx, metricPoints),
			]);
		} catch (err) {
			admitted.rollback();
			storageError(req, res, ctx, err, payload.events.length + invalidEvents + overLimitEvents);
			return;
		}
		admitted.commit();
		sink?.enqueue(ctx, admitted.kept, metricPoints);
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
		res.status(202).json({ accepted: fingerprinted.length, ...(rejected > 0 ? { rejected, issues } : {}) });
		countAccepted(ctx, req, [
			{ reason: "invalid_event", records: invalidEvents },
			{ reason: "events_over_limit", records: overLimitEvents },
			{ reason: "attributes_truncated", records: truncated },
		]);
	}));

	// A POST to a path nobody serves (a collector endpoint with /v1/traces
	// twice, an exporter on the wrong base path): counted, then Express's
	// usual 404.
	app.use((req: Request, _res: Response, next: NextFunction) => {
		if (req.method === "POST") countUnrouted(req, "unknown_route", 404);
		next();
	});

	// Body-parser errors (oversized/malformed JSON) → clean 4xx, not a stack.
	// They happen before any route ran, so the tenant is resolved in the
	// background to count them.
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

	return { app, store, sink, reportIngesterInfo, drops, collapse };
}
