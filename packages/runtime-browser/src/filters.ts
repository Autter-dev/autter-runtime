/**
 * @autter/runtime-browser/filters — client-side volume control (1.7.0):
 * `sampleRate`, `ignoreErrors` and `denyUrls`.
 *
 * Opt-in, like `/breadcrumbs` and `/tracing`: the main tracker has no room
 * left in its 5 KB budget. It costs the main bundle nothing: the filter is a
 * `beforeSend` hook, and `withFilters` builds the init options with it.
 *
 *   import { initAutterBrowser } from "@autter/runtime-browser";
 *   import { withFilters } from "@autter/runtime-browser/filters";
 *   initAutterBrowser(withFilters({
 *     endpoint: "/api/autter-runtime",
 *     service: "web",
 *     sampleRate: 0.25,                                   // a quarter of errors
 *     ignoreErrors: ["ResizeObserver loop", /^AbortError/],
 *     denyUrls: [/^(chrome|moz|safari-web)-extension:/, "googletagmanager.com"],
 *   }));
 *
 * - `sampleRate` (0..1, default 1): the share of errors sent. Errors only
 *   (exceptions, unhandled rejections, outcomes, failed requests, CSP
 *   violations, error messages); usage events, timings, warnings and info
 *   are never sampled, and neither is a `fatal` message.
 * - `ignoreErrors`: strings match when the error's type or message contains
 *   them (case-sensitive); RegExps are tested against the type, the message
 *   and `"<type>: <message>"`. Matched against the message as it is sent
 *   (after secret/PII scrubbing).
 * - `denyUrls`: errors whose script is listed are never sent: the script is
 *   the error event's file, else the URL of the innermost stack frame that
 *   has one. Strings match when the URL contains them; RegExps are tested
 *   against it. For third-party scripts and browser extensions.
 *
 * A `beforeSend` in the options still runs, after the filters. What is
 * filtered here never leaves the page and is counted nowhere; suppression
 * rules in Autter (ingester 1.9.0) leave errors out at ingest and count them.
 */

import type { AutterBrowserOptions, BrowserEvent } from "./index";

export type FilterPattern = string | RegExp;

export interface AutterFilterOptions {
	/** Share of errors sent, 0..1 (default 1). Never applied to fatal messages, usage events or timings. */
	sampleRate?: number;
	/** Errors never sent: substrings of the type or message, or RegExps. */
	ignoreErrors?: FilterPattern[];
	/** Errors from these scripts are never sent: substrings of the script URL, or RegExps. */
	denyUrls?: FilterPattern[];
}

type BeforeSend = NonNullable<AutterBrowserOptions["beforeSend"]>;

const ERROR_TYPES = ["exception", "unhandled_rejection", "outcome", "request_failure", "csp_violation", "message"];

function matches(patterns: FilterPattern[] | undefined, values: string[]): boolean {
	for (const pattern of patterns || []) {
		for (const value of values) {
			try {
				if (typeof pattern === "string" ? pattern && value.indexOf(pattern) > -1 : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(value)) return true;
			} catch {
				/* not a pattern: matches nothing */
			}
		}
	}
	return false;
}

/** The script an error came from: its file, else the innermost stack frame with a URL. */
export function errorScriptUrl(event: Pick<BrowserEvent, "filename" | "stack">): string | undefined {
	if (event.filename) return event.filename;
	for (const line of (event.stack || "").split("\n")) {
		// V8 "    at fn (https://…/app.js:1:2)" / "    at https://…", Firefox and Safari "fn@https://…:1:2".
		const frame = /(?:^\s*at\s.*?|@)([a-z][\w+.-]*:\/\/[^\s()]+)/i.exec(line);
		if (frame) return frame[1]!.replace(/(:\d+){1,2}$/, "");
	}
	return undefined;
}

/**
 * The filter as a `beforeSend` hook: returns null for an event to leave out,
 * else hands it to `next` (your own hook) or returns it.
 */
export function createFilter(options: AutterFilterOptions, next?: BeforeSend): BeforeSend {
	const rate = options.sampleRate;
	const sampling = typeof rate === "number" && rate >= 0 && rate < 1;
	return (event) => {
		if (ERROR_TYPES.indexOf(event.type) > -1) {
			const type = event.errorType || "";
			if (matches(options.ignoreErrors, type ? [event.message, type, `${type}: ${event.message}`] : [event.message])) return null;
			const url = errorScriptUrl(event);
			if (url && matches(options.denyUrls, [url])) return null;
			const severity = event.severity || (event.type === "message" ? "warning" : "error");
			if (sampling && severity === "error" && Math.random() >= rate!) return null;
		}
		return next ? next(event) : event;
	};
}

/** `initAutterBrowser` options with the filters installed as `beforeSend` (yours runs after them). */
export function withFilters(options: AutterBrowserOptions & AutterFilterOptions): AutterBrowserOptions {
	const { sampleRate, ignoreErrors, denyUrls, ...rest } = options;
	return { ...rest, beforeSend: createFilter({ sampleRate, ignoreErrors, denyUrls }, options.beforeSend) };
}
