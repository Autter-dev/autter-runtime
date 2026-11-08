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
 *   reason (ingest-auth.ts) instead of vanishing into OTel's `diag`.
 */

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
		this.inner.export(spans, observe(this.target.endpoint, "/v1/traces", resultCallback));
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
