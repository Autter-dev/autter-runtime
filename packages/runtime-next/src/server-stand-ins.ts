/**
 * Stand-ins for the server-only exports of the root entry, shared by its
 * browser build (`index.browser.ts`) and its edge build (`index.edge.ts`).
 *
 * A module that both client and server code import (an error catalog, a
 * `lib/telemetry.ts`) imports the root, and the bundler picks the root's
 * build by export condition. Those builds must export every name the server
 * root exports, or the shared module fails with "export not found". So each
 * server-only name gets a stand-in here:
 *
 * - capture, log and context calls are no-ops (callbacks they wrap still
 *   run) that warn once per name, in development only;
 * - config builders (sinks, enrichers) return inert values, because a shared
 *   config module may build them at import time;
 * - setup and server wrappers (`registerAutter`, `withAutter`, …) throw a
 *   clear "server-only" error when called.
 *
 * Nothing here runs at import time, nothing imports Node modules or
 * @autter/runtime-node: `import type` is erased from the build.
 */
import type * as Server from "./server.js";

export type RootBuild = "browser" | "edge";

/** Root exports that are real (isomorphic) in every build. */
export type IsomorphicName =
	| "CODE_PATTERN"
	| "RuntimeError"
	| "defineRuntimeErrors"
	| "isRuntimeErrorLike"
	| "toClientError"
	| "errorAttributes"
	| "redactAttributes"
	| "redactText";

/** Every other root export: it needs a stand-in outside Node. */
export type StandInName = Exclude<keyof typeof Server, IsomorphicName>;

export type ServerStandIns = { [K in StandInName]: (typeof Server)[K] };

const WHERE: Record<RootBuild, string> = {
	browser: 'its browser build (the "browser" export condition)',
	edge: 'its edge build (the "edge-light" / "worker" export conditions)',
};

const INSTEAD: Record<RootBuild, string> = {
	browser:
		"In client components, use @autter/runtime-next/client (initAutterBrowser, captureException, AutterErrorBoundary).",
	edge: "On the edge runtime (middleware, `export const runtime = \"edge\"` routes), use @autter/runtime-next/edge.",
};

function isDevelopment(): boolean {
	try {
		// Kept literal so bundlers replace it; `process` may not exist at all.
		return process.env.NODE_ENV === "development";
	} catch {
		return false;
	}
}

/** The message a server-only stand-in throws. */
export function serverOnlyMessage(name: string, build: RootBuild): string {
	return (
		`${name}() is server-only, but "@autter/runtime-next" resolved to ${WHERE[build]} here. ` +
		`Call it from Node.js server code (instrumentation.ts, route handlers, server actions). ${INSTEAD[build]}`
	);
}

/**
 * Build the stand-ins for one build. The return type is every server-only
 * root export with its server type, so a new server export fails the build
 * until it has a stand-in here.
 */
export function serverStandIns(build: RootBuild): ServerStandIns {
	const warned = new Set<string>();
	const dropped = (name: string): void => {
		if (warned.has(name) || !isDevelopment()) return;
		warned.add(name);
		try {
			console.warn(
				`[autter] ${name}() did nothing: "@autter/runtime-next" resolved to ${WHERE[build]}, ` +
					`which has no server tracker. ${INSTEAD[build]} (Shown once, in development only.)`,
			);
		} catch {
			/* no console */
		}
	};
	const serverOnly =
		(name: string) =>
		// `any[]`: assignable to every server signature it stands in for.
		(..._args: any[]): never => {
			throw new Error(serverOnlyMessage(name, build));
		};
	const operation = (): Server.RuntimeOperation => ({
		id: "",
		setContext() {},
		outcome() {},
		step: async (_name, fn) => fn(),
	});
	const logger = (name: string): ReturnType<typeof Server.createRuntimeLogger> => ({
		debug: () => dropped(`${name}.debug`),
		info: () => dropped(`${name}.info`),
		warn: () => dropped(`${name}.warn`),
		error: () => dropped(`${name}.error`),
	});
	const sink = (name: string) => () => ({ name, write() {} });
	const enricher = () => () => {};

	return {
		// Capture and logging: no-ops.
		captureServerException: () => dropped("captureServerException"),
		captureServerMessage: () => dropped("captureServerMessage"),
		reportServerOutcome: () => dropped("reportServerOutcome"),
		captureRequestError: () => dropped("captureRequestError"),
		trackLlmCall: () => dropped("trackLlmCall"),
		addBreadcrumb: () => dropped("addBreadcrumb"),
		makeSafeCapture: () => ({
			captureException: () => dropped("makeSafeCapture().captureException"),
			captureMessage: () => dropped("makeSafeCapture().captureMessage"),
		}),
		runtimeLogger: logger("runtimeLogger"),
		createRuntimeLogger: () => logger("createRuntimeLogger()"),
		runtimeContext: {
			set: () => dropped("runtimeContext.set"),
			outcome: () => dropped("runtimeContext.outcome"),
			debug: () => dropped("runtimeContext.debug"),
			info: () => dropped("runtimeContext.info"),
			warn: () => dropped("runtimeContext.warn"),
			error: () => dropped("runtimeContext.error"),
			degraded: () => dropped("runtimeContext.degraded"),
			id: undefined,
			requestId: undefined,
			fork: async (_name, fn) => {
				dropped("runtimeContext.fork");
				return fn(operation());
			},
			carrier: () => undefined,
			// No operation here, so nothing to carry: the target comes back unchanged.
			inject: (target) => target,
		},
		flushRuntimeLogs: async () => ({ ok: true, errors: [] }),
		runtimeLogStats: () => ({ buffered: 0, dropped: 0 }),
		// Wrappers around the app's own work: run it, record nothing.
		withRuntimeOperation: async (_name, fn) => {
			dropped("withRuntimeOperation");
			return fn(operation());
		},
		runInBackground: async (name, fn) => {
			dropped("runInBackground");
			// Never rejects, like the server version; the error is not reported.
			try {
				return await fn(operation());
			} catch (error) {
				if (isDevelopment()) console.error(`[autter] runInBackground("${name}") failed:`, error);
				return undefined;
			}
		},
		withProcessSpan: async (_name, fn) => {
			dropped("withProcessSpan");
			return fn();
		},
		instrumentLlmClient: (client) => {
			dropped("instrumentLlmClient");
			return client;
		},
		// Config builders: inert values (only useful to initAutterLogging, which throws).
		otlpSink: sink("otlp"),
		consoleSink: sink("console"),
		fileSink: sink("file"),
		enrichUserAgent: enricher,
		enrichRequestSize: enricher,
		enrichEdgeGeo: enricher,
		enrichDeployment: enricher,
		// Setup and server wrappers: throw when called.
		registerAutter: serverOnly("registerAutter"),
		createAutterRelayRoute: serverOnly("createAutterRelayRoute"),
		withRuntimeRequest: serverOnly("withRuntimeRequest"),
		withAutter: serverOnly("withAutter"),
		withLlmCall: serverOnly("withLlmCall"),
		emitLlmSelftestTrace: serverOnly("emitLlmSelftestTrace"),
		installAutterAutoFlush: serverOnly("installAutterAutoFlush"),
		initAutterLogging: serverOnly("initAutterLogging"),
		autterRequests: serverOnly("autterRequests"),
		autterFastify: serverOnly("autterFastify"),
		autterErrorResponse: serverOnly("autterErrorResponse"),
		autterErrorHandler: serverOnly("autterErrorHandler"),
		autterFastifyErrors: serverOnly("autterFastifyErrors"),
		autterKoa: serverOnly("autterKoa"),
	};
}
