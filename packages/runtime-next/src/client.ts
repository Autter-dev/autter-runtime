/**
 * Client half of @autter/runtime-next — import from `@autter/runtime-next/client`
 * in client components only. Contains zero Node code, so nothing OTel-shaped
 * ever reaches the browser bundle.
 *
 *   "use client";
 *   import { initAutterBrowser, AutterErrorBoundary } from "@autter/runtime-next/client";
 *
 *   initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" });
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
export {
	AutterErrorBoundary,
	type AutterErrorBoundaryProps,
} from "./error-boundary.js";
