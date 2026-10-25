import { decodeOtlpAttributes, sanitizeRuntimeContext, type OtlpValue } from "./context.js";
import { liftErrorFields, validRequestId } from "./error-fields.js";
import { fingerprintOverrideOf } from "./fingerprint-override.js";
import { scrubText } from "./redact.js";
import { normalizeRoute } from "./fingerprint.js";
import { extractLlmCall } from "./llm.js";
import { BREADCRUMBS_ATTRIBUTE, breadcrumbsField } from "./breadcrumbs.js";
import { dedupeTraceSignals, hasAutterKey, hasNextContext, type TraceSignal } from "./trace-dedupe.js";
import { requestMembership, type RequestMembership } from "./request-spans.js";
import { histogramLatency, mergeLatency, requestLatency, type LatencySamples } from "./latency.js";
import {
	asSeverity,
	type RuntimeLlmCall,
	type RuntimeMetricPoint,
	type RuntimeOccurrenceInput,
	type RuntimeSeverity,
	type RuntimeSpanRow,
} from "./types.js";

const EMAIL_VALUE_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi;

/**
 * OTLP/HTTP JSON → runtime signal. Structural types cover only the fields
 * we read (the full OTLP schema is large and versioned; unknown fields pass
 * through untouched). Protobuf decode is Milestone 1 — see docs/PLAN.md.
 *
 * Note: OTLP/JSON encodes trace/span ids as hex strings and enum fields as
 * either numbers or `SPAN_KIND_*` / `STATUS_CODE_*` strings depending on the
 * serialiser — both are accepted.
 */

interface OtlpKeyValue {
	key?: string;
	value?: OtlpValue;
}

interface OtlpEvent {
	name?: string;
	timeUnixNano?: string | number;
	attributes?: OtlpKeyValue[];
}

interface OtlpSpan {
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	name?: string;
	kind?: number | string;
	startTimeUnixNano?: string | number;
	endTimeUnixNano?: string | number;
	attributes?: OtlpKeyValue[];
	status?: { code?: number | string; message?: string };
	events?: OtlpEvent[];
}

interface OtlpResource {
	attributes?: OtlpKeyValue[];
}

export interface OtlpTraceRequest {
	resourceSpans?: Array<{
		resource?: OtlpResource;
		scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
	}>;
}

interface OtlpDataPoint {
	attributes?: OtlpKeyValue[];
	startTimeUnixNano?: string | number;
	timeUnixNano?: string | number;
	explicitBounds?: number[];
	bucketCounts?: Array<string | number>;
	count?: string | number;
	sum?: number;
	asInt?: string | number;
	asDouble?: number;
}

export interface OtlpMetricsRequest {
	resourceMetrics?: Array<{
		resource?: OtlpResource;
		scopeMetrics?: Array<{
			metrics?: Array<{
				name?: string;
				unit?: string;
				gauge?: { dataPoints?: OtlpDataPoint[] };
				histogram?: {
					dataPoints?: OtlpDataPoint[];
					aggregationTemporality?: string | number;
				};
				sum?: { dataPoints?: OtlpDataPoint[]; aggregationTemporality?: string | number };
			}>;
		}>;
	}>;
}

function attrMap(attributes: OtlpKeyValue[] | undefined): Map<string, string> {
	const map = new Map<string, string>();
	for (const attr of attributes ?? []) {
		if (!attr.key || !attr.value) continue;
		const v = attr.value;
		const value =
			v.stringValue ??
			(v.intValue !== undefined ? String(v.intValue) : undefined) ??
			(v.doubleValue !== undefined ? String(v.doubleValue) : undefined) ??
			(v.boolValue !== undefined ? String(v.boolValue) : undefined);
		if (value !== undefined) map.set(attr.key, value);
	}
	return map;
}

function nanosToDate(nanos: string | number | undefined): Date {
	if (nanos === undefined) return new Date();
	const ms = Number(BigInt(String(nanos)) / 1_000_000n);
	return new Date(ms);
}

