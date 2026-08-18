import { normalizeRoute } from "./fingerprint.js";
import { extractLlmCall } from "./llm.js";
import {
	asSeverity,
	type RuntimeLlmCall,
	type RuntimeMetricPoint,
	type RuntimeOccurrenceInput,
	type RuntimeSeverity,
	type RuntimeSpanRow,
} from "./types.js";

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
	value?: {
		stringValue?: string;
		intValue?: string | number;
		doubleValue?: number;
		boolValue?: boolean;
	};
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
	timeUnixNano?: string | number;
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
				histogram?: {
					dataPoints?: OtlpDataPoint[];
					aggregationTemporality?: string | number;
				};
				sum?: { dataPoints?: OtlpDataPoint[] };
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
	/** `autter.metrics_wired` — the sender exports request metrics, so
	 * span-fed usage rollups would double-count its requests. */
	metricsWired: boolean;
}

function resourceInfo(resource: OtlpResource | undefined): ResourceInfo {
	const attrs = attrMap(resource?.attributes);
	return {
		service: attrs.get("service.name") ?? "unknown",
		environment:
			attrs.get("deployment.environment.name") ??
			attrs.get("deployment.environment") ??
			"production",
		release: attrs.get("service.version") ?? null,
		metricsWired: attrs.get("autter.metrics_wired") === "true",
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
	occurrences: RuntimeOccurrenceInput[];
	spans: RuntimeSpanRow[];
	metricPoints: RuntimeMetricPoint[];
	llmCalls: RuntimeLlmCall[];
	spanCount: number;
}

const MAX_SPANS_PER_REQUEST = 5000;

export function normalizeTraces(request: OtlpTraceRequest): NormalizedTraces {
	const occurrences: RuntimeOccurrenceInput[] = [];
	const spans: RuntimeSpanRow[] = [];
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
				const isError =
					isErrorStatus(span.status?.code) ||
					(statusCode !== null && statusCode >= 500);

				spans.push({
					service: resource.service,
					environment: resource.environment,
					release: resource.release,
					traceId: span.traceId ?? "",
					spanId: span.spanId ?? "",
					parentSpanId: span.parentSpanId ?? null,
					name: span.name ?? "unnamed",
					kind,
					status: isError ? "error" : "ok",
					route,
					statusCode,
					durationMs,
					attributes: null,
					startedAt,
				});

				// Error occurrences: one per exception event; if the span is
				// errored without exception events, one from the span status.
				const occurrencesBefore = occurrences.length;
				const exceptionEvents = (span.events ?? []).filter(
					(event) => event.name === "exception",
				);
				for (const event of exceptionEvents) {
					const eventAttrs = attrMap(event.attributes);
					occurrences.push({
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
						attributes: null,
						occurredAt: nanosToDate(event.timeUnixNano ?? span.startTimeUnixNano),
					});
				}
				if (exceptionEvents.length === 0 && isErrorStatus(span.status?.code)) {
					occurrences.push({
						source: "server",
						severity: severityOf(new Map(), attrs),
						service: resource.service,
						environment: resource.environment,
						release: resource.release,
						errorType: "SpanError",
						message: span.status?.message || `${span.name ?? "span"} failed`,
						stack: null,
						route,
						method: methodOf(attrs),
						statusCode,
						traceId: span.traceId ?? null,
						sessionId: null,
						attributes: null,
						occurredAt: startedAt,
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

				// Server spans fold into 1-minute usage rollups so traffic is
				// tracked even when the metrics pipeline isn't wired —
				// senders that DO export request metrics mark the resource
				// with `autter.metrics_wired` and are skipped here, or every
				// request they trace would count twice. The rollup key uses
				// the normalized route: `http.route` is already a template,
				// but the url.path/http.target fallback is a raw path whose
				// id segments would explode the SummingMergeTree key space
				// (and never line up with the metric-fed rows for the same
				// endpoint).
				if (kind === "server" && !resource.metricsWired) {
					addToRollup(rollups, {
						service: resource.service,
						environment: resource.environment,
						release: resource.release,
						route: normalizeRoute(route),
						bucketAt: minuteBucket(startedAt),
						requestCount: 1,
						errorCount: isError ? 1 : 0,
						durationSumMs: durationMs,
						sessionCount: 0,
					});
				} else {
					// Occurrences on non-server spans (captureException's internal
					// error spans, workers, consumers) have no request rollup to
					// ride — count each as one event / one error event, or a
					// service whose errors arrive outside HTTP handlers groups
					// issues while every event counter stays 0. Server spans are
					// excluded: their request rollup above already represents them.
					for (const occ of occurrences.slice(occurrencesBefore)) {
						addToRollup(rollups, {
							service: occ.service,
							environment: occ.environment,
							release: occ.release,
							route: occ.route ?? "",
							bucketAt: minuteBucket(occ.occurredAt),
							requestCount: 1,
							errorCount:
								occ.severity === "fatal" || occ.severity === "error" ? 1 : 0,
							durationSumMs: 0,
							sessionCount: 0,
						});
					}
				}
			}
		}
	}

	return {
		occurrences,
		spans,
		metricPoints: [...rollups.values()],
		llmCalls,
		spanCount,
	};
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
		rollups.set(key, { ...point });
		return;
	}
	existing.requestCount += point.requestCount;
	existing.errorCount += point.errorCount;
	existing.durationSumMs += point.durationSumMs;
	existing.sessionCount += point.sessionCount;
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
 * the span-fed rollup fallback instead. (Enum arrives as a number or an
 * `AGGREGATION_TEMPORALITY_*` string depending on the serialiser.)
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
		for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
			for (const metric of scopeMetric.metrics ?? []) {
				const multiplier = metric.name
					? HTTP_DURATION_INSTRUMENTS[metric.name]
					: undefined;
				if (multiplier === undefined) continue;
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
					});
				}
			}
		}
	}

	return [...rollups.values()];
}
