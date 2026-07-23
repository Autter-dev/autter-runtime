/**
 * Server half of @autter/runtime-next. Safe to import anywhere Node runs:
 * `instrumentation.ts`, route handlers, server components, server actions.
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
 * Browser tracker + error boundary live in `@autter/runtime-next/client`.
 */

import {
	createBrowserRelayFetchHandler,
	initAutterServer,
	type AutterServer,
	type AutterServerOptions,
	type RelayOptions,
} from "@autter/runtime-node";

export {
	captureException as captureServerException,
	captureMessage as captureServerMessage,
} from "@autter/runtime-node";
export type { AutterServer, AutterServerOptions, RelayOptions };

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
