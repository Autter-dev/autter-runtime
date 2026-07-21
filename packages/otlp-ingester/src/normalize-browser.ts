import { z } from "zod";
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
	]),
	timestamp: z.string().datetime(),
	/** exception/message events: signal level. Defaults per type. */
	severity: z.enum(["fatal", "error", "warning", "info"]).optional(),
	message: z.string().max(4000).default(""),
	/** track_event only: the event name (counted, never free-form PII). */
	name: z.string().max(200).optional(),
	stack: z.string().max(32000).optional(),
	errorType: z.string().max(200).optional(),
	filename: z.string().max(1000).optional(),
	line: z.number().int().nonnegative().optional(),
	column: z.number().int().nonnegative().optional(),
	/** Path only; query strings are stripped defensively anyway. */
	route: z.string().max(1000).optional(),
	context: z.record(z.unknown()).optional(),
});

export const browserPayloadSchema = z.object({
	version: z.literal(1),
	sessionId: z.string().max(100).optional(),
	service: z.string().min(1).max(200),
	environment: z.string().min(1).max(100),
	release: z.string().max(200).optional(),
	events: z.array(browserEventSchema).max(50),
});

export type BrowserPayload = z.infer<typeof browserPayloadSchema>;

const TYPE_TO_ERROR_TYPE: Record<string, string> = {
	exception: "Error",
	unhandled_rejection: "UnhandledRejection",
	message: "Message",
};

/** Default severity per event type when the SDK doesn't say. */
const TYPE_TO_SEVERITY: Record<string, RuntimeSeverity> = {
	exception: "error",
	unhandled_rejection: "error",
	message: "warning",
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
		field: "sessionCount" | "requestCount",
	): void {
		const bucketAt = new Date(
			Math.floor(occurredAt.getTime() / 60_000) * 60_000,
		);
		const key = `${route} ${bucketAt.getTime()}`;
		const existing = rollups.get(key);
		if (existing) {
			existing[field] += 1;
			return;
		}
		rollups.set(key, {
			service: payload.service,
			environment: payload.environment,
			release: payload.release ?? null,
			route,
			bucketAt,
			requestCount: field === "requestCount" ? 1 : 0,
			errorCount: 0,
			durationSumMs: 0,
			sessionCount: field === "sessionCount" ? 1 : 0,
		});
	}

	for (const event of payload.events) {
		const occurredAt = new Date(event.timestamp);

		if (event.type === "session_start") {
			bumpRollup("", occurredAt, "sessionCount");
			continue;
		}

		// Coarse usage counters: track_event("checkout_opened") becomes a
		// request_count increment on the synthetic route "event:checkout_opened".
		if (event.type === "track_event") {
			const name = (event.name ?? event.message ?? "").slice(0, 200);
			if (name) bumpRollup(`event:${name}`, occurredAt, "requestCount");
			continue;
		}

		occurrences.push({
			source: "browser",
			severity: asSeverity(
				event.severity,
				TYPE_TO_SEVERITY[event.type] ?? "error",
			),
			service: payload.service,
			environment: payload.environment,
			release: payload.release ?? null,
			errorType:
				event.errorType ?? TYPE_TO_ERROR_TYPE[event.type] ?? "Error",
			message: event.message || "Unknown error",
			stack: event.stack ?? null,
			route: event.route ? (event.route.split("?")[0] ?? null) : null,
			method: null,
			statusCode: null,
			traceId: null,
			sessionId: payload.sessionId ?? null,
			attributes: {
				...(event.filename ? { filename: event.filename.split("?")[0] } : {}),
				...(event.line !== undefined ? { line: event.line } : {}),
				...(event.column !== undefined ? { column: event.column } : {}),
				...(event.context ? { context: event.context } : {}),
			},
			occurredAt,
		});
	}

	return { occurrences, metricPoints: [...rollups.values()] };
}
