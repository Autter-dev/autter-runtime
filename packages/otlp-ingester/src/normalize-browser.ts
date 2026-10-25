import { z } from "zod";
import { liftErrorFields } from "./error-fields.js";
import { fingerprintOverrideOf } from "./fingerprint-override.js";
import { sanitizeRuntimeContext } from "./context.js";
import { normalizeRoute } from "./fingerprint.js";
import { scrubText } from "./redact.js";
import { breadcrumbsField } from "./breadcrumbs.js";
import { browserDebugIds } from "./source-maps.js";
import {
	asSeverity,
	type RuntimeMetricPoint,
	type RuntimeOccurrenceInput,
	type RuntimeSeverity,
} from "./types.js";

/**
 * The compact browser payload (`version: 1`) emitted by
 * `@autter/runtime-browser` and forwarded by the customer's same-origin
 * relay. The schema is a privacy gate as much as a validator: anything not
 * whitelisted here never reaches storage.
 */

const browserEventSchema = z.object({
	id: z.string().max(64).optional(),
	type: z.enum([
		"exception",
		"unhandled_rejection",
		"message",
		"session_start",
		"track_event",
		"outcome",
		"request_failure",
		"csp_violation",
		"timing",
	]),
	timestamp: z.string().datetime(),
	/** exception/message events: signal level. Defaults per type. */
	severity: z.enum(["fatal", "error", "warning", "info"]).optional(),
	message: z.string().max(4000).default(""),
	/** track_event only: the event name (counted, never free-form PII). */
	name: z.string().max(200).optional(),
	durationMs: z.number().nonnegative().max(120000).optional(),
	stack: z.string().max(32000).optional(),
	errorType: z.string().max(200).optional(),
	filename: z.string().max(1000).optional(),
	line: z.number().int().nonnegative().optional(),
	column: z.number().int().nonnegative().optional(),
	/** Path only; query strings are stripped defensively anyway. */
	route: z.string().max(1000).optional(),
	/**
	 * Free-form, scrubbed context. runtime-browser ≥1.4.0 also sends the
	 * declared-error keys `autter.error.code|why|fix|link|expected` (from
	 * coded errors / `autterErrorFromResponse`) and `autter.request.id` (the
	 * `x-request-id` of a failed fetch/XHR). They are validated one by one
	 * in normalizeBrowserPayload — a malformed value is dropped on its own
	 * instead of rejecting the whole beacon.
	 */
	context: z.record(z.unknown()).optional(),
	/** runtime-browser `/breadcrumbs`: steps before a failure. Validated entry by entry in breadcrumbs.ts; a malformed list is dropped, never the beacon. */
	breadcrumbs: z.array(z.unknown()).optional().catch(undefined),
	/** runtime-browser ≥1.6.0: script URL → debug id for the scripts in this
	 * event's stack (EI-13). Malformed values are dropped, never the beacon. */
	debugIds: z.record(z.string().max(1000), z.unknown()).optional().catch(undefined),
	/**
	 * Fingerprint override (runtime-browser 1.6.0+): one string or a list.
	 * Bounded and scrubbed in fingerprint-override.ts; a malformed value is
	 * dropped on its own.
	 */
	fingerprint: z.union([z.string().max(2000), z.array(z.string().max(2000)).max(50)]).optional().catch(undefined),
	/**
	 * runtime-browser ≥1.6.0: W3C trace id of the request behind the event
	 * (the `traceparent` it sent), joining it to the server trace. A malformed
	 * id is dropped on its own instead of rejecting the beacon.
	 */
	traceId: z.string().regex(/^(?!0{32})[0-9a-f]{32}$/).optional().catch(undefined),
});

/** Events past this in one payload are dropped and counted (events_over_limit). */
export const MAX_BROWSER_EVENTS = 50;

const browserEnvelope = {
	version: z.literal(1),
	sessionId: z.string().max(100).optional(),
	service: z.string().min(1).max(200),
	environment: z.string().min(1).max(100),
	release: z.string().max(200).optional(),
	/** @autter/runtime-browser version (1.4+); recorded for compatibility checks. */
	sdk: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}[0-9A-Za-z.+-]{0,20}$/).optional().catch(undefined),
};

/** A whole payload, every event valid: what normalizeBrowserPayload takes. */
export const browserPayloadSchema = z.object({
	...browserEnvelope,
	events: z.array(browserEventSchema).max(MAX_BROWSER_EVENTS),
});

