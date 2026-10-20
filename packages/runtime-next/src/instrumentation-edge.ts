/**
 * Edge build of `@autter/runtime-next/instrumentation`, picked by bundlers
 * through the `edge-light` / `worker` export conditions (Next.js edge
 * runtime). Same API as the default build, but it never references
 * @autter/runtime-node or any Node module: errors are always sent over
 * `/v1/logs` with the `edge` options.
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

export function autterOnRequestError(
	options: AutterOnRequestErrorOptions = {},
): NextOnRequestError {
	return async function onRequestError(error, request, context) {
		try {
			if (!shouldReport(error, options.capture)) return;
			await reportOnEdge(options.edge, error, requestErrorAttributes(error, request, context));
		} catch {
			/* reporting never breaks Next's error handling */
		}
	};
}

export const onRequestError: NextOnRequestError = autterOnRequestError();
