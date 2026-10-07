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
 * 3. Route handlers as request wide events (1.5.0):
 *
 *      import { withRuntimeRequest, runtimeContext } from "@autter/runtime-next";
 *      export const POST = withRuntimeRequest(async (request) => {
 *        runtimeContext.set({ cart: { items: 3 } });
 *        return Response.json({ ok: true });
 *      }, { name: "checkout" });
 *
 *    The log flush is handed to Next's `after()` automatically.
 *
 * Browser tracker + error boundary live in `@autter/runtime-next/client`;
 * `middleware.ts` (edge runtime) uses `@autter/runtime-next/edge`.
 */

import {
	createBrowserRelayFetchHandler,
	initAutterServer,
	withRuntimeRequest as nodeWithRuntimeRequest,
	type AutterServer,
	type AutterServerOptions,
	type RelayOptions,
	type RuntimeRequestOptions,
} from "@autter/runtime-node";

export {
	createRuntimeLogger,
	runtimeLogger,
	withRuntimeOperation,
	flushRuntimeLogs,
	runtimeLogStats,
	type RuntimeOperation,
	type RuntimeOutcome,
	type RuntimeLogContext,
	type RuntimeLogContextValue,
	type RuntimeLogLevel,
	type RuntimeLoggingOptions,
	captureException as captureServerException,
	captureMessage as captureServerMessage,
	reportOutcome as reportServerOutcome,
	withProcessSpan,
	withLlmCall,
	trackLlmCall,
	instrumentLlmClient,
	emitLlmSelftestTrace,
	makeSafeCapture,
	installAutterAutoFlush,
	redactAttributes,
	// 1.5.0 — request wide events, coded errors, logger-only mode
	runtimeContext,
	runInBackground,
	autterRequests,
	autterFastify,
	autterErrorResponse,
	RuntimeError,
	defineRuntimeErrors,
	isRuntimeErrorLike,
	toClientError,
	errorAttributes,
	CODE_PATTERN,
	initAutterLogging,
	enrichUserAgent,
	enrichRequestSize,
	enrichEdgeGeo,
	enrichDeployment,
	otlpSink,
	consoleSink,
	fileSink,
} from "@autter/runtime-node";

export type {
	LlmCallHandle,
	LlmCallInfo,
	LlmUsage,
	TrackedLlmCall,
	InstrumentLlmOptions,
	SafeCapture,
	AutoFlushHandle,
	AutoFlushOptions,
	FlushTarget,
	RedactOptions,
	RuntimeOperationKind,
	RuntimeOperationOptions,
	RuntimeContextHandle,
	RuntimeEnricher,
	RuntimeEnrichEvent,
	RuntimeEnrichContext,
	RuntimeEvent,
	RuntimeRequestOptions,
	AutterRequestsOptions,
	AutterErrorResponseOptions,
	AutterLogging,
	AutterLoggingOptions,
	RuntimeErrorDefinition,
	RuntimeErrorExtras,
	RuntimeErrorOptions,
	RuntimeErrorLike,
	RuntimeErrorFactory,
	RuntimeErrorCatalog,
	ClientErrorBody,
	RuntimeCarrier,
	RuntimeSink,
	RuntimeSinkContext,
	OtlpSinkOptions,
	ConsoleSinkOptions,
	FileSinkOptions,
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

type AfterFn = (task: Promise<unknown> | (() => unknown)) => void;
let after: AfterFn | null | undefined;
// Resolve Next's after() once, eagerly, so it can be called synchronously
// inside the request scope. Absent (Next < 15, or outside Next): fail soft —
// the flush still runs, just without being awaited by the platform.
const afterReady: Promise<AfterFn | null> = (async () => {
	try {
		const specifier = "next/server";
		const mod = (await import(/* webpackIgnore: true */ specifier)) as {
			after?: AfterFn;
			unstable_after?: AfterFn;
		};
		after = mod.after ?? mod.unstable_after ?? null;
	} catch {
		after = null;
	}
	return after;
})();

function scheduleAfter(promise: Promise<unknown>): void {
	const run = (fn: AfterFn | null | undefined) => {
		if (!fn) return;
		try {
			fn(promise);
		} catch {
			/* outside a request scope — the flush is already in flight */
		}
	};
	if (after !== undefined) run(after);
	else void afterReady.then(run);
}

/**
 * Next.js-aware `withRuntimeRequest`: identical to the runtime-node wrapper,
 * but the log flush is handed to `after()` from `next/server` (Next 15+;
 * `unstable_after` on 14.2) unless you pass your own `waitUntil`.
 */
export function withRuntimeRequest<A extends unknown[]>(
	handler: (request: Request, ...rest: A) => Response | Promise<Response>,
	options: RuntimeRequestOptions = {},
): (request: Request, ...rest: A) => Promise<Response> {
	return nodeWithRuntimeRequest(handler, {
		...options,
		waitUntil: options.waitUntil ?? scheduleAfter,
	});
}