export type BrowserPayload = z.infer<typeof browserPayloadSchema>;

const browserEnvelopeSchema = z.object({ ...browserEnvelope, events: z.array(z.unknown()) });

export interface ParsedBrowserPayload {
	/** The envelope with its valid events (at most MAX_BROWSER_EVENTS). */
	payload: BrowserPayload;
	/** Events dropped because they failed validation (invalid_event). */
	invalidEvents: number;
	/** Events past MAX_BROWSER_EVENTS, not looked at (events_over_limit). */
	overLimitEvents: number;
	/** The first validation issues of the dropped events; `path` starts with ["events", index]. */
	issues: z.ZodIssue[];
}

/**
 * Validate a browser payload event by event (1.8.0). The envelope (version,
 * service, environment) must be valid or the payload is refused; an event
 * that fails validation — a type this ingester doesn't know, a bad
 * timestamp, an oversized field — is dropped on its own and counted, so it
 * no longer costs the errors sent in the same beacon. Events past
 * MAX_BROWSER_EVENTS are dropped and counted unread.
 */
export function parseBrowserPayload(
	body: unknown,
): { success: true; data: ParsedBrowserPayload } | { success: false; issues: z.ZodIssue[] } {
	const envelope = browserEnvelopeSchema.safeParse(body);
	if (!envelope.success) return { success: false, issues: envelope.error.issues.slice(0, 5) };
	const raw = envelope.data.events;
	const considered = raw.slice(0, MAX_BROWSER_EVENTS);
	const events: BrowserPayload["events"] = [];
	const issues: z.ZodIssue[] = [];
	let invalidEvents = 0;
	considered.forEach((candidate, index) => {
		const parsed = browserEventSchema.safeParse(candidate);
		if (parsed.success) {
			events.push(parsed.data);
			return;
		}
		invalidEvents += 1;
		for (const issue of parsed.error.issues) {
			if (issues.length >= 5) break;
			issues.push({ ...issue, path: ["events", index, ...issue.path] });
		}
	});
	return {
		success: true,
		data: {
			payload: { ...envelope.data, events },
			invalidEvents,
			overLimitEvents: raw.length - considered.length,
			issues,
		},
	};
}

const TYPE_TO_ERROR_TYPE: Record<string, string> = {
	exception: "Error",
	unhandled_rejection: "UnhandledRejection",
	message: "Message",
	outcome: "OutcomeFailure",
	request_failure: "HttpRequestError",
	csp_violation: "CspViolation",
};

// Content-level gate for the free-form `context` bag. The schema whitelist
// above is structural; this masks secrets/PII inside whatever a (possibly
// outdated) SDK still sends — sensitive keys and secret-shaped values at any
// depth, via the same sanitiser as OTLP attributes. Message, stack, and route
// are scrubbed centrally before fingerprinting (server.ts fingerprintAll).
const EMAIL_VALUE_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi;
const REDACTED = "[redacted]";

function scrubContext(context: Record<string, unknown>): Record<string, unknown> {
	return sanitizeRuntimeContext(
		Object.fromEntries(
			Object.entries(context).filter(([, value]) => value !== undefined && value !== null),
		),
	);
}

/** Default severity per event type when the SDK doesn't say. */
const TYPE_TO_SEVERITY: Record<string, RuntimeSeverity> = {
	exception: "error",
	unhandled_rejection: "error",
	message: "warning",
	outcome: "error",
	request_failure: "error",
	csp_violation: "error",
};

export interface NormalizedBrowser {
	occurrences: RuntimeOccurrenceInput[];
	metricPoints: RuntimeMetricPoint[];
}