function spanDurationMs(span: OtlpSpan): number {
	if (span.startTimeUnixNano === undefined || span.endTimeUnixNano === undefined) {
		return 0;
	}
	const nanos =
		BigInt(String(span.endTimeUnixNano)) - BigInt(String(span.startTimeUnixNano));
	return Math.max(0, Number(nanos) / 1_000_000);
}

function isErrorStatus(code: number | string | undefined): boolean {
	return code === 2 || code === "STATUS_CODE_ERROR";
}

/**
 * An error the app handled on purpose and recorded through Autter: a caught
 * error (`autter.handling = "caught"`, RF-01) or a deliberate fallback
 * (`"deliberate"`, RF-02). These are occurrences and issues, but they never
 * fail their span or request and never count in `error_count`. The bare
 * `autter.handled` marker (the opt-in V8 sampler) keeps its old meaning and
 * still counts.
 */
function softlyHandled(handling: unknown): boolean {
	return handling === "caught" || handling === "deliberate";
}

const SPAN_KINDS: Record<string, string> = {
	"0": "unspecified",
	"1": "internal",
	"2": "server",
	"3": "client",
	"4": "producer",
	"5": "consumer",
};

function spanKind(kind: number | string | undefined): string {
	if (kind === undefined) return "internal";
	if (typeof kind === "string" && kind.startsWith("SPAN_KIND_")) {
		return kind.slice("SPAN_KIND_".length).toLowerCase();
	}
	return SPAN_KINDS[String(kind)] ?? "internal";
}

interface ResourceInfo {
	service: string;
	environment: string;
	release: string | null;
	/** `autter.metrics_wired` and `autter.metrics_routes` (runtime-node
	 * 1.7.0+): the sender's delta HTTP-server duration histograms
	 * (`/v1/metrics`) count every request it serves, and each request span
	 * whose data point carries `http.route` says so
	 * (`autter.metric_has_route`). Those requests are counted from the
	 * metric alone: their spans would count them twice. `metrics_wired`
	 * alone (runtime-node before 1.7.0, whose Next.js metrics have no route)
	 * is not enough: its spans keep feeding per-route request counts. */
	metricsCountRoutedRequests: boolean;
	/** `autter.metrics_wired`: a metric feed counts this sender's requests
	 * (and their 5xx), so a request its error-linked tail retention exported
	 * is counted there. */
	metricsWired: boolean;
	/** One process: spans of different processes are never one request. */
	process: string;
}

function resourceInfo(resource: OtlpResource | undefined): ResourceInfo {
	const attrs = attrMap(resource?.attributes);
	const service = attrs.get("service.name") ?? "unknown";
	const environment =
		attrs.get("deployment.environment.name") ??
		attrs.get("deployment.environment") ??
		"production";
	const release = attrs.get("service.version") ?? null;
	return {
		service,
		environment,
		release,
		metricsCountRoutedRequests:
			attrs.get("autter.metrics_wired") === "true" && attrs.get("autter.metrics_routes") === "true",
		metricsWired: attrs.get("autter.metrics_wired") === "true",
		process: [service, environment, release ?? "", attrs.get("service.instance.id") ?? ""].join("\u0000"),
	};
}

function routeOf(attrs: Map<string, string>): string | null {
	const route =
		attrs.get("http.route") ??
		attrs.get("url.path") ??
		attrs.get("http.target") ??
		null;
	return route ? (route.split("?")[0] ?? null) : null;
}

/** How good a request name `routeOf` found: 2 for a route template
 * (`http.route`), 1 for a raw path (`url.path` / `http.target`), 0 for none. */
function routeQualityOf(attrs: Map<string, string>, route: string | null): number {
	if (!route) return 0;
	return attrs.has("http.route") ? 2 : 1;
}

function statusCodeOf(attrs: Map<string, string>): number | null {
	const raw =
		attrs.get("http.response.status_code") ?? attrs.get("http.status_code");
	if (!raw) return null;
	const code = Number.parseInt(raw, 10);
	return Number.isFinite(code) ? code : null;
}

function methodOf(attrs: Map<string, string>): string | null {
	const raw = attrs.get("http.request.method") ?? attrs.get("http.method");
	return raw ? raw.toUpperCase().slice(0, 16) : null;
}

