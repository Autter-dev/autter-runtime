/**
 * Edge build of the `@autter/runtime-next` root, picked by bundlers through
 * the `edge-light` / `worker` export conditions (Next.js edge runtime:
 * `middleware.ts`, `export const runtime = "edge"` routes; Workers), like
 * `@autter/runtime-next/instrumentation` already is.
 *
 * Same contract as the browser build (`index.browser.ts`): every name the
 * server root exports, with the same types. The coded-error helpers come
 * from @autter/runtime-edge, so a `RuntimeError` built from a shared catalog
 * is the very class `withAutter` from `@autter/runtime-next/edge` checks;
 * the other server exports are stand-ins (no-ops that warn once in
 * development, or a "server-only" error pointing to
 * `@autter/runtime-next/edge`). Never imports @autter/runtime-node,
 * OpenTelemetry or a Node module.
 */
import { serverStandIns } from "./server-stand-ins.js";

export {
	CODE_PATTERN,
	RuntimeError,
	defineRuntimeErrors,
	isRuntimeErrorLike,
	toClientError,
} from "@autter/runtime-edge";
export { errorAttributes, redactAttributes, redactText } from "@autter/runtime-core";

export const {
	addBreadcrumb,
	autterErrorHandler,
	autterErrorResponse,
	autterFastify,
	autterFastifyErrors,
	autterKoa,
	autterRequests,
	captureRequestError,
	captureServerException,
	captureServerMessage,
	consoleSink,
	createAutterRelayRoute,
	createRuntimeLogger,
	emitLlmSelftestTrace,
	enrichDeployment,
	enrichEdgeGeo,
	enrichRequestSize,
	enrichUserAgent,
	fileSink,
	flushRuntimeLogs,
	initAutterLogging,
	installAutterAutoFlush,
	instrumentLlmClient,
	makeSafeCapture,
	otlpSink,
	registerAutter,
	reportServerOutcome,
	runInBackground,
	runtimeContext,
	runtimeLogStats,
	runtimeLogger,
	trackLlmCall,
	withAutter,
	withLlmCall,
	withProcessSpan,
	withRuntimeOperation,
	withRuntimeRequest,
} = serverStandIns("edge");

// The server root's types, so this build's declarations match it name for name.
export type * from "./server.js";

/* Compile-time parity with the server root; see index.browser.ts. */
type Root = typeof import("./index.js");
type Self = typeof import("./index.edge.js");
type Assert<T extends true> = T;
type _EdgeRootParity = [
	Assert<[keyof Root] extends [keyof Self] ? ([keyof Self] extends [keyof Root] ? true : false) : false>,
	Assert<Self extends Pick<Root, keyof Self> ? true : false>,
];
