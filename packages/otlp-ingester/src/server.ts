import express, {
	type Express,
	type Request,
	type Response,
} from "express";
import { KeyResolver, RateLimiter } from "./auth.js";
import { ClickHouseStore } from "./clickhouse.js";
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
import { decodeMetricsRequest, decodeTraceRequest } from "./otlp-proto.js";
import { SinkForwarder } from "./sink.js";
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
}

export function createIngesterApp(config: IngesterConfig): IngesterApp {
	const store = new ClickHouseStore(config);
	// Fingerprinted occurrences feed the consumer's issue grouping, metric
	// points feed the request/error-rate rollups, LLM calls feed spend
	// watching. Delivery is at-least-once with bounded retries — see sink.ts.
	const sink = config.sinkUrl ? new SinkForwarder(config) : null;
	const keys = new KeyResolver(config);
	const serverRateLimiter = new RateLimiter(config.rateLimitPerMinute);
	const clientRateLimiter = new RateLimiter(config.clientRateLimitPerMinute);

	const app = express();
	app.disable("x-powered-by");
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

	/** Auth + scope + rate limit; returns null (response sent) on failure. */
	async function authenticate(
		req: Request,
		res: Response,
		surface: "otlp" | "browser",
		bodyKey?: string,
	): Promise<IngestContext | null> {
		// A storage-less ingester must refuse, not accept-and-drop: exporters
		// retry on 503, so telemetry survives a misconfigured deploy.
		if (!store.configured) {
			res.status(503).json({ error: "storage not configured" });
			return null;
		}
		const key = bodyKey || keys.extractKey(req);
		if (!key) {
			res.status(401).json({ error: "missing ingest key" });
			return null;
		}
		const ctx = await keys.resolve(key);
		if (!ctx) {
			res.status(401).json({ error: "invalid ingest key" });
			return null;
		}
		if (bodyKey && ctx.scope !== "client") {
			res
				.status(403)
				.json({ error: "payload keys must be publishable client keys" });
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
		return inputs.map((input, index) => {
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
		try {
			await store.insertMetricPoints(ctx, metricPoints);
		} catch (err) {
			storageError(res, err);
			return;
		}
		sink?.enqueue(ctx, [], metricPoints);
		otlpSuccess(req, res);
	});

	app.post("/v1/browser", async (req, res) => {
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
		const bodyKey =
			typeof body === "object" && body !== null && "clientKey" in body &&
			typeof (body as { clientKey?: unknown }).clientKey === "string"
				? (body as { clientKey: string }).clientKey
				: undefined;
		const ctx = await authenticate(req, res, "browser", bodyKey);
		if (!ctx) return;
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

	return { app, store, sink };
}