/**
 * Severity of an exception event. SDKs mark it with `autter.severity`
 * ("fatal" | "error" | "warning" | "info"); `autter.unhandled: true` (the
 * crash marker set by @autter/runtime-node) implies fatal. Default: error.
 */
function severityOf(
	eventAttrs: Map<string, string>,
	spanAttrs: Map<string, string>,
): RuntimeSeverity {
	const explicit =
		eventAttrs.get("autter.severity") ?? spanAttrs.get("autter.severity");
	const severity = asSeverity(explicit, "error");
	if (
		severity === "error" &&
		(eventAttrs.get("autter.unhandled") === "true" ||
			spanAttrs.get("autter.unhandled") === "true")
	) {
		return "fatal";
	}
	return severity;
}

export interface NormalizedTraces {
	/** One per thrown error: duplicate recordings across a trace's spans are
	 * merged and redundant status-only occurrences dropped (trace-dedupe.ts). */
	occurrences: RuntimeOccurrenceInput[];
	/** Each occurrence's position among every signal the batch recorded,
	 * before deduplication: the batch index its deterministic id is derived
	 * from, so a merge or a drop never shifts another occurrence's id. */
	occurrenceBatchIndexes: number[];
	spans: RuntimeSpanRow[];
	metricPoints: RuntimeMetricPoint[];
	llmCalls: RuntimeLlmCall[];
	spanCount: number;
}

const MAX_SPANS_PER_REQUEST = 5000;

