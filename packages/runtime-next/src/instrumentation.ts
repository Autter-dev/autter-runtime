/**
 * `@autter/runtime-next/instrumentation` — Next.js `onRequestError` (Next 15+).
 * Errors Next catches in server components, server actions, route handlers
 * and middleware are reported with their stack and Next's context, instead
 * of arriving as stackless 500s:
 *
 *   // instrumentation.ts
 *   export { onRequestError } from "@autter/runtime-next/instrumentation";
 *
 * Safe for both runtimes Next compiles `instrumentation.ts` for:
 *
 * - Node: records the error on the request's span through the tracker that
 *   `registerAutter` started (`captureRequestError`). @autter/runtime-node is
 *   imported lazily, inside a `process.env.NEXT_RUNTIME` branch Next removes
 *   from edge bundles.
 * - Edge: the package's `edge-light`/`worker` export condition resolves to an
 *   edge-only build that never references Node code; errors go to `/v1/logs`
 *   with the `edge` options (see `autterOnRequestError`).
 */
import {
	reportOnEdge,
	requestErrorAttributes,
	shouldReport,
	type AutterOnRequestErrorOptions,
	type NextOnRequestError,
} from "./request-error.js";

export type {
	AutterOnRequestErrorOptions,
	NextOnRequestError,
	NextRequestErrorContext,
	NextRequestErrorRequest,
} from "./request-error.js";

/**
 * Build an `onRequestError` with options:
 *
 *   export const onRequestError = autterOnRequestError({
 *     edge: { apiKey: process.env.AUTTER_RUNTIME_KEY, service: "web-app" },
 *   });
 *
 * Never throws into Next.
 */
export function autterOnRequestError(
	options: AutterOnRequestErrorOptions = {},
): NextOnRequestError {
	return async function onRequestError(error, request, context) {
		try {
			if (!shouldReport(error, options.capture)) return;
			const attributes = requestErrorAttributes(error, request, context);
			if (typeof process === "undefined") {
				await reportOnEdge(options.edge, error, attributes);
				return;
			}
			// Keep this test literal: Next replaces `process.env.NEXT_RUNTIME`
			// at build time, so the edge bundle drops the Node branch (and its
			// import of @autter/runtime-node) entirely.
			if (process.env.NEXT_RUNTIME === "edge") {
				await reportOnEdge(options.edge, error, attributes);
			} else {
				const node = await import("@autter/runtime-node");
				// captureRequestError: once per error, on the request span.
				(node.captureRequestError ?? node.captureException)(error, attributes);
			}
		} catch {
			/* reporting never breaks Next's error handling */
		}
	};
}

/** Ready-made `onRequestError`: Node errors go to the `registerAutter`
 * tracker; on the edge it needs `autterOnRequestError({ edge })`. */
export const onRequestError: NextOnRequestError = autterOnRequestError();
