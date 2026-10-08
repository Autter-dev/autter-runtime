import express, {
	type Express,
	type Request,
	type Response,
} from "express";
import { KeyResolver, RateLimiter } from "./auth.js";
import { ClickHouseStore } from "./clickhouse.js";
import { normalizeLatencyHistograms } from "./latency.js";
import type { IngesterConfig } from "./config.js";
import {
	deriveFields,
	fingerprintOccurrence,
	occurrenceIdFor,
} from "./fingerprint.js";
import {
	browserPayloadSchema,
	normalizeBrowserPayload,
} from "./normalize-browser.js";
import {
	normalizeMetrics,
	normalizeTraces,
	type OtlpMetricsRequest,
	type OtlpTraceRequest,
} from "./normalize-otlp.js";
import { decodeMetricsRequest, decodeTraceRequest, decodeLogsRequest } from "./otlp-proto.js";
import { normalizeLogs, type OtlpLogsRequest } from "./logs.js";
import { decodeProfile } from "./profiles.js";
import { normalizeMemoryMetrics, normalizePlatformEvent, platformEventSchema } from "./memory.js";
import { validateSourceMap } from "./source-maps.js";
import { SinkForwarder } from "./sink.js";
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
	type OtlpResourceRequest,
} from "./sdk-versions.js";
import type {
	IngestContext,
	RuntimeOccurrence,
	RuntimeOccurrenceInput,
} from "./types.js";

export interface IngesterApp {
	app: Express;
	store: ClickHouseStore;
	/** Present when AUTTER_SINK_URL is configured. */
	sink: SinkForwarder | null;
	/** Record this ingester's version + schema level in ClickHouse (for the
	 * Autter dashboard). Called after the boot schema warm-up; throttled. */
	reportIngesterInfo: () => Promise<void>;
}

/** Re-report the ingester version at most this often (keeps the row inside
 * its TTL for long-running ingesters). */