export function normalizeTraces(request: OtlpTraceRequest): NormalizedTraces {
	const signals: TraceSignal[] = [];
	// Per signal: the span it was recorded on (its index in `spans`), and the
	// route its own event rollup keys on (before HTTP inheritance).
	const signalRollups: Array<{ spanIndex: number; route: string }> = [];
	const spans: RuntimeSpanRow[] = [];
	// Per span, what the request rollups need beyond the span row.
	const spanFacts: SpanFacts[] = [];
	const llmCalls: RuntimeLlmCall[] = [];
	const rollups = new Map<string, RuntimeMetricPoint>();
	let spanCount = 0;

	for (const resourceSpan of request.resourceSpans ?? []) {
		const resource = resourceInfo(resourceSpan.resource);
		for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
			for (const span of scopeSpan.spans ?? []) {
				if (spanCount >= MAX_SPANS_PER_REQUEST) break;
				spanCount += 1;

				const attrs = attrMap(span.attributes);
				const route = routeOf(attrs);
				const statusCode = statusCodeOf(attrs);
				const startedAt = nanosToDate(span.startTimeUnixNano);
				const durationMs = spanDurationMs(span);
				const kind = spanKind(span.kind);
				// An exception the app handled (`autter.handled`: caught and
				// logged, or a deliberate fallback) never fails its span.
				const hasFailureEvent = (span.events ?? []).some((event) =>
					(event.name === "exception" && !softlyHandled(attrMap(event.attributes).get("autter.handling")))
					|| (event.name === "autter.outcome"
						&& attrMap(event.attributes).get("autter.outcome.status") === "error"));
				const isError =
					statusCode !== null && statusCode >= 400 && statusCode < 500
						? hasFailureEvent
						: hasFailureEvent || isErrorStatus(span.status?.code) || (statusCode !== null && statusCode >= 500);

				spans.push({
					service: resource.service,
					environment: resource.environment,
					release: resource.release,
					traceId: span.traceId ?? "",
					spanId: span.spanId ?? "",
					parentSpanId: span.parentSpanId ?? null,
					name: scrubText(span.name ?? "unnamed").slice(0, 1000),
					kind,
					status: isError ? "error" : "ok",
					route: route ? normalizeRoute(route) : null,
					statusCode,
					durationMs,
					attributes: {
						...decodeOtlpAttributes(span.attributes),
						"http.request.method": (attrs.get("http.request.method") ?? attrs.get("http.method") ?? "").slice(0, 20),
					},
					startedAt,
				});
				spanFacts.push({
					process: resource.process,
					routeQuality: routeQualityOf(attrs, route),
					// Who counts this span's request, as its outermost server
					// span: see countedBy.
					countedBy: countedBy(resource, attrs),
					templateRoute: attrs.has("http.route") && route ? normalizeRoute(route) : "",
				});

				// Error signals: one per exception event; if the span is
				// errored without exception events, one from the span status.
				// They become occurrences after the batch-wide dedupe below.
				const traceId = span.traceId ?? "";
				const spanId = span.spanId ?? "";
				const rollup = { spanIndex: spans.length - 1, route: route ?? "" };
				const spanAutter = attrs.has("autter.severity");
				const exceptionEvents = (span.events ?? []).filter(
					(event) => event.name === "exception",
				);
				for (const event of exceptionEvents) {
					const eventAttrs = attrMap(event.attributes);
					const handled = eventAttrs.get("autter.handled") === "true";
					const eventAutter = hasAutterKey(eventAttrs);
					signalRollups.push(rollup);
					signals.push({
						traceId,
						spanId,
						signal: "exception",
						autterCapture: eventAutter || spanAutter,
						eventAutter,
						nextContext: hasNextContext(eventAttrs, attrs),
						handled,
						occurrence: {
							source: "server",
							severity: severityOf(eventAttrs, attrs),
							service: resource.service,
							environment: resource.environment,
							release: resource.release,
							errorType: eventAttrs.get("exception.type") ?? "Error",
							message:
								eventAttrs.get("exception.message") ??
								span.status?.message ??
								span.name ??
								"Unknown error",
							stack: eventAttrs.get("exception.stacktrace") ?? null,
							route,
							method: methodOf(attrs),
							statusCode,
							traceId: span.traceId ?? null,
							sessionId: null,
							attributes: sanitizeRuntimeContext({ ...decodeOtlpAttributes(span.attributes), ...decodeOtlpAttributes(event.attributes),
								...(handled ? { "autter.handled": true, ...(eventAttrs.has("autter.sampled") ? { "autter.sampled": eventAttrs.get("autter.sampled") === "true" } : {}) } : {}) }),
							occurredAt: nanosToDate(event.timeUnixNano ?? span.startTimeUnixNano),
							// Event attributes first: one span can carry several
							// exceptions, each with its own code.
							...liftErrorFields(eventAttrs, attrs),
							...breadcrumbsField(eventAttrs.get(BREADCRUMBS_ATTRIBUTE), attrs.get(BREADCRUMBS_ATTRIBUTE)),
							...fingerprintOverrideOf(eventAttrs.get("autter.fingerprint") ?? attrs.get("autter.fingerprint")),
						},
					});
				}
				const failedOutcomes = (span.events ?? []).filter((event) => {
					if (event.name !== "autter.outcome") return false;
					return attrMap(event.attributes).get("autter.outcome.status") === "error";
				});
				for (const event of failedOutcomes) {
					const outcome = attrMap(event.attributes);
					const name = (outcome.get("autter.outcome.name") ?? "operation").replace(EMAIL_VALUE_RE, "[redacted]").slice(0, 200);
					signalRollups.push(rollup);
					signals.push({
						traceId,
						spanId,
						signal: "outcome",
						autterCapture: true,
						eventAutter: true,
						nextContext: hasNextContext(outcome, attrs),
						handled: false,
						occurrence: {
							source: "server", severity: "error", service: resource.service,
							environment: resource.environment, release: resource.release,
							errorType: "OutcomeFailure",
							message: `${name}: ${(outcome.get("autter.outcome.message") ?? "failed").replace(EMAIL_VALUE_RE, "[redacted]").slice(0, 1000)}`,
							stack: String(decodeOtlpAttributes(event.attributes)["autter.outcome.stack"] ?? "") || null, route, method: methodOf(attrs), statusCode,
							traceId: span.traceId ?? null, sessionId: null,
							attributes: sanitizeRuntimeContext({ ...decodeOtlpAttributes(span.attributes), ...decodeOtlpAttributes(event.attributes) }),
							occurredAt: nanosToDate(event.timeUnixNano ?? span.startTimeUnixNano),
							...liftErrorFields(outcome, attrs),
						},
					});
				}
				if (exceptionEvents.length === 0 && failedOutcomes.length === 0 && isError) {
					signalRollups.push(rollup);
					signals.push({
						traceId,
						spanId,
						signal: "status",
						autterCapture: spanAutter,
						eventAutter: false,
						nextContext: hasNextContext(attrs),
						handled: false,
						occurrence: {
							source: "server",
							severity: severityOf(new Map(), attrs),
							service: resource.service,
							environment: resource.environment,
							release: resource.release,
							errorType: statusCode !== null && statusCode >= 500 ? "HttpServerError" : "SpanError",
							message: span.status?.message || (statusCode !== null && statusCode >= 500
								? `${methodOf(attrs) ?? "HTTP"} ${route ?? span.name ?? "request"} returned ${statusCode}`
								: `${span.name ?? "span"} failed`),
							stack: null,
							route,
							method: methodOf(attrs),
							statusCode,
							traceId: span.traceId ?? null,
							sessionId: null,
							attributes: decodeOtlpAttributes(span.attributes),
							occurredAt: startedAt,
							...liftErrorFields(attrs),
						},
					});
				}

				// LLM provider calls (GenAI semconv, Vercel AI SDK telemetry,
				// or Autter's own helpers) become usage/cost rows. The first
				// exception event's type rides along so failed calls keep the
				// provider error class even without an `error.type` attribute.
				const llmCall = extractLlmCall(attrs, {
					name: span.name ?? "",
					traceId: span.traceId ?? "",
					spanId: span.spanId ?? "",
					isError,
					exceptionType: exceptionEvents[0]
						? (attrMap(exceptionEvents[0].attributes).get("exception.type") ??
							null)
						: null,
					durationMs,
					startedAt,
					service: resource.service,
					environment: resource.environment,
					release: resource.release,
				});
				if (llmCall) llmCalls.push(llmCall);
			}
		}
	}

	// One occurrence per thrown error: recordings of one error on several
	// spans of a trace merge, and status-only occurrences an error on their
	// span chain explains are dropped (trace-dedupe.ts).
	const deduped = dedupeTraceSignals(signals, spans);
	const occurrences = deduped.occurrences;

	// Usage rollups (`runtime_metrics_1m`): `request_count` counts requests
	// and only requests, `error_count` counts failed requests and errors
	// outside any request. A request is its outermost server span
	// (request-spans.ts); its server spans count it unless the sender's metric
	// feed does (countedBySpans), and nothing else adds requests.
	const membership = requestMembership(
		spans.map((span, i) => ({
			traceId: span.traceId,
			spanId: span.spanId,
			parentSpanId: span.parentSpanId,
			kind: span.kind,
			process: spanFacts[i]!.process,
		})),
	);
	const requests = spanRequests(spans, spanFacts, membership);
	const requestOfSignal = (m: number): SpanRequest | undefined => {
		const root = membership.requestOf[signalRollups[m]!.spanIndex]!;
		return root >= 0 ? requests.get(root) : undefined;
	};

	// Each error or fatal occurrence (after the dedupe: one per thrown error)
	// counts once. One recorded in a request (on its server spans or any span
	// below them in the batch) makes that request a failed one; any other
	// (captureException's always-on spans exported apart from their request,
	// workers, consumers, jobs) is one error outside a request. Warnings and
	// info count nothing; neither does a dropped status-only occurrence.
	const errorsOutsideRequests: RuntimeMetricPoint[] = [];
	deduped.members.forEach((members, i) => {
		const occ = occurrences[i]!;
		if (occ.severity !== "fatal" && occ.severity !== "error") return;
		// A caught error or deliberate fallback is an occurrence and an issue,
		// but no failure: it never fails its request and never counts in
		// `error_count`.
		if (softlyHandled(occ.attributes?.["autter.handling"])) return;
		const request = members.map(requestOfSignal).find((r) => r !== undefined);
		if (request) {
			request.hasErrorOccurrence = true;
			return;
		}
		errorsOutsideRequests.push({
			service: occ.service,
			environment: occ.environment,
			release: occ.release,
			route: signalRollups[deduped.sourceIndexes[i]!]!.route,
			bucketAt: minuteBucket(occ.occurredAt),
			requestCount: 0,
			errorCount: 1,
			durationSumMs: 0,
			sessionCount: 0,
		});
	});
	for (const [root, request] of requests) {
		const span = spans[root]!;
		const failed = request.isError || request.hasErrorOccurrence;
		const point = {
			service: span.service,
			environment: span.environment,
			release: span.release,
			bucketAt: minuteBucket(span.startedAt),
			sessionCount: 0,
		};
		switch (spanFacts[root]!.countedBy) {
			case "spans":
				addToRollup(rollups, {
					...point,
					route: request.route,
					requestCount: 1,
					errorCount: failed ? 1 : 0,
					// The request's latency is its outermost span's.
					durationSumMs: span.durationMs,
					...withLatency(requestLatency(span.durationMs)),
				});
				break;
			case "metrics": {
				// The metric feed counted it, and already made a 5xx response
				// a failed request. A request it saw succeed that recorded an
				// error adds that one error, on the route its point carried.
				const metricCountedFailure = span.statusCode !== null && span.statusCode >= 500;
				if (request.hasErrorOccurrence && !metricCountedFailure) {
					addToRollup(rollups, { ...point, route: spanFacts[root]!.templateRoute, requestCount: 0, errorCount: 1, durationSumMs: 0 });
				}
				break;
			}
			case "none":
				// Exported because it failed, with no metric feed counting
				// requests: not a sample of the traffic, so no request; its
				// failure counts once.
				if (failed) {
					addToRollup(rollups, { ...point, route: request.route, requestCount: 0, errorCount: 1, durationSumMs: 0 });
				}
				break;
		}
	}
	for (const error of errorsOutsideRequests) addToRollup(rollups, error);

	inheritHttpFromParent(
		occurrences,
		deduped.sourceIndexes.map((index) => signals[index]!.spanId),
		spans,
	);

	return {
		occurrences,
		occurrenceBatchIndexes: deduped.sourceIndexes,
		spans,
		metricPoints: [...rollups.values()],
		llmCalls,
		spanCount,
	};
}

