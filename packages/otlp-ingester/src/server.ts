import { randomUUID } from "node:crypto";
import express, {
	type Express,
	type Request,
	type Response,
} from "express";
import { KeyResolver, RateLimiter } from "./auth.js";
import { ClickHouseStore } from "./clickhouse.js";
import type { IngesterConfig } from "./config.js";
import { fingerprintOccurrence } from "./fingerprint.js";
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
	const rateLimiter = new RateLimiter(config.rateLimitPerMinute);

	const app = express();
	app.disable("x-powered-by");
	app.use(
		express.json({
			limit: config.maxBodyBytes,
			type: ["application/json"],
		}),
	);

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

	/** Auth + rate limit; returns null (response already sent) on failure. */
	async function authenticate(
		req: Request,
		res: Response,
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
		if (!rateLimiter.allow(key)) {
			res.status(429).json({ error: "rate limit exceeded" });
			return null;
		}
		const ctx = await keys.resolve(key);
		if (!ctx) {
			res.status(401).json({ error: "invalid ingest key" });
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

	app.post("/v1/traces", async (req, res) => {
		const ctx = await authenticate(req, res);
		if (!ctx) return;
		const { occurrences, spans, metricPoints } = normalizeTraces(
			req.body as OtlpTraceRequest,
		);
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
		// OTLP/HTTP success response: an empty partialSuccess object.
		res.status(200).json({ partialSuccess: {} });
	});

	app.post("/v1/metrics", async (req, res) => {
		const ctx = await authenticate(req, res);
		if (!ctx) return;
		const metricPoints = normalizeMetrics(req.body as OtlpMetricsRequest);
		try {
			await store.insertMetricPoints(ctx, metricPoints);
		} catch (err) {
			storageError(res, err);
			return;
		}
		res.status(200).json({ partialSuccess: {} });
	});

	app.post("/v1/browser", async (req, res) => {
		const ctx = await authenticate(req, res);
		if (!ctx) return;
		const parsed = browserPayloadSchema.safeParse(req.body);
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
