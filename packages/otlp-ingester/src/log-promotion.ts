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
 * `autter.request.counted_by = "summary"`: the request this record belongs to
 * is counted in the usage rollups by its request summary (the record of
 * `autter.operation.kind = "request"` carrying the same mark), because no
 * other feed sees it. `@autter/runtime-edge` (1.3.0+) puts it on every
 * record of a request: an edge function has no trace pipeline and no
 * `http.server.duration` histogram, so without it edge services had error
 * counts and no requests. Nothing else sets it: Node and Next.js summaries
 * never carry it (their requests are counted by the histogram or the spans),
 * so a request is counted by its summary only when its sender says the
 * summary is the one count it gets.
 */
export const COUNTED_BY_ATTRIBUTE = "autter.request.counted_by";
/** On a counted summary: an error of the request was reported (an
 * `autter.capture.mode = "log"` record), which makes it a failed request. */
export const ERROR_REPORTED_ATTRIBUTE = "autter.request.error_reported";

export function countedBySummary(attributes: Record<string, unknown> | null | undefined): boolean {
	return attributes?.[COUNTED_BY_ATTRIBUTE] === "summary";
}

/**
 * The usage rollups (`runtime_metrics_1m`) a /v1/logs batch adds, counted the
 * way the trace path counts (normalize-otlp.ts): `request_count` counts
 * requests only, `error_count` counts failed requests once and errors outside
 * a counted request one each.
 *
 * - A request summary marked counted (`countedBySummary`) is one request:
 *   `request_count` 1, its duration, on its route and minute; `error_count` 1
 *   when it failed — outcome `failed`, a status ≥ 500, or an error reported
 *   in it (`autter.request.error_reported`), as an error occurrence recorded
 *   in a request fails it on the trace path.
 * - A promoted occurrence (logger-only or edge error record) adds
 *   `error_count` 1 — unless its record is marked counted: its request's
 *   summary already counts that failure once, however many errors it had.
 *
 * The decision is per record, never by matching records across a batch, so
 * a request whose records an exporter splits over two batches is still
 * counted once. Unmarked summaries add nothing (they are counted elsewhere,
 * or by no one, as before).
 */
export function logRollups(
	rows: RuntimeLogRecord[],
	promoted: RuntimeOccurrence[],
): RuntimeMetricPoint[] {
	const rollups = new Map<string, RuntimeMetricPoint>();
	const add = (point: Omit<RuntimeMetricPoint, "bucketAt" | "sessionCount"> & { at: Date }) => {
		const { at, ...rest } = point;
		const bucketAt = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
		const key = [rest.service, rest.environment, rest.release ?? "", rest.route, bucketAt.getTime()].join(" ");
		const existing = rollups.get(key);
		if (existing) {
			existing.requestCount += rest.requestCount;
			existing.errorCount += rest.errorCount;
			existing.durationSumMs += rest.durationSumMs;
			return;
		}
		rollups.set(key, { ...rest, bucketAt, sessionCount: 0 });
	};
	for (const row of rows) {
		if (row.kind !== "request" || !countedBySummary(row.attributes)) continue;
		const failed =
			row.outcome === "failed" ||
			row.statusCode >= 500 ||
			row.attributes[ERROR_REPORTED_ATTRIBUTE] === true;
		add({
			service: row.service,
			environment: row.environment,
			release: row.release || null,
			// Already normalized (logs.ts), the key promoted errors use too.
			route: row.route,
			at: row.occurredAt,
			requestCount: 1,
			errorCount: failed ? 1 : 0,
			durationSumMs: row.durationMs,
		});
	}
	for (const occ of promoted) {
		// Its request's summary counts this failure.
		if (countedBySummary(occ.attributes)) continue;
		// One error of its own, in `error_count` only — what the trace path
		// does for an error outside a request: the record names no request
		// the rollups count, so no request is invented.
		add({
			service: occ.service,
			environment: occ.environment,
			release: occ.release,
			route: normalizeRoute(occ.route),
			at: occ.occurredAt,
			requestCount: 0,
			errorCount: 1,
			durationSumMs: 0,
		});
	}
	return [...rollups.values()];
}
