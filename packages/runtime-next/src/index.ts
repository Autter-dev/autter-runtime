/**
 * @autter/runtime-next — one-command Autter Runtime for Next.js.
 *
 * 1. `instrumentation.ts` (server tracing):
 *
 *      export async function register() {
 *        if (process.env.NEXT_RUNTIME === "nodejs") {
 *          const { registerAutter } = await import("@autter/runtime-next");
 *          registerAutter({
 *            apiKey: process.env.AUTTER_RUNTIME_KEY!,
 *            service: "web-app",
 *            release: process.env.GIT_SHA,
 *          });
 *        }
 *      }
 *
 * 2. `app/api/autter-runtime/route.ts` (browser relay):
 *
 *      import { createAutterRelayRoute } from "@autter/runtime-next";
 *      export const { POST } = createAutterRelayRoute({
 *        apiKey: process.env.AUTTER_RUNTIME_KEY!,
 *      });
 *
 * 3. A client component (browser tracker + boundary):
 *
 *      "use client";
 *      import { initAutterBrowser, AutterErrorBoundary } from "@autter/runtime-next";
 *      initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" });
 */

import {
	createBrowserRelayFetchHandler,
	initAutterServer,
	type AutterServer,
	type AutterServerOptions,
	type RelayOptions,
} from "@autter/runtime-node";

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
export {
	captureException as captureServerException,
	captureMessage as captureServerMessage,
} from "@autter/runtime-node";

/** Server OTel init for Next.js `instrumentation.ts`. */
export function registerAutter(options: AutterServerOptions): AutterServer {
	return initAutterServer(options);
}

/** App Router relay route: `export const { POST } = createAutterRelayRoute({...})`. */
export function createAutterRelayRoute(options: RelayOptions): {
	POST: (request: Request) => Promise<Response>;
} {
	return { POST: createBrowserRelayFetchHandler(options) };
}
