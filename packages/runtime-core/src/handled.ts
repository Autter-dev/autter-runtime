import { isError } from "./errors.js";

/**
 * Handled errors (RF-01, RF-02): the building blocks every server SDK shares
 * for errors the app caught instead of letting them crash.
 *
 * - Caught errors: an `Error` the app passes to `console.error`, a logger
 *   (pino, winston, bunyan) or `runtimeLogger.error` is reported as an
 *   occurrence at `error` severity, marked `autter.handled = true`,
 *   `autter.handling = "caught"`, with the log line as context
 *   (`autter.log.source`, `autter.log.message`).
 * - Deliberate fallbacks: `runtimeContext.degraded(err, reason)` reports the
 *   error at `warning` severity (never an incident), marked
 *   `autter.handling = "deliberate"` with `autter.degraded.reason`.
 *
 * A burst limit keeps a looping error from flooding: per kind (error type
 * and throw site) ten at once, then one every ten seconds. What it leaves
 * out is counted, and the count rides on the next record of that kind as
 * `autter.caught.dropped`, which the ingester adds to `runtime_ingest_drops`
 * (reason `caught_limited`).
 */

export type LoggedErrorSource = "console" | "pino" | "winston" | "bunyan" | "runtimeLogger";

/**
 * `captureLoggedErrors`: `true` (default) reports errors logged through
 * every source the SDK supports, `false` none; an object turns single
 * sources off, e.g. `{ console: false }`.
 */
export type CaptureLoggedErrorsOption = boolean | Partial<Record<LoggedErrorSource, boolean>>;

export const HANDLED_ATTRIBUTE = "autter.handled";
/** `"caught"` (logged by the app) or `"deliberate"` (`runtimeContext.degraded`). */
export const HANDLING_ATTRIBUTE = "autter.handling";
export const LOG_SOURCE_ATTRIBUTE = "autter.log.source";
export const LOG_MESSAGE_ATTRIBUTE = "autter.log.message";
export const DEGRADED_REASON_ATTRIBUTE = "autter.degraded.reason";
/** Records of the same kind the burst limit left out before this one. */
export const CAUGHT_DROPPED_ATTRIBUTE = "autter.caught.dropped";

export const LOG_MESSAGE_MAX = 1000;
export const DEGRADED_REASON_MAX = 500;
/** Burst limit: this many at once per kind… */
export const CAUGHT_BURST = 10;
/** …then one more every this many milliseconds. */
export const CAUGHT_REFILL_MS = 10_000;

const SOURCES: readonly LoggedErrorSource[] = ["console", "pino", "winston", "bunyan", "runtimeLogger"];

/** Which sources report, from the `captureLoggedErrors` option. */
export function loggedErrorSources(
	option: CaptureLoggedErrorsOption | undefined,
): Record<LoggedErrorSource, boolean> {
	const out = {} as Record<LoggedErrorSource, boolean>;
	for (const source of SOURCES)
		out[source] =
			option === false
				? false
				: option === undefined || option === true || typeof option !== "object"
					? true
					: option[source] !== false;
	return out;
}

/** The kind a burst limit counts: error type and throw site (first frame). */
export function handledErrorKind(error: unknown): { key: string; type: string } {
	let type = "Error";
	let site = "";
	try {
		if (isError(error)) {
			type = String(error.name || "Error").slice(0, 200);
			const lines = String(error.stack ?? "").split("\n");
			site = (lines.find((line) => /^\s*at\s/.test(line)) ?? lines[1] ?? "").trim().slice(0, 300);
		}
	} catch {
		/* unreadable error: its type alone */
	}
	return { key: `${type}\n${site}`, type };
}

/** One line of log arguments as text, skipping `skip` (the reported error). */
export function formatLogArguments(args: readonly unknown[], skip?: unknown): string {
	const parts: string[] = [];
	let length = 0;
	for (const arg of args) {
		if (arg === skip || length > LOG_MESSAGE_MAX) continue;
		let text: string;
		try {
			text =
				typeof arg === "string"
					? arg
					: isError(arg)
						? `${arg.name}: ${arg.message}`
						: (JSON.stringify(arg) ?? String(arg));
		} catch {
			text = Object.prototype.toString.call(arg);
		}
		parts.push(text);
		length += text.length + 1;
	}
	return parts.join(" ").slice(0, LOG_MESSAGE_MAX);
}

