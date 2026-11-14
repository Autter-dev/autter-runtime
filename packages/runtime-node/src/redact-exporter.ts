import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
	AggregationTemporality,
	type InstrumentType,
	type PushMetricExporter,
	type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { makeIdentifyingAttributeFilter, type IdentifyingAttributeFilter } from "@autter/runtime-core";
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
 * Identifying attributes (the client's IP address and port, the raw
 * user agent, host.id and the host's addresses, the command line and its owner: see
 * runtime-core's identifying.ts) are dropped from span, event and link
 * attributes and from the resource, unless `keepIdentifyingAttributes`
 * keeps them (and `dropAttributes` adds keys to drop).
 *
 * The span is re-wrapped, never mutated (spans are shared with other
 * processors). `redactAttributes: false` disables the scrubbing but neither
 * the query policy, which `keepQueryParams` tunes, nor the identifying
 * attribute drop, which `keepIdentifyingAttributes` tunes.
 */
/** One scrubbed copy per Resource object (per redactor and filter): the
 * OTLP serializer groups spans by resource identity, so a fresh copy per
 * span would split the batch. */
const scrubbedResources = new WeakMap<Redactor, WeakMap<IdentifyingAttributeFilter, WeakMap<object, Resource>>>();

function redactResource<R extends ReadableSpan["resource"]>(
	resource: R,
	redactor: Redactor,
	identifying: IdentifyingAttributeFilter,
): Resource {
	let byFilter = scrubbedResources.get(redactor);
	if (!byFilter) scrubbedResources.set(redactor, (byFilter = new WeakMap()));
	let cache = byFilter.get(identifying);
	if (!cache) byFilter.set(identifying, (cache = new WeakMap()));
	const cached = cache.get(resource);
	if (cached) return cached;
	const attributes = identifying.apply(resource.attributes);
	// Nothing to scrub or drop: the resource itself (keeps its schema URL).
	if (!redactor.enabled && attributes === resource.attributes) {
		cache.set(resource, resource);
		return resource;
	}
	const scrubbed = resourceFromAttributes(redactor.enabled ? redactor.exported(attributes) : attributes);
	cache.set(resource, scrubbed);
	return scrubbed;
}

const DEFAULT_QUERY_POLICY = makeUrlQueryPolicy();
const DEFAULT_IDENTIFYING = makeIdentifyingAttributeFilter();

/** Without scrubbing (`redactAttributes: false`): the query policy and the
 * identifying attribute drop only. */
function stripQueries(
	span: ReadableSpan,
	redactor: Redactor,
	query: UrlQueryPolicy,
	identifying: IdentifyingAttributeFilter,
): ReadableSpan {
	const name = query.name(span.name);
	const attributes = query.attributes(identifying.apply(span.attributes));
	let eventsChanged = false;
	const events = span.events.map((event) => {
		if (!event.attributes) return event;
		const kept = identifying.apply(event.attributes);
		if (kept === event.attributes) return event;
		eventsChanged = true;
		return { ...event, attributes: kept };
	});
	let linksChanged = false;
	const links = span.links.map((link) => {
		if (!link.attributes) return link;
		const kept = identifying.apply(link.attributes);
		if (kept === link.attributes) return link;
		linksChanged = true;
		return { ...link, attributes: kept };
	});
	const resource = redactResource(span.resource, redactor, identifying);
	if (
		name === span.name && attributes === span.attributes && !eventsChanged && !linksChanged
		&& resource === span.resource
	) return span;
	return wrap(span, {
		name,
		attributes,
		...(eventsChanged ? { events } : {}),
		...(linksChanged ? { links } : {}),
		resource,
	});
}

function wrap(
	span: ReadableSpan,
	fields: Pick<ReadableSpan, "name" | "attributes"> & Partial<Pick<ReadableSpan, "status" | "links" | "events" | "resource">>,
): ReadableSpan {
	return {
		name: fields.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		status: fields.status ?? span.status,
		attributes: fields.attributes,
		links: fields.links ?? span.links,
		events: fields.events ?? span.events,
		duration: span.duration,
		ended: span.ended,
		resource: fields.resource ?? span.resource,
		instrumentationScope: span.instrumentationScope,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	};
}

export function redactSpan(
	span: ReadableSpan,
	redactor: Redactor,
	query: UrlQueryPolicy = DEFAULT_QUERY_POLICY,
	identifying: IdentifyingAttributeFilter = DEFAULT_IDENTIFYING,
): ReadableSpan {
	if (!redactor.enabled) return stripQueries(span, redactor, query, identifying);
	const status = span.status.message
		? { ...span.status, message: redactor.text(span.status.message) }
		: span.status;
	// Drop identifying keys, scrub (a `user:pass@` URL is recognised whole),
	// then cut queries.
	return wrap(span, {
		name: query.name(redactor.text(span.name)),
		status,
		attributes: query.attributes(redactor.exported(identifying.apply(span.attributes))),
		links: span.links.map((link) =>
			link.attributes ? { ...link, attributes: redactor.exported(identifying.apply(link.attributes)) } : link,
		),
		events: span.events.map((event) => ({
			...event,
			name: redactor.text(event.name),
			...(event.attributes ? { attributes: redactor.exported(identifying.apply(event.attributes)) } : {}),
		})),
		resource: redactResource(span.resource, redactor, identifying),
	});
}

export class RedactingSpanExporter implements SpanExporter {
	constructor(
		private readonly inner: SpanExporter,
		private readonly redactor: () => Redactor,
		private readonly query: UrlQueryPolicy = DEFAULT_QUERY_POLICY,
		private readonly identifying: IdentifyingAttributeFilter = DEFAULT_IDENTIFYING,
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
				scrubbed.push(redactSpan(span, redactor, this.query, this.identifying));
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
 * host.id, OTEL_RESOURCE_ATTRIBUTES), so their resource is scrubbed and
 * loses its identifying attributes the same way (the drop also with
 * `redactAttributes: false`). Data-point attributes are the SDK's own
 * low-cardinality HTTP attributes.
 */
export class RedactingMetricExporter implements PushMetricExporter {
	constructor(
		private readonly inner: PushMetricExporter,
		private readonly redactor: () => Redactor,
		private readonly identifying: IdentifyingAttributeFilter = DEFAULT_IDENTIFYING,
	) {}

	export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
		const redactor = this.redactor();
		let resource: ResourceMetrics["resource"];
		try {
			resource = redactResource(metrics.resource, redactor, this.identifying);
		} catch (error) {
			resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
			return;
		}
		this.inner.export(resource === metrics.resource ? metrics : { ...metrics, resource }, resultCallback);
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
