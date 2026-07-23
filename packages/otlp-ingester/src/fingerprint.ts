import { createHash } from "node:crypto";
import type { RuntimeOccurrenceInput } from "./types.js";

/**
 * Deterministic error grouping. Two occurrences share an issue when they
 * share source + service + error type + normalised message + top stack
 * frames + normalised route. Volatile fragments (ids, numbers, minified
 * line/column offsets) are stripped so re-deploys and per-user values don't
 * fragment issues. This algorithm must stay in sync with the Autter backend
 * so browser-relay and OTLP occurrences group identically.
 */

const UUID_RE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_RE = /\b[0-9a-f]{8,}\b/gi;
// No trailing \b: numbers glued to units ("4200ms", "3.5s", "512kb") must
// template too, or per-value messages fragment into separate fingerprints.
const NUMBER_RE = /\b\d+(\.\d+)?/g;
const QUOTED_RE = /(["'`])(?:\\.|(?!\1).)*\1/g;
// `\b` never fires between `_` and a digit (both are word chars), so
// underscore-glued ids — "prj_1013", "user_42", "order_9f3ac2d144" — escape
// NUMBER_RE/LONG_HEX_RE entirely and fragment one defect into an issue per
// id. Template the value after the underscore explicitly. (Letter-glued
// digits like "sha256"/"utf8" stay literal on purpose — those are usually
// meaningful tokens, not per-entity ids.)
const UNDERSCORE_HEX_RE = /_[0-9a-f]{8,}\b/gi;
const UNDERSCORE_NUMBER_RE = /_\d+(\.\d+)?\b/g;

export function normalizeMessage(message: string): string {
	return message
		.slice(0, 500)
		.replace(QUOTED_RE, "<str>")
		.replace(UUID_RE, "<uuid>")
		.replace(LONG_HEX_RE, "<hex>")
		.replace(UNDERSCORE_HEX_RE, "_<hex>")
		.replace(UNDERSCORE_NUMBER_RE, "_<n>")
		.replace(NUMBER_RE, "<n>")
		.replace(/\s+/g, " ")
		.trim();
}

/** Replace id-like path segments so /orders/812 and /orders/44 group. */
export function normalizeRoute(route: string | null): string {
	if (!route) return "";
	const path = route.split("?")[0] ?? "";
	return path
		.split("/")
		.map((segment) => {
			if (!segment) return segment;
			if (
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
					segment,
				)
			)
				return ":id";
			if (/^\d+$/.test(segment)) return ":id";
			if (/^[0-9a-f]{8,}$/i.test(segment)) return ":id";
			return segment;
		})
		.join("/");
}

const FRAME_LOCATION_RE = /:\d+(:\d+)?\)?$/;

export function normalizeStackFrames(
	stack: string | null,
	topN = 5,
): string[] {
	if (!stack) return [];
	return stack
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^at\s|@|^\s*File\s/.test(line) || /\.[jt]sx?/.test(line))
		.slice(0, topN)
		.map((line) =>
			line
				.replace(/\?[^:\s)]*/g, "")
				.replace(FRAME_LOCATION_RE, "")
				.replace(/\s+/g, " ")
				.trim(),
		);
}

export function fingerprintOccurrence(input: RuntimeOccurrenceInput): string {
	const parts = [
		input.source,
		input.service,
		input.errorType,
		normalizeMessage(input.message),
		...normalizeStackFrames(input.stack),
		normalizeRoute(input.route),
	];
	return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
}

/**
 * Derived, aggregation-ready fields, computed from the SAME normalisers the
 * fingerprint hashes — so a stored fingerprint can always be explained by
 * the stored columns next to it. Severity is deliberately excluded from
 * the fingerprint (a warning that escalates to an error stays one group).
 */
export interface DerivedFields {
	routeNormalized: string;
	messageNormalized: string;
	topFrames: string[];
	firstFrame: string;
}

export function deriveFields(input: RuntimeOccurrenceInput): DerivedFields {
	const topFrames = normalizeStackFrames(input.stack);
	return {
		routeNormalized: normalizeRoute(input.route),
		messageNormalized: normalizeMessage(input.message),
		topFrames,
		firstFrame: topFrames[0] ?? "",
	};
}
