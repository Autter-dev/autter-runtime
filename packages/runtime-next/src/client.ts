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
 */

export {
	initAutterBrowser,
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
// Opt-in trace propagation (EI-11): a W3C `traceparent` on same-origin and
// listed requests, so browser errors link to the server trace they caused.
// Also kept out of the main bundle; re-exported so a Next app needs no
// direct @autter/runtime-browser dependency.
export {
	enableTracePropagation,
	disableTracePropagation,
	type TracePropagationOptions,
} from "@autter/runtime-browser/tracing";
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
