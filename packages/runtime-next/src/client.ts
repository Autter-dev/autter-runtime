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
	captureMessage,
	trackEvent,
	setUser,
	setContext,
	flush,
	type AutterSeverity,
} from "@autter/runtime-browser";
export {
	AutterErrorBoundary,
	type AutterErrorBoundaryProps,
} from "./error-boundary.js";
