/**
 * Browser build of the `@autter/runtime-next` root, picked by bundlers
 * through the `browser` export condition (Next.js client components,
 * Turbopack and webpack client builds, Vite).
 *
 * It exists for modules that both client and server code import, such as an
 * error catalog:
 *
 *   // lib/errors.ts, imported by a client component and a route handler
 *   import { defineRuntimeErrors } from "@autter/runtime-next";
 *   export const orderErrors = defineRuntimeErrors({ ... });
 *
 * It exports every name the server root exports, with the same types:
 *
 * - the coded-error and redaction helpers are the real ones (pure code from
 *   @autter/runtime-core, bundled in);
 * - everything else is a stand-in from `server-stand-ins.ts`: capture and
 *   log calls are no-ops that warn once in development, setup functions
 *   (`registerAutter`, `withAutter`, …) throw a "server-only" error when
 *   called.
 *
 * Never imports @autter/runtime-node, OpenTelemetry or a Node module. The
 * browser tracker and React components stay in `@autter/runtime-next/client`.
 */
import { serverStandIns } from "./server-stand-ins.js";

export {
	CODE_PATTERN,
	RuntimeError,
	defineRuntimeErrors,
	isRuntimeErrorLike,
	toClientError,
	errorAttributes,
	redactAttributes,
	redactText,
} from "@autter/runtime-core";

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
} = serverStandIns("browser");

// The server root's types, so this build's declarations match it name for name.
export type * from "./server.js";

/*
 * Compile-time parity with the server root (checked by the build's
 * declaration step): the same value names, each assignable to its server
 * type. test/root-builds.test.mjs checks the built files too.
 */
type Root = typeof import("./index.js");
type Self = typeof import("./index.browser.js");
type Assert<T extends true> = T;
type _BrowserRootParity = [
	Assert<[keyof Root] extends [keyof Self] ? ([keyof Self] extends [keyof Root] ? true : false) : false>,
	Assert<Self extends Pick<Root, keyof Self> ? true : false>,
];
