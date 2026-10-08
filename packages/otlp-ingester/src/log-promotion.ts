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
 * best-effort and bounded (see promotionLookups, plus a per-tenant lookup
 * budget in server.ts): when it fails, is skipped or is over budget the
 * record is promoted anyway — a rare duplicate beats a silently dropped
 * error.
 */

export const PROMOTION_DEDUPE_WINDOW_MS = 60_000;
/** Widest single lookup window. Candidate timestamps come from the client,
 * so one batch could otherwise ask ClickHouse to scan an arbitrary range. */
export const MAX_LOOKUP_SPAN_MS = 10 * 60_000;
/** At most this many lookup windows (queries) per request. */
export const MAX_LOOKUP_WINDOWS = 4;
/** Candidates outside [now − 24 h, now + 5 min] are never looked up: their
 * trace cannot plausibly have a recent occurrence to dedupe against. */
export const LOOKUP_PAST_MS = 24 * 60 * 60_000;
export const LOOKUP_FUTURE_MS = 5 * 60_000;

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

export interface PromotionLookup {
	from: Date;
	to: Date;
	traceIds: string[];
}

/**
 * Bounded dedupe lookups for the candidates that carry a trace id: each
 * window is [oldest − 60 s, newest + 60 s] over candidates taken newest first
 * and spans at most MAX_LOOKUP_SPAN_MS; at most MAX_LOOKUP_WINDOWS windows are
 * planned.
 * Candidates outside the plausible time range or beyond the window cap are
 * not looked up — they are still deduped in-batch and promoted.
 */
export function promotionLookups(
	occurrences: RuntimeOccurrenceInput[],
	now = Date.now(),
): PromotionLookup[] {
	const eligible = occurrences
		.filter((o): o is RuntimeOccurrenceInput & { traceId: string } => !!o.traceId)
		.map((o) => ({ traceId: o.traceId, at: o.occurredAt.getTime() }))
		.filter((o) => o.at >= now - LOOKUP_PAST_MS && o.at <= now + LOOKUP_FUTURE_MS)
		// Newest first: recent records are the likeliest duplicates of an
		// occurrence the trace path just wrote, so they get the windows.
		.sort((a, b) => b.at - a.at);
	const lookups: PromotionLookup[] = [];
	let start = 0;
	while (start < eligible.length && lookups.length < MAX_LOOKUP_WINDOWS) {
		const newest = eligible[start]!.at;
		let end = start;
		while (
			end + 1 < eligible.length &&
			newest - eligible[end + 1]!.at + 2 * PROMOTION_DEDUPE_WINDOW_MS <= MAX_LOOKUP_SPAN_MS
		)
			end++;
		lookups.push({
			from: new Date(eligible[end]!.at - PROMOTION_DEDUPE_WINDOW_MS),
			to: new Date(newest + PROMOTION_DEDUPE_WINDOW_MS),
			traceIds: [...new Set(eligible.slice(start, end + 1).map((o) => o.traceId))],
		});
		start = end + 1;
	}
	return lookups;
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