/**
 * Who counts a request, decided on its outermost server span:
 * - "metrics": the sender's metric feed. Its data point carries the route
 *   (`autter.metric_has_route` on a resource with `autter.metrics_wired` and
 *   `autter.metrics_routes`), or error-linked tail retention exported it
 *   (`autter.tail_retained`) next to a metric feed (`autter.metrics_wired`).
 * - "none": tail retention exported it and no metric feed counts requests
 *   (the Python retention in adapters/python): not a sample of the traffic.
 * - "spans": anything else; its server spans are the request count.
 */
type RequestCounter = "spans" | "metrics" | "none";

function countedBy(resource: ResourceInfo, attrs: Map<string, string>): RequestCounter {
	if (resource.metricsCountRoutedRequests && attrs.get("autter.metric_has_route") === "true") return "metrics";
	if (attrs.get("autter.tail_retained") === "true") return resource.metricsWired ? "metrics" : "none";
	return "spans";
}

interface SpanFacts {
	/** The process the span was recorded in (request-spans.ts). */
	process: string;
	routeQuality: number;
	/** As a request's outermost server span: who counts the request. */
	countedBy: RequestCounter;
	/** Its `http.route`, normalized, else "": the route the HTTP
	 * instrumentation also put on the request's metric data point. */
	templateRoute: string;
}

