import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
	AggregationTemporality,
	type InstrumentType,
	type PushMetricExporter,
	type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { noteIngestRefusal } from "./ingest-auth.js";

/**
 * Wraps each OTLP exporter initAutterServer builds (inside redaction):
 *
 * - with no ingest key, nothing leaves the process (the batch is failed
 *   locally; the startup warning already said why);
 * - a refusal (401/403/404/400…) is logged once with the ingester's
 *   reason (ingest-auth.ts) instead of vanishing into OTel's `diag`;
 * - a span batch refused as too large (413) is split in half and each half
 *   sent again, down to single spans, so an error storm is not dropped
 *   whole. Only a single span that is still too large is dropped (and
 *   reported once a minute by the GuardedSpanExporter around this one).
 */

/** Halvings of one batch at most: 2^12 spans, far more than a batch holds. */
const MAX_SPLITS = 12;

/** OTLPExporterError carries the HTTP status in `code` and the body in `data`. */
function refusalOf(result: ExportResult): { status: number; body: unknown } | null {
	if (result.code === ExportResultCode.SUCCESS) return null;
	const error = result.error as { code?: unknown; data?: unknown } | undefined;
	return typeof error?.code === "number" ? { status: error.code, body: error.data } : null;
}

const NO_KEY: ExportResult = {
	code: ExportResultCode.FAILED,
	error: new Error("no Autter ingest key: not sent (set AUTTER_RUNTIME_KEY)"),
};

function observe(endpoint: string, route: string, callback: (result: ExportResult) => void) {
	return (result: ExportResult) => {
		const refusal = refusalOf(result);
		if (refusal) noteIngestRefusal({ ...refusal, endpoint, route });
		callback(result);
	};
}

export class IngestSpanExporter implements SpanExporter {
	constructor(
		private readonly inner: SpanExporter,
		private readonly target: { endpoint: string; hasKey: boolean },
	) {}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		if (!this.target.hasKey) {
			resultCallback(NO_KEY);
			return;
		}
		this.send(spans, 0, observe(this.target.endpoint, "/v1/traces", resultCallback));
	}

	private send(spans: ReadableSpan[], depth: number, done: (result: ExportResult) => void): void {
		this.inner.export(spans, (result) => {
			if (spans.length < 2 || depth >= MAX_SPLITS || refusalOf(result)?.status !== 413) return done(result);
			// Too large for the ingester: send each half on its own, one after
			// the other, and answer once for the whole batch (the first failure,
			// if any half failed).
			const middle = Math.ceil(spans.length / 2);
			this.send(spans.slice(0, middle), depth + 1, (first) =>
				this.send(spans.slice(middle), depth + 1, (second) =>
					done(first.code !== ExportResultCode.SUCCESS ? first : second),
				),
			);
		});
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve();
	}
}

export class IngestMetricExporter implements PushMetricExporter {
	constructor(
		private readonly inner: PushMetricExporter,
		private readonly target: { endpoint: string; hasKey: boolean },
	) {}

	export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
		if (!this.target.hasKey) {
			resultCallback(NO_KEY);
			return;
		}
		this.inner.export(metrics, observe(this.target.endpoint, "/v1/metrics", resultCallback));
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush();
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}

	selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
		return this.inner.selectAggregationTemporality
			? this.inner.selectAggregationTemporality(instrumentType)
			: AggregationTemporality.CUMULATIVE;
	}
}
