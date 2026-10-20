import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { Resource } from "@opentelemetry/resources";
import {
	AggregationTemporality,
	type InstrumentType,
	type PushMetricExporter,
	type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Redactor } from "./redact.js";
import { makeUrlQueryPolicy, type UrlQueryPolicy } from "./url-query.js";

/**
 * Last line of defence inside the customer's process: every span is
 * scrubbed on its way to the OTLP exporter, whoever produced it. Capture
 * calls (captureException, withLlmCall, …) already redact what they write,
 * but spans also carry data the SDK never sees at capture time:
 *
 * - `span.recordException(err)` from HttpInstrumentation, the customer's
 *   own code, or third-party instrumentations — raw message + stack;
 * - `http.url` / `http.target` / `url.full` with `?token=` query strings —
 *   and query strings in general: values are dropped (url-query.ts);
 * - request headers when the host enables `headersToSpanAttributes`;
 * - span status messages copied from `err.message`;
 * - link attributes and event names;
 * - resource attributes: NodeSDK's process detector adds
 *   `process.command_args` (`--db=postgres://user:pass@…`), and
 *   OTEL_RESOURCE_ATTRIBUTES can carry anything.
 *
 * The span is re-wrapped, never mutated (spans are shared with other
 * processors). `redactAttributes: false` disables the scrubbing but not the
 * query policy, which `keepQueryParams` tunes.
 */
/** One scrubbed copy per Resource object: the OTLP serializer groups spans
 * by resource identity, so a fresh copy per span would split the batch. */
const scrubbedResources = new WeakMap<object, Resource>();

function redactResource<R extends ReadableSpan["resource"]>(resource: R, redactor: Redactor): Resource {
	const cached = scrubbedResources.get(resource);
	if (cached) return cached;
	const scrubbed = new Resource(redactor.exported(resource.attributes));
	scrubbedResources.set(resource, scrubbed);
	return scrubbed;
}

const DEFAULT_QUERY_POLICY = makeUrlQueryPolicy();

/** Query policy only (`redactAttributes: false`): name and attributes. */
function stripQueries(span: ReadableSpan, query: UrlQueryPolicy): ReadableSpan {
	const name = query.name(span.name);
	const attributes = query.attributes(span.attributes);
	if (name === span.name && attributes === span.attributes) return span;
	return wrap(span, { name, attributes });
}

function wrap(
	span: ReadableSpan,
	fields: Pick<ReadableSpan, "name" | "attributes"> & Partial<Pick<ReadableSpan, "status" | "links" | "events" | "resource">>,
): ReadableSpan {
	return {
		name: fields.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanId: span.parentSpanId,
		startTime: span.startTime,
		endTime: span.endTime,
		status: fields.status ?? span.status,
		attributes: fields.attributes,
		links: fields.links ?? span.links,
		events: fields.events ?? span.events,
		duration: span.duration,
		ended: span.ended,
		resource: fields.resource ?? span.resource,
		instrumentationLibrary: span.instrumentationLibrary,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	};
}

export function redactSpan(
	span: ReadableSpan,
	redactor: Redactor,
	query: UrlQueryPolicy = DEFAULT_QUERY_POLICY,
): ReadableSpan {
	if (!redactor.enabled) return stripQueries(span, query);
	const status = span.status.message
		? { ...span.status, message: redactor.text(span.status.message) }
		: span.status;
	// Scrub first (a `user:pass@` URL is recognised whole), then cut queries.
	return wrap(span, {
		name: query.name(redactor.text(span.name)),
		status,
		attributes: query.attributes(redactor.exported(span.attributes)),
		links: span.links.map((link) =>
			link.attributes ? { ...link, attributes: redactor.exported(link.attributes) } : link,
		),
		events: span.events.map((event) => ({
			...event,
			name: redactor.text(event.name),
			...(event.attributes ? { attributes: redactor.exported(event.attributes) } : {}),
		})),
		resource: redactResource(span.resource, redactor),
	});
}

export class RedactingSpanExporter implements SpanExporter {
	constructor(
		private readonly inner: SpanExporter,
		private readonly redactor: () => Redactor,
		private readonly query: UrlQueryPolicy = DEFAULT_QUERY_POLICY,
	) {}

	export(
		spans: ReadableSpan[],
		resultCallback: (result: ExportResult) => void,
	): void {
		const redactor = this.redactor();
		const scrubbed: ReadableSpan[] = [];
		let failed = 0;
		for (const span of spans) {
			try {
				scrubbed.push(redactSpan(span, redactor, this.query));
			} catch {
				// Fail closed: a span we could not scrub is not exported.
				failed++;
			}
		}
		if (!failed) {
			this.inner.export(scrubbed, resultCallback);
			return;
		}
		// Report the batch as failed rather than letting the processor believe
		// every span was delivered.
		const error = new Error(`autter-runtime: ${failed} span(s) could not be redacted and were not exported`);
		const fail = () => resultCallback({ code: ExportResultCode.FAILED, error });
		if (!scrubbed.length) {
			fail();
			return;
		}
		this.inner.export(scrubbed, (result) =>
			result.code === ExportResultCode.SUCCESS ? fail() : resultCallback(result),
		);
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve();
	}
}

/**
 * Metrics carry the same resource as spans (process.command_args,
 * OTEL_RESOURCE_ATTRIBUTES), so their resource is scrubbed the same way.
 * Data-point attributes are the SDK's own low-cardinality HTTP attributes.
 */
export class RedactingMetricExporter implements PushMetricExporter {
	constructor(
		private readonly inner: PushMetricExporter,
		private readonly redactor: () => Redactor,
	) {}

	export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
		const redactor = this.redactor();
		if (!redactor.enabled) {
			this.inner.export(metrics, resultCallback);
			return;
		}
		let resource: ResourceMetrics["resource"];
		try {
			resource = redactResource(metrics.resource, redactor);
		} catch (error) {
			resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
			return;
		}
		this.inner.export({ ...metrics, resource }, resultCallback);
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
