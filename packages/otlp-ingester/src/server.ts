import { randomUUID } from "node:crypto";
import express, {
	type Express,
	type Request,
	type Response,
} from "express";
import { KeyResolver, RateLimiter } from "./auth.js";
import { ClickHouseStore } from "./clickhouse.js";
import type { IngesterConfig } from "./config.js";
import { deriveFields, fingerprintOccurrence } from "./fingerprint.js";
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
import type {
	IngestContext,
	RuntimeOccurrence,
	RuntimeOccurrenceInput,
} from "./types.js";

export interface IngesterApp {
	app: Express;
	store: ClickHouseStore;
}

export function createIngesterApp(config: IngesterConfig): IngesterApp {
	const store = new ClickHouseStore(config);
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
		if (!store.configured) {
			res.status(200).json({ ok: true, clickhouse: "unconfigured" });
			return;
		}
		try {
			const ok = await store.ping();
			res.status(ok ? 200 : 503).json({ ok, clickhouse: ok ? "up" : "down" });
		} catch {
			res.status(503).json({ ok: false, clickhouse: "down" });
		}
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

	function fingerprintAll(
		inputs: RuntimeOccurrenceInput[],
	): RuntimeOccurrence[] {
		return inputs.map((input) => ({
			...input,
			occurrenceId: randomUUID(),
			fingerprint: fingerprintOccurrence(input),
			...deriveFields(input),
		}));
	}

	/** Best-effort forward of fingerprinted occurrences for issue grouping. */
	function forwardToSink(ctx: IngestContext, occurrences: RuntimeOccurrence[]) {
		if (!config.sinkUrl || occurrences.length === 0) return;
		void fetch(config.sinkUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(config.sinkToken
					? { authorization: `Bearer ${config.sinkToken}` }
					: {}),
			},
			body: JSON.stringify({
				version: 1,
				orgId: ctx.orgId,
				repositoryId: ctx.repositoryId,
				occurrences: occurrences.map((o) => ({
					...o,
					occurredAt: o.occurredAt.toISOString(),
				})),
			}),
			signal: AbortSignal.timeout(10_000),
		}).catch((err) => {
			console.warn("sink forward failed (non-fatal):", err?.message ?? err);
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
		const { occurrences, spans, metricPoints } = normalizeTraces(request);
		const fingerprinted = fingerprintAll(occurrences);
		try {
			await Promise.all([
				store.insertOccurrences(ctx, fingerprinted),
				store.insertSpans(ctx, spans),
				store.insertMetricPoints(ctx, metricPoints),
			]);
		} catch (err) {
			storageError(res, err);
			return;
		}
		forwardToSink(ctx, fingerprinted);
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
		const fingerprinted = fingerprintAll(occurrences);
		try {
			await Promise.all([
				store.insertOccurrences(ctx, fingerprinted),
				store.insertMetricPoints(ctx, metricPoints),
			]);
		} catch (err) {
			storageError(res, err);
			return;
		}
		forwardToSink(ctx, fingerprinted);
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

	return { app, store };
}