export function normalizeBrowserPayload(
	payload: BrowserPayload,
): NormalizedBrowser {
	const occurrences: RuntimeOccurrenceInput[] = [];
	const rollups = new Map<string, RuntimeMetricPoint>();

	function bumpRollup(
		route: string,
		occurredAt: Date,
		counts: { requestCount?: number; errorCount?: number; sessionCount?: number },
	): void {
		route = scrubText(route);
		const bucketAt = new Date(
			Math.floor(occurredAt.getTime() / 60_000) * 60_000,
		);
		const key = `${route} ${bucketAt.getTime()}`;
		const existing = rollups.get(key);
		if (existing) {
			existing.requestCount += counts.requestCount ?? 0;
			existing.errorCount += counts.errorCount ?? 0;
			existing.sessionCount += counts.sessionCount ?? 0;
			return;
		}
		rollups.set(key, {
			service: payload.service,
			environment: payload.environment,
			release: payload.release ?? null,
			route,
			bucketAt,
			requestCount: counts.requestCount ?? 0,
			errorCount: counts.errorCount ?? 0,
			durationSumMs: 0,
			sessionCount: counts.sessionCount ?? 0,
		});
	}

	for (const event of payload.events) {
		const occurredAt = new Date(event.timestamp);

		if (event.type === "session_start") {
			bumpRollup("", occurredAt, { sessionCount: 1 });
			continue;
		}

		// Coarse usage counters: track_event("checkout_opened") becomes a
		// request_count increment on the synthetic route "event:checkout_opened".
		if (event.type === "track_event") {
			const name = (event.name ?? event.message ?? "").slice(0, 200);
			if (name) bumpRollup(`event:${name}`, occurredAt, { requestCount: 1 });
			continue;
		}
		if (event.type === "timing") {
			const name = event.name === "browser.longtask" ? "browser.longtask"
				: `browser.resource:${normalizeRoute((event.name ?? "").replace(/^browser\.resource:/, "").split("?")[0]!.replace(EMAIL_VALUE_RE, REDACTED))}`;
			bumpRollup(name, occurredAt, { requestCount: 1 });
			const point = rollups.get(`${scrubText(name)} ${Math.floor(occurredAt.getTime() / 60_000) * 60_000}`);
			if (point) point.durationSumMs += event.durationMs ?? 0;
			continue;
		}

		const severity = asSeverity(
			event.severity,
			TYPE_TO_SEVERITY[event.type] ?? "error",
		);
		const context = event.context ? scrubContext(event.context) : undefined;
		// runtime-browser 1.8.0 sends an Error passed to `console.error` with
		// the log line as `autter.log.message` only (its bundle is size-capped):
		// mark it the way the server SDKs mark a caught error.
		const logged = event.type === "exception" && typeof context?.["autter.log.message"] === "string";
		// A browser error belongs to no server request: it counts in
		// `error_count` only (fatal/error severity), never `request_count`,
		// so a page that only reports errors still shows them without
		// inventing requests. A handled (caught) error is an occurrence but
		// no counted failure; warnings and info count nothing.
		if ((severity === "fatal" || severity === "error") && !logged) {
			bumpRollup(event.route ? (event.route.split("?")[0] ?? "") : "", occurredAt, { errorCount: 1 });
		}

		occurrences.push({
			source: "browser",
			severity,
			service: payload.service,
			environment: payload.environment,
			release: payload.release ?? null,
			errorType:
				event.errorType ?? TYPE_TO_ERROR_TYPE[event.type] ?? "Error",
			message: event.type === "outcome" ? `${(event.name ?? "outcome").replace(EMAIL_VALUE_RE, REDACTED)}: ${event.message.replace(EMAIL_VALUE_RE, REDACTED)}`
				: event.type === "request_failure" ? `${normalizeRoute((event.name ?? "request").split("?")[0]!.replace(EMAIL_VALUE_RE, REDACTED))}: ${event.message}`
				: event.message || "Unknown error",
			stack: event.stack ?? null,
			route: event.route ? (event.route.split("?")[0] ?? null) : null,
			method: null,
			statusCode: null,
			traceId: event.traceId ?? null,
			sessionId: payload.sessionId ?? null,
			attributes: {
				...(event.filename ? { filename: event.filename.split("?")[0] } : {}),
				...(event.line !== undefined ? { line: event.line } : {}),
				...(event.column !== undefined ? { column: event.column } : {}),
				...(context ? { context } : {}),
				...(logged
					? {
							"autter.handled": true,
							"autter.handling": "caught",
							"autter.log.source": typeof context?.["autter.log.source"] === "string" ? context["autter.log.source"] : "console",
							"autter.log.message": context?.["autter.log.message"],
						}
					: {}),
			},
			occurredAt,
			...liftErrorFields(event.context),
			...breadcrumbsField(event.breadcrumbs),
			...browserDebugIds(event.debugIds),
			...fingerprintOverrideOf(event.fingerprint),
		});
	}

	return { occurrences, metricPoints: [...rollups.values()] };
}
