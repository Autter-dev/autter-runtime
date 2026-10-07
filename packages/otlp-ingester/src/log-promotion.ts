import { normalizeRoute } from "./fingerprint.js";
import type { RuntimeLogRecord } from "./logs.js";
import type {
	RuntimeMetricPoint,
	RuntimeOccurrence,
	RuntimeOccurrenceInput,
} from "./types.js";

/**
 * Log promotion — errors from SDKs running WITHOUT a trace pipeline.
 *
 * Logger-only mode (`initAutterLogging`) and `@autter/runtime-edge` have no
 * span to record an exception on, so they emit an error log record with
 * `exception.*` and `autter.capture.mode = "log"`. /v1/logs turns those
 * records into ordinary server occurrences (fingerprinted, stored in
 * runtime_error_occurrences, forwarded to the sink) — otherwise their
 * errors would never reach issue grouping.
 *
 * Dedupe, so one failure never becomes two occurrences through two export
 * paths:
 * - in-batch: at most one promoted occurrence per trace id (first wins);
 * - cross-batch: a trace id that already produced an occurrence for this
 *   tenant within ±PROMOTION_DEDUPE_WINDOW_MS (ClickHouse lookup) is skipped.
 * Records without a trace id are always promoted. The lookup is
 * best-effort: when it fails the record is promoted anyway — a rare
 * duplicate beats a silently dropped error.
 */

export const PROMOTION_DEDUPE_WINDOW_MS = 60_000;

/** Promotion candidates in record order, deduped by trace id in-batch. */
export function logPromotionCandidates(
	rows: RuntimeLogRecord[],
): RuntimeOccurrenceInput[] {
	const traces = new Set<string>();
	const out: RuntimeOccurrenceInput[] = [];
	for (const row of rows) {
		const occurrence = row.occurrence;
		if (!occurrence) continue;
		if (occurrence.traceId) {
			if (traces.has(occurrence.traceId)) continue;
			traces.add(occurrence.traceId);
		}
		out.push(occurrence);
	}
	return out;
}

/** Lookup window around the candidates: [earliest − 60 s, latest + 60 s]. */
export function promotionLookupWindow(
	occurrences: RuntimeOccurrenceInput[],
): { from: Date; to: Date } {
	const times = occurrences.map((o) => o.occurredAt.getTime());
	return {
		from: new Date(Math.min(...times) - PROMOTION_DEDUPE_WINDOW_MS),
		to: new Date(Math.max(...times) + PROMOTION_DEDUPE_WINDOW_MS),
	};
}

/**
 * One event / one error event per promoted occurrence — the same counting
 * the trace path applies to occurrences outside a server span, so issue
 * counters for logger-only services don't read 0.
 */
export function promotionRollups(
	occurrences: RuntimeOccurrence[],
): RuntimeMetricPoint[] {
	const rollups = new Map<string, RuntimeMetricPoint>();
	for (const occ of occurrences) {
		const bucketAt = new Date(
			Math.floor(occ.occurredAt.getTime() / 60_000) * 60_000,
		);
		const route = normalizeRoute(occ.route);
		const key = [
			occ.service,
			occ.environment,
			occ.release ?? "",
			route,
			bucketAt.getTime(),
		].join(" ");
		const existing = rollups.get(key);
		if (existing) {
			existing.requestCount += 1;
			existing.errorCount += 1;
			continue;
		}
		rollups.set(key, {
			service: occ.service,
			environment: occ.environment,
			release: occ.release,
			route,
			bucketAt,
			requestCount: 1,
			errorCount: 1,
			durationSumMs: 0,
			sessionCount: 0,
		});
	}
	return [...rollups.values()];
}
