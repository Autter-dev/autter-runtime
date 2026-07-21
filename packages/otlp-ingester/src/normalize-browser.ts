import { z } from "zod";
import type {
	RuntimeMetricPoint,
	RuntimeOccurrenceInput,
} from "./types.js";

/**
 * The compact browser payload (`version: 1`) emitted by
 * `@autter/runtime-browser` and forwarded by the customer's same-origin
 * relay. The schema is a privacy gate as much as a validator: anything not
 * whitelisted here never reaches storage.
 */

const browserEventSchema = z.object({
	id: z.string().max(64).optional(),
	type: z.enum(["exception", "unhandled_rejection", "session_start"]),
	timestamp: z.string().datetime(),
	message: z.string().max(4000).default(""),
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
};

export interface NormalizedBrowser {
	occurrences: RuntimeOccurrenceInput[];
	metricPoints: RuntimeMetricPoint[];
}

export function normalizeBrowserPayload(
	payload: BrowserPayload,
): NormalizedBrowser {
	const occurrences: RuntimeOccurrenceInput[] = [];
	const sessions = new Map<string, RuntimeMetricPoint>();

	for (const event of payload.events) {
		const occurredAt = new Date(event.timestamp);

		if (event.type === "session_start") {
			const bucketAt = new Date(
				Math.floor(occurredAt.getTime() / 60_000) * 60_000,
			);
			const key = String(bucketAt.getTime());
			const existing = sessions.get(key);
			if (existing) {
				existing.sessionCount += 1;
			} else {
				sessions.set(key, {
					service: payload.service,
					environment: payload.environment,
					release: payload.release ?? null,
					route: "",
					bucketAt,
					requestCount: 0,
					errorCount: 0,
					durationSumMs: 0,
					sessionCount: 1,
				});
			}
			continue;
		}

		occurrences.push({
			source: "browser",
			service: payload.service,
			environment: payload.environment,
			release: payload.release ?? null,
			errorType:
				event.errorType ?? TYPE_TO_ERROR_TYPE[event.type] ?? "Error",
			message: event.message || "Unknown error",
			stack: event.stack ?? null,
			route: event.route ? (event.route.split("?")[0] ?? null) : null,
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

	return { occurrences, metricPoints: [...sessions.values()] };
}
