/**
 * Client half of @autter/runtime-next — import from `@autter/runtime-next/client`
 * in client components only. Contains zero Node code, so nothing OTel-shaped
 * ever reaches the browser bundle.
 *
 *   "use client";
 *   import { initAutterBrowser, AutterErrorBoundary } from "@autter/runtime-next/client";
 *
 *   initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" });
 *
 * `sampleRate`, `ignoreErrors` and `denyUrls` (1.8.0) wrap the options:
 *
 *   initAutterBrowser(withFilters({ endpoint: "/api/autter-runtime", service: "web-app", sampleRate: 0.5 }));
 *
 * Trace propagation is on by default here, unlike in plain
 * @autter/runtime-browser: same-origin requests carry a W3C `traceparent`,
 * so a browser error links to the server trace of the request behind it.
 * `tracePropagation: false` turns it off; `tracePropagationTargets` adds
 * cross-origin APIs you control.
 */

import { initAutterBrowser as startTracker, type AutterBrowserOptions } from "@autter/runtime-browser";
import {
	enableTracePropagation as enableTracing,
	disableTracePropagation as disableTracing,
	type TracePropagationOptions,
} from "@autter/runtime-browser/tracing";

export interface AutterNextBrowserOptions extends AutterBrowserOptions {
	/**
	 * W3C trace propagation (default true): same-origin `fetch` and XHR
	 * requests carry a `traceparent` header, which `registerAutter` continues,
	 * so a browser error links to the server trace of the request behind it.
	 * Cross-origin requests get one only when listed in
	 * `tracePropagationTargets`, and the tracker's own endpoint never does.
	 * `false` turns it off. `fetch` is traced through the network observer,
	 * so `captureNetworkFailures: false` turns it off for `fetch` too.
	 */
	tracePropagation?: boolean;
	/**
	 * Cross-origin URLs that also get a `traceparent`: a string matches as a
	 * URL prefix, a RegExp is tested against the full URL. List only APIs you
	 * control, and allow the header in their CORS response
	 * (`Access-Control-Allow-Headers: traceparent`).
	 */
	tracePropagationTargets?: TracePropagationOptions["tracePropagationTargets"];
}

/** The tracker was started in this page: the first call in a browser wins, as in the tracker itself. */
let started = false;
/** The app called enableTracePropagation or disableTracePropagation itself: its choice is kept. */
let chosen = false;

/**
 * Start the browser tracker (`@autter/runtime-browser`'s initAutterBrowser)
 * and, unless `tracePropagation: false`, trace propagation for same-origin
 * requests and `tracePropagationTargets`. Does nothing outside a browser
 * (server rendering of a client component) and nothing on a second call.
 */
export function initAutterBrowser(options: AutterNextBrowserOptions): void {
	const { tracePropagation, tracePropagationTargets, ...tracker } = options;
	startTracker(tracker);
	if (started || typeof window === "undefined") return;
	started = true;
	// enableTracePropagation({ tracePropagationTargets }) or
	// disableTracePropagation() called before this keeps its effect.
	if (tracePropagation === false || chosen) return;
	enableTracing(tracePropagationTargets ? { tracePropagationTargets } : {});
}

/**
 * Turn trace propagation on, or replace its targets. initAutterBrowser
 * already turns it on for same-origin requests; called before it, this
 * call's targets are kept. The same switch as
 * `@autter/runtime-browser/tracing`, on the same tracker.
 */
export function enableTracePropagation(options: TracePropagationOptions = {}): void {
	chosen = true;
	enableTracing(options);
}

/** Turn trace propagation off: at runtime, or before initAutterBrowser to keep it off. */
export function disableTracePropagation(): void {
	chosen = true;
	disableTracing();
}

export type { TracePropagationOptions };

export {
	captureException,
	captureOutcome,
	captureMessage,
	trackEvent,
	setUser,
	setContext,
	flush,
	autterErrorFromResponse,
	type AutterSeverity,
} from "@autter/runtime-browser";
// Opt-in breadcrumbs (kept out of the main tracker's 5 KB bundle).
export {
	enableBreadcrumbs,
	addBreadcrumb,
	clearBreadcrumbs,
	type Breadcrumb,
	type BreadcrumbInput,
	type BreadcrumbOptions,
} from "@autter/runtime-browser/breadcrumbs";
// Opt-in client-side volume control (EI-38): sampleRate, ignoreErrors and
// denyUrls as a beforeSend filter, outside the main tracker's bundle.
//   initAutterBrowser(withFilters({ endpoint, service, sampleRate: 0.5, ignoreErrors: [/ResizeObserver/] }));
export {
	withFilters,
	createFilter,
	type AutterFilterOptions,
	type FilterPattern,
} from "@autter/runtime-browser/filters";
export {
	AutterErrorBoundary,
	type AutterErrorBoundaryProps,
} from "./error-boundary.js";
// Next.js error pages (RF-04): app/error.tsx and app/global-error.tsx.
export {
	AutterGlobalError,
	reportNextError,
	useAutterErrorReport,
	type AutterGlobalErrorProps,
	type NextErrorReportOptions,
} from "./error-page.js";