interface SpanRequest {
	/** Normalized route the rollup row keys on. */
	route: string;
	routeQuality: number;
	/** Depth of the span the route came from (shallower wins a tie). */
	routeDepth: number;
	/** One of its server spans failed. */
	isError: boolean;
	/** An error or fatal occurrence was recorded in it. */
	hasErrorOccurrence: boolean;
}

/**
 * Every request in the batch, keyed by the batch index of its outermost
 * server span (request-spans.ts). Server spans nested in it add no request:
 * they lend their route when it is better (a template such as Next's
 * `/blog/[slug]` over the HTTP span's raw path; on a tie the shallower
 * span's), and their error. Latency and minute bucket stay the outermost
 * span's.
 */
function spanRequests(
	spans: RuntimeSpanRow[],
	facts: SpanFacts[],
	membership: RequestMembership,
): Map<number, SpanRequest> {
	const requests = new Map<number, SpanRequest>();
	spans.forEach((span, i) => {
		if (membership.requestOf[i] !== i) return;
		requests.set(i, {
			route: span.route ?? "",
			routeQuality: facts[i]!.routeQuality,
			routeDepth: membership.depth[i]!,
			isError: span.status === "error",
			hasErrorOccurrence: false,
		});
	});
	spans.forEach((span, i) => {
		const root = membership.requestOf[i]!;
		if (root === i || span.kind !== "server") return;
		const request = requests.get(root);
		if (!request) return;
		const quality = facts[i]!.routeQuality;
		const depth = membership.depth[i]!;
		if (quality > request.routeQuality || (quality === request.routeQuality && depth < request.routeDepth)) {
			request.route = span.route ?? "";
			request.routeQuality = quality;
			request.routeDepth = depth;
		}
		if (span.status === "error") request.isError = true;
	});
	return requests;
}

