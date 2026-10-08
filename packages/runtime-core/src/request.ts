import type { RuntimeOutcome } from "./context.js";
import { isExpectedError } from "./errors.js";

/** Honoured inbound request ids: 8–128 word characters, dots or dashes. */
export const REQUEST_ID_PATTERN = /^[\w.-]{8,128}$/;
export const DEFAULT_REQUEST_ID_HEADER = "x-request-id";

function randomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	// Last resort for exotic runtimes without WebCrypto.
	return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (d) =>
		(Number(d) ^ ((Math.random() * 16) >> (Number(d) / 4))).toString(16),
	);
}

/** The inbound id when it matches REQUEST_ID_PATTERN, else a fresh UUID. */
export function resolveRequestId(header: unknown): string {
	const value = Array.isArray(header) ? header[0] : header;
	return typeof value === "string" && REQUEST_ID_PATTERN.test(value.trim())
		? value.trim()
		: randomId();
}

/** Replace id-like path segments (UUIDs, numbers, long hex) with `:id` —
 * the same rules the ingester uses for route grouping. Query strings dropped. */
export function normalizeRoutePath(path: string): string {
	const pathname = (path.split(/[?#]/)[0] ?? "") || "/";
	return pathname
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
		.join("/")
		.slice(0, 200);
}

/**
 * Compile path globs: `*` matches within one segment, `**` across
 * segments; a pattern without wildcards matches the exact path.
 */
export function compileIgnore(
	patterns: readonly string[] = [],
): (path: string) => boolean {
	const regexes = patterns.map((pattern) => {
		let source = "";
		for (let i = 0; i < pattern.length; i++) {
			const char = pattern[i]!;
			if (char === "*" && pattern[i + 1] === "*") {
				source += ".*";
				i++;
			} else if (char === "*") source += "[^/]*";
			else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
		}
		return new RegExp(`^${source}/?$`);
	});
	return (path) => {
		const pathname = path.split(/[?#]/)[0] ?? "";
		return regexes.some((re) => re.test(pathname));
	};
}

export interface RequestOutcomeInput {
	/** Outcome set explicitly via `outcome()` — always wins. */
	explicit?: RuntimeOutcome;
	/** Error recorded on the request (thrown, error middleware, capture). */
	error?: unknown;
	/** The error escaped the handler (vs. captured and recovered). */
	thrown?: boolean;
	status?: number;
	aborted?: boolean;
}

/**
 * Explicit outcome wins. Otherwise an expected coded error → degraded, a
 * thrown error or status ≥ 500 → failed, an aborted request → cancelled,
 * anything else → succeeded.
 */
export function requestOutcome(input: RequestOutcomeInput): RuntimeOutcome {
	if (input.explicit) return input.explicit;
	if (input.error !== undefined && isExpectedError(input.error)) return "degraded";
	if (input.thrown || (input.status !== undefined && input.status >= 500))
		return "failed";
	if (input.aborted) return "cancelled";
	return "succeeded";
}