/** Attributes of a caught error logged through `source`. */
export function caughtErrorAttributes(
	source: LoggedErrorSource,
	message?: string,
	dropped = 0,
): Record<string, string | number | boolean> {
	return {
		[HANDLED_ATTRIBUTE]: true,
		[HANDLING_ATTRIBUTE]: "caught",
		[LOG_SOURCE_ATTRIBUTE]: source,
		...(message ? { [LOG_MESSAGE_ATTRIBUTE]: message.slice(0, LOG_MESSAGE_MAX) } : {}),
		...(dropped > 0 ? { [CAUGHT_DROPPED_ATTRIBUTE]: dropped } : {}),
	};
}

/** Attributes of a deliberate fallback (`runtimeContext.degraded`). */
export function degradedAttributes(
	reason: unknown,
	dropped = 0,
): Record<string, string | number | boolean> {
	let text = "";
	try {
		text = String(reason ?? "");
	} catch {
		/* unprintable reason */
	}
	return {
		[HANDLED_ATTRIBUTE]: true,
		[HANDLING_ATTRIBUTE]: "deliberate",
		[DEGRADED_REASON_ATTRIBUTE]: text.slice(0, DEGRADED_REASON_MAX) || "degraded",
		...(dropped > 0 ? { [CAUGHT_DROPPED_ATTRIBUTE]: dropped } : {}),
	};
}

/** Left-out records of one kind whose count no sent record carried. */
export interface BurstTail {
	key: string;
	type: string;
	dropped: number;
}

interface Bucket {
	tokens: number;
	at: number;
	dropped: number;
	type: string;
}

/**
 * Token bucket per kind: `burst` tokens, one more every `refillMs`. Keys
 * are kept most-recent-last and the oldest is forgotten past `maxKeys`
 * (forgetting a kind only lets more through); its uncarried count is kept
 * for the next `drain`.
 */
export class BurstLimiter {
	private readonly buckets = new Map<string, Bucket>();
	private evicted: BurstTail[] = [];

	constructor(
		private readonly burst = CAUGHT_BURST,
		private readonly refillMs = CAUGHT_REFILL_MS,
		private readonly maxKeys = 1000,
	) {}

	/**
	 * -1 when the record is left out (and counted). Otherwise it is sent,
	 * and the number of its kind left out since the last one sent is
	 * returned, to report with it.
	 */
	take(key: string, type: string, now = Date.now()): number {
		const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now, dropped: 0, type };
		this.buckets.delete(key);
		this.buckets.set(key, bucket);
		this.refill(bucket, now);
		let result: number;
		if (bucket.tokens < 1) {
			bucket.dropped += 1;
			result = -1;
		} else {
			bucket.tokens -= 1;
			result = bucket.dropped;
			bucket.dropped = 0;
		}
		while (this.buckets.size > this.maxKeys) {
			const oldest = this.buckets.keys().next().value as string;
			const gone = this.buckets.get(oldest)!;
			this.buckets.delete(oldest);
			if (gone.dropped > 0) this.evicted.push({ key: oldest, type: gone.type, dropped: gone.dropped });
		}
		return result;
	}

	/**
	 * Counts no sent record carried: kinds that have a token again (nothing
	 * of theirs came along to carry the count) or, with `all`, every kind
	 * with a count. The counts returned are reset.
	 */
	drain(now = Date.now(), all = false): BurstTail[] {
		const out = this.evicted;
		this.evicted = [];
		for (const [key, bucket] of this.buckets) {
			if (bucket.dropped === 0) continue;
			this.refill(bucket, now);
			if (!all && bucket.tokens < 1) continue;
			out.push({ key, type: bucket.type, dropped: bucket.dropped });
			bucket.dropped = 0;
		}
		return out;
	}

	/** When the next uncarried count can be drained, or null when none is pending. */
	nextDrainAt(): number | null {
		if (this.evicted.length) return 0;
		let next: number | null = null;
		for (const bucket of this.buckets.values()) {
			if (bucket.dropped === 0) continue;
			const at = bucket.at + Math.max(0, 1 - bucket.tokens) * this.refillMs;
			if (next === null || at < next) next = at;
		}
		return next;
	}

	private refill(bucket: Bucket, now: number): void {
		if (now > bucket.at) {
			bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) / this.refillMs);
			bucket.at = now;
		}
	}
}