/**
 * Exception spans are often children named "Error" with no HTTP attributes.
 * Copy method, route, status, and duration from the server span in the same
 * trace so the issue can name the API that failed.
 */
function inheritHttpFromParent(
	occurrences: RuntimeOccurrenceInput[],
	occurrenceSpanIds: string[],
	spans: RuntimeSpanRow[],
): void {
	const byId = new Map<string, RuntimeSpanRow>();
	for (const span of spans) {
		if (span.spanId) byId.set(span.spanId, span);
	}
	for (let i = 0; i < occurrences.length; i++) {
		const occurrence = occurrences[i];
		const spanId = occurrenceSpanIds[i];
		if (!occurrence || !spanId) continue;
		const http = httpServerAncestor(byId, spanId);
		if (!http) continue;
		if (!occurrence.route && http.route) occurrence.route = http.route;
		// Request ids live on the request (server) span; child error spans
		// from captureException inherit it so the issue links to the request.
		const requestId = validRequestId(http.attributes?.["autter.request.id"]);
		if (!occurrence.requestId && requestId) occurrence.requestId = requestId;
		const method = methodFromSpan(http);
		if (!occurrence.method && method) occurrence.method = method;
		if (
			(occurrence.statusCode == null || occurrence.statusCode === 0) &&
			http.statusCode != null &&
			http.statusCode > 0
		) {
			occurrence.statusCode = http.statusCode;
		}
		if (http.durationMs > 0) {
			const attributes = { ...(occurrence.attributes ?? {}) };
			if (attributes["http.server.duration_ms"] == null) {
				attributes["http.server.duration_ms"] = Math.round(http.durationMs);
				occurrence.attributes = attributes;
			}
		}
	}
}

function httpServerAncestor(
	byId: Map<string, RuntimeSpanRow>,
	spanId: string,
): RuntimeSpanRow | null {
	let current = byId.get(spanId) ?? null;
	const seen = new Set<string>();
	while (current && current.spanId && !seen.has(current.spanId)) {
		seen.add(current.spanId);
		if (current.kind === "server") return current;
		const parentId = current.parentSpanId;
		if (!parentId) return null;
		current = byId.get(parentId) ?? null;
	}
	return null;
}

function methodFromSpan(span: RuntimeSpanRow): string | null {
	const raw = span.attributes?.["http.request.method"];
	return typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase().slice(0, 16) : null;
}

function withLatency(latency: LatencySamples | undefined): { latency?: LatencySamples } {
	return latency ? { latency } : {};
}