const INGESTER_INFO_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createIngesterApp(config: IngesterConfig): IngesterApp {
	configureRedaction(config);
	const store = new ClickHouseStore(config);
	// Fingerprinted occurrences feed the consumer's issue grouping, metric
	// points feed the request/error-rate rollups, LLM calls feed spend
	// watching. Delivery is at-least-once with bounded retries — see sink.ts.
	const sink = config.sinkUrl ? new SinkForwarder(config) : null;
	const keys = new KeyResolver(config);
	const serverRateLimiter = new RateLimiter(config.rateLimitPerMinute);
	const clientRateLimiter = new RateLimiter(config.clientRateLimitPerMinute);
	const version = ingesterVersion();
	const sdkVersions = new SdkVersionTracker((ctx, rows) => store.insertSdkVersions(ctx, rows));
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
	function recordSdks(ctx: IngestContext, request: unknown): void {
		void sdkVersions.observe(ctx, sdkSightingsFromOtlp(request as OtlpResourceRequest));
		void reportIngesterInfo();
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
	app.use("/v1/sourcemaps", express.json({ limit: "5mb" }));
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
		const sinkStats = sink ? { sink: sink.stats() } : {};
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

	/** Auth + scope + rate limit; returns null (response sent) on failure. */
	async function authenticate(
		req: Request,
		res: Response,
		surface: "otlp" | "browser",
	): Promise<IngestContext | null> {
		// A storage-less ingester must refuse, not accept-and-drop: exporters
		// retry on 503, so telemetry survives a misconfigured deploy.
		if (!store.configured) {
			res.status(503).json({ error: "storage not configured" });
			return null;
		}
		const key = keys.extractKey(req);
		if (!key) {
			res.status(401).json({ error: "missing ingest key" });
			return null;
		}
		const ctx = await keys.resolve(key);
		if (!ctx) {
			res.status(401).json({ error: "invalid ingest key" });
			return null;
		}
		if (ctx.scope === "client") {
			// Publishable keys: browser surface only, origin allow-list, and
			// the tighter rate window.
			if (surface !== "browser") {
				res.status(403).json({
					error: "client keys cannot send OTLP — use a server key",
				});
				return null;
			}
			const origin = req.headers.origin;
			if (
				ctx.allowedOrigins.length > 0 &&
				(!origin || !ctx.allowedOrigins.includes(origin))
			) {
				res.status(403).json({ error: "origin not allowed for this key" });
				return null;
			}
			if (!clientRateLimiter.allow(key)) {
				res.status(429).json({ error: "rate limit exceeded" });
				return null;
			}
			return ctx;
		}
		if (!serverRateLimiter.allow(key)) {
			res.status(429).json({ error: "rate limit exceeded" });
			return null;
		}
		return ctx;
	}

	/** Ids are content-derived (occurrenceIdFor), NOT random: an exporter
	 * that retries a batch — after a 503 from a partially-failed ClickHouse
	 * write, or when only our 2xx got lost — must produce the same ids, so
	 * the sink consumer's per-occurrence dedupe holds across transport
	 * retries and duplicated ClickHouse rows stay identifiable. */
	function fingerprintAll(
		ctx: IngestContext,
		inputs: RuntimeOccurrenceInput[],
	): RuntimeOccurrence[] {
		return inputs.map((raw, index) => {
			// Second line of defence, before fingerprinting, storage, and the
			// sink (which feeds LLM fix generation): scrub secrets from the
			// free-text fields old SDKs and third-party OTLP senders pass
			// through verbatim. Attributes were already sanitised by the
			// normalisers (sanitizeRuntimeContext).
			const input = scrubOccurrence(raw);
			const fingerprint = fingerprintOccurrence(input);
			return {
				...input,
				occurrenceId: occurrenceIdFor(ctx, input, fingerprint, index),
				fingerprint,
				...deriveFields(input),
			};
		});
	}

	function storageError(res: Response, err: unknown): void {
		console.error("clickhouse write failed:", err);
		res.status(503).json({ error: "storage unavailable, retry later" });
	}

	/** OTLP success responses mirror the request encoding: an empty
	 * protobuf message body for proto clients, JSON otherwise. */
	function otlpSuccess(req: Request, res: Response): void {
		if (req.is("application/x-protobuf")) {
			res.status(200).type("application/x-protobuf").end();
			return;
		}
		res.status(200).json({ partialSuccess: {} });
	}

	app.post("/v1/profiles", async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		if (!req.is("application/x-pprof") || !Buffer.isBuffer(req.body)) {
			res.status(415).json({ error: "expected application/x-pprof" });
			return;
		}
		const service = req.header("x-autter-service")?.trim() ?? "";
		const environment = req.header("x-autter-environment")?.trim() || "production";
		const release = req.header("x-autter-release")?.trim() ?? "";
		const traceId = req.header("x-autter-trace-id")?.trim() ?? "";
		const instanceId = req.header("x-autter-instance-id")?.trim() ?? "";
		if (!/^[a-zA-Z0-9._-]{1,200}$/.test(service) || environment.length > 100 || release.length > 200 || instanceId.length > 128 || (traceId && !/^[a-f0-9]{32}$/.test(traceId))) {
			res.status(400).json({ error: "invalid profile metadata" });
			return;
		}
		let samples;
		try {
			samples = decodeProfile(req.body, { service, environment, release, traceId, instanceId });
			if (!samples.length) throw new Error("empty profile");
		} catch {
			res.status(400).json({ error: "invalid or unsymbolized profile" });
			return;
		}
		try {
			await store.insertProfileSamples(ctx, samples);
			res.status(202).json({ profileId: samples[0]!.profileId, samples: samples.length });
		} catch (err) { storageError(res, err); }
	});

	app.post("/v1/sourcemaps", async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		const sourceMap = validateSourceMap(req.body);
		if (!sourceMap) { res.status(400).json({ error: "invalid source map" }); return; }
		try { await store.insertSourceMap(ctx, sourceMap); res.status(202).json({ accepted: true }); }
		catch (err) { storageError(res, err); }
	});

	/** ECS/Kubernetes event forwarders use the same server key as OTLP. */
	app.post("/v1/platform-events", async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		const parsed = platformEventSchema.safeParse(req.body);
		if (!parsed.success) { res.status(400).json({ error: "invalid platform event" }); return; }
		const event = normalizePlatformEvent(parsed.data);
		if (!event) { res.status(400).json({ error: "event timestamp outside retention window" }); return; }
		try { await store.insertPlatformEvent(ctx, event); res.status(202).json({ accepted: true }); }
		catch (err) { storageError(res, err); }
	});

	app.post("/v1/traces", async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		let request: OtlpTraceRequest;
		if (req.is("application/x-protobuf")) {
			try {
				request = decodeTraceRequest(req.body as Buffer);
			} catch {
				res.status(400).json({ error: "invalid protobuf payload" });
				return;
			}
		} else {
			request = req.body as OtlpTraceRequest;
		}
		const { occurrences, spans, metricPoints, llmCalls } =
			normalizeTraces(request);
		const fingerprinted = fingerprintAll(ctx, occurrences);
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
				store.insertOccurrences(ctx, fingerprinted),
				store.insertSpans(ctx, spans),
				store.insertMetricPoints(ctx, metricPoints),
				store.insertLlmCalls(ctx, llmCalls),
			]);
		} catch (err) {
			storageError(res, err);
			return;
		}
		sink?.enqueue(ctx, fingerprinted, metricPoints, llmCalls);
		recordSdks(ctx, request);
		otlpSuccess(req, res);
	});

	app.post("/v1/logs", async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		let logs;
		let logsRequest: OtlpLogsRequest;
		try {
			logsRequest = req.is("application/x-protobuf") ? decodeLogsRequest(req.body as Buffer) : req.body as OtlpLogsRequest;
			logs = normalizeLogs(logsRequest);
		}
		catch { res.status(400).json({ error: "invalid OTLP logs payload" }); return; }
		try { await store.insertLogs(ctx, logs); }
		catch (err) { storageError(res, err); return; }
		recordSdks(ctx, logsRequest);
		// Logs are diagnostic evidence. Exceptions and failed outcomes use the trace sink,
		// so one operation does not create duplicate issues through two export paths.
		otlpSuccess(req, res);
	});

	app.post("/v1/metrics", async (req, res) => {
		const ctx = await authenticate(req, res, "otlp");
		if (!ctx) return;
		let request: OtlpMetricsRequest;
		if (req.is("application/x-protobuf")) {
			try {
				request = decodeMetricsRequest(req.body as Buffer);
			} catch {
				res.status(400).json({ error: "invalid protobuf payload" });
				return;
			}
		} else {
			request = req.body as OtlpMetricsRequest;
		}
		const metricPoints = normalizeMetrics(request);
		const memorySamples = normalizeMemoryMetrics(request);
		try {
			await store.insertLatencyHistograms(ctx, normalizeLatencyHistograms(request));
			await store.insertMetricPoints(ctx, metricPoints);
			await store.insertMemorySamples(ctx, memorySamples);
		} catch (err) {
			storageError(res, err);
			return;
		}
		sink?.enqueue(ctx, [], metricPoints);
		recordSdks(ctx, request);
		otlpSuccess(req, res);
	});

	app.post("/v1/browser", async (req, res) => {
		const ctx = await authenticate(req, res, "browser");
		if (!ctx) return;
		let body: unknown = req.body;
		if (typeof body === "string") {
			// text/plain from a cross-origin sendBeacon — see CORS note above.
			try {
				body = JSON.parse(body);
			} catch {
				res.status(400).json({ error: "invalid json" });
				return;
			}
		}
		const parsed = browserPayloadSchema.safeParse(body);
		if (!parsed.success) {
			res.status(400).json({
				error: "invalid payload",
				issues: parsed.error.issues.slice(0, 5),
			});
			return;
		}
		const { occurrences, metricPoints } = normalizeBrowserPayload(parsed.data);
		const fingerprinted = fingerprintAll(ctx, occurrences);
		try {
			await Promise.all([
				store.insertOccurrences(ctx, fingerprinted),
				store.insertMetricPoints(ctx, metricPoints),
			]);
		} catch (err) {
			storageError(res, err);
			return;
		}
		sink?.enqueue(ctx, fingerprinted, metricPoints);
		if (parsed.data.sdk) {
			void sdkVersions.observe(ctx, [{
				service: parsed.data.service,
				environment: parsed.data.environment,
				sdkName: BROWSER_SDK_NAME,
				sdkVersion: parsed.data.sdk,
				sdkLanguage: "webjs",
			}]);
		}
		void reportIngesterInfo();
		res.status(202).json({ accepted: fingerprinted.length });
	});

	// Body-parser errors (oversized/malformed JSON) → clean 4xx, not a stack.
	app.use(
		(
			err: Error & { type?: string; status?: number },
			_req: Request,
			res: Response,
			next: (err?: Error) => void,
		) => {
			if (res.headersSent) return next(err);
			if (err.type === "entity.too.large") {
				res.status(413).json({ error: "payload too large" });
				return;
			}
			if (err.status && err.status < 500) {
				res.status(err.status).json({ error: "bad request" });
				return;
			}
			console.error("unhandled error:", err);
			res.status(500).json({ error: "internal error" });
		},
	);

	return { app, store, sink, reportIngesterInfo };
}
