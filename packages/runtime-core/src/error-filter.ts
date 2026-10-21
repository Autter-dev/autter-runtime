/**
 * Client-side volume control shared by the server SDKs (runtime-node,
 * runtime-edge; 1.8.0 / 1.2.0, EI-38): `ignoreErrors` and `sampleRate`.
 * The browser has its own copy in `@autter/runtime-browser/filters`.
 *
 * - `ignoreErrors`: strings or RegExps. A string matches when the error's
 *   type or message contains it (case-sensitive, like the message itself);
 *   a RegExp is tested against the type, the message and
 *   `"<type>: <message>"`. A match is never reported, whatever its severity.
 * - `sampleRate`: 0..1, the share of errors reported. Errors only: warnings
 *   and info messages are never sampled, and neither is a fatal error, a
 *   crash (uncaught exception) or an unhandled rejection, which may be one.
 *   Out of range or not a number: everything is reported.
 *
 * What is filtered here never leaves the process and is counted nowhere.
 * To leave errors out of every SDK at once, and see how many were left out,
 * use suppression rules in Autter (applied by the ingester, 1.9.0).
 */

export type IgnoreErrorPattern = string | RegExp;

export interface ErrorFilterOptions {
	/** Errors to never report: substrings of the type or message, or RegExps. */
	ignoreErrors?: IgnoreErrorPattern[];
	/** Share of errors reported, 0..1 (default 1). Never applied to fatal errors or crashes. */
	sampleRate?: number;
}

export interface ErrorFilterInput {
	/** Error type / class name ("TypeError"); "" when unknown. */
	type: string;
	message: string;
	/** "fatal" | "error" | "warning" | "info"; default "error". */
	severity?: string;
	/** An uncaught exception or unhandled rejection: never sampled out. */
	crash?: boolean;
}

/** True when the error should be reported. */
export type ErrorFilter = (input: ErrorFilterInput) => boolean;

function testPattern(pattern: IgnoreErrorPattern, type: string, message: string): boolean {
	if (typeof pattern === "string") {
		return pattern !== "" && (message.includes(pattern) || type.includes(pattern));
	}
	if (!(pattern instanceof RegExp)) return false;
	// A global/sticky RegExp keeps lastIndex between calls: test a copy.
	const re = pattern.global || pattern.sticky ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) : pattern;
	return re.test(message) || (type !== "" && (re.test(type) || re.test(`${type}: ${message}`)));
}

/** True when an `ignoreErrors` pattern matches the error's type or message. */
export function isIgnoredError(patterns: readonly IgnoreErrorPattern[] | undefined, type: string, message: string): boolean {
	if (!patterns?.length) return false;
	for (const pattern of patterns) {
		try {
			if (testPattern(pattern, type, message)) return true;
		} catch {
			/* a broken pattern never stops reporting */
		}
	}
	return false;
}

/** A usable sample rate below 1, or null when every error is reported. */
export function effectiveSampleRate(rate: unknown): number | null {
	return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate < 1 ? rate : null;
}

/** Build the filter once per SDK init; the returned function never throws. */
export function createErrorFilter(options: ErrorFilterOptions = {}, random: () => number = Math.random): ErrorFilter {
	const patterns = Array.isArray(options.ignoreErrors) ? options.ignoreErrors.slice() : [];
	const rate = effectiveSampleRate(options.sampleRate);
	if (!patterns.length && rate === null) return () => true;
	return (input) => {
		try {
			if (isIgnoredError(patterns, input.type ?? "", input.message ?? "")) return false;
			if (rate === null || input.crash) return true;
			const severity = input.severity ?? "error";
			if (severity !== "error") return true; // fatal, warnings and info are never sampled
			return random() < rate;
		} catch {
			return true;
		}
	};
}
