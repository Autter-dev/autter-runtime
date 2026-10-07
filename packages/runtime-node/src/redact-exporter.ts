import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Redactor } from "./redact.js";

/**
 * Last line of defence inside the customer's process: every span is
 * scrubbed on its way to the OTLP exporter, whoever produced it. Capture
 * calls (captureException, withLlmCall, …) already redact what they write,
 * but spans also carry data the SDK never sees at capture time:
 *
 * - `span.recordException(err)` from HttpInstrumentation, the customer's
 *   own code, or third-party instrumentations — raw message + stack;
 * - `http.url` / `http.target` / `url.full` with `?token=` query strings;
 * - request headers when the host enables `headersToSpanAttributes`;
 * - span status messages copied from `err.message`.
 *
 * The span is re-wrapped, never mutated (spans are shared with other
 * processors). Disabled when the host passes `redactAttributes: false`.
 */
export function redactSpan(span: ReadableSpan, redactor: Redactor): ReadableSpan {
	const status = span.status.message
		? { ...span.status, message: redactor.text(span.status.message) }
		: span.status;
	return {
		name: redactor.text(span.name),
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanId: span.parentSpanId,
		startTime: span.startTime,
		endTime: span.endTime,
		status,
		attributes: redactor.exported(span.attributes),
		links: span.links,
		events: span.events.map((event) =>
			event.attributes
				? { ...event, attributes: redactor.exported(event.attributes) }
				: event,
		),
		duration: span.duration,
		ended: span.ended,
		resource: span.resource,
		instrumentationLibrary: span.instrumentationLibrary,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	};
}

export class RedactingSpanExporter implements SpanExporter {
	constructor(
		private readonly inner: SpanExporter,
		private readonly redactor: () => Redactor,
	) {}

	export(
		spans: ReadableSpan[],
		resultCallback: (result: ExportResult) => void,
	): void {
		const redactor = this.redactor();
		let scrubbed = spans;
		if (redactor.enabled) {
			scrubbed = [];
			for (const span of spans) {
				try {
					scrubbed.push(redactSpan(span, redactor));
				} catch {
					// Fail closed: a span we could not scrub is not exported.
				}
			}
		}
		this.inner.export(scrubbed, resultCallback);
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve();
	}
}