function minuteBucket(date: Date): Date {
	return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

function rollupKey(p: RuntimeMetricPoint): string {
	return [
		p.service,
		p.environment,
		p.release ?? "",
		p.route,
		p.bucketAt.getTime(),
	].join(" ");
}

function addToRollup(
	rollups: Map<string, RuntimeMetricPoint>,
	point: RuntimeMetricPoint,
): void {
	const key = rollupKey(point);
	const existing = rollups.get(key);
	if (!existing) {
		const latency = mergeLatency(undefined, point.latency);
		rollups.set(key, { ...point, ...withLatency(latency) });
		return;
	}
	existing.requestCount += point.requestCount;
	existing.errorCount += point.errorCount;
	existing.durationSumMs += point.durationSumMs;
	existing.sessionCount += point.sessionCount;
	const latency = mergeLatency(existing.latency, point.latency);
	if (latency) existing.latency = latency;
}

// HTTP-server duration instruments we know how to fold into rollups.
// `http.server.duration` (old semconv) is milliseconds;
// `http.server.request.duration` (current semconv) is seconds.
const HTTP_DURATION_INSTRUMENTS: Record<string, number> = {
	"http.server.duration": 1,
	"http.server.request.duration": 1000,
};

/**
 * Cumulative histograms report lifetime totals on every export; adding them
 * into a SummingMergeTree would re-count all past requests each interval.
 * Only deltas are summable — cumulative senders are skipped and covered by
 * the span-fed rollup fallback instead (a sender must not mark itself
 * `autter.metrics_wired` with cumulative histograms). (Enum arrives as a
 * number or an `AGGREGATION_TEMPORALITY_*` string depending on the
 * serialiser.)
 */
function isCumulativeTemporality(t: string | number | undefined): boolean {
	return t === 2 || t === "AGGREGATION_TEMPORALITY_CUMULATIVE";
}

export function normalizeMetrics(
	request: OtlpMetricsRequest,
): RuntimeMetricPoint[] {
	const rollups = new Map<string, RuntimeMetricPoint>();

	for (const resourceMetric of request.resourceMetrics ?? []) {
		const resource = resourceInfo(resourceMetric.resource);
		// An SDK migrating semantic conventions can emit both instruments for
		// every request (OTel's `OTEL_SEMCONV_STABILITY_OPT_IN=http/dup`).
		// Count the stable one, as the latency histograms do (latency.ts).
		const hasStableDuration = resourceMetric.scopeMetrics?.some((scope) =>
			scope.metrics?.some((metric) => metric.name === "http.server.request.duration"));
		for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
			for (const metric of scopeMetric.metrics ?? []) {
				const multiplier = metric.name
					? HTTP_DURATION_INSTRUMENTS[metric.name]
					: undefined;
				if (multiplier === undefined) continue;
				if (hasStableDuration && metric.name === "http.server.duration") continue;
				if (isCumulativeTemporality(metric.histogram?.aggregationTemporality)) {
					continue;
				}
				for (const dataPoint of metric.histogram?.dataPoints ?? []) {
					const attrs = attrMap(dataPoint.attributes);
					const statusCode = statusCodeOf(attrs);
					const count = Number(dataPoint.count ?? 0);
					if (count <= 0) continue;
					addToRollup(rollups, {
						service: resource.service,
						environment: resource.environment,
						release: resource.release,
						// Same normalization as the span-fed rollups: emitters
						// are supposed to put route templates in `http.route`,
						// but some put raw paths there — keep the key space
						// bounded and consistent across both feeds.
						route: normalizeRoute(routeOf(attrs)),
						bucketAt: minuteBucket(nanosToDate(dataPoint.timeUnixNano)),
						requestCount: count,
						errorCount: statusCode !== null && statusCode >= 500 ? count : 0,
						durationSumMs: (dataPoint.sum ?? 0) * multiplier,
						sessionCount: 0,
						// p50/p95/p99 from the same buckets (IP-02, latency.ts).
						...withLatency(histogramLatency(
							(dataPoint.explicitBounds ?? []).map((bound) => Number(bound) * multiplier),
							(dataPoint.bucketCounts ?? []).map(Number),
						)),
					});
				}
			}
		}
	}

	return [...rollups.values()];
}
