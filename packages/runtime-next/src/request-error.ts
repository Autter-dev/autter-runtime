/**
 * Shared, runtime-neutral half of Next.js `onRequestError` support. Imports
 * only @autter/runtime-edge (no Node modules), so it is safe in the edge
 * bundle; the Node half lives behind a dynamic import in instrumentation.ts.
 */
import { captureEdgeException, type AutterEdgeOptions } from "@autter/runtime-edge";

/** Next.js `onRequestError` request argument (typed structurally; no `next` dependency). */
export interface NextRequestErrorRequest {
	/** Resource path, e.g. `/blog?name=foo` — recorded without the query string. */
	path?: string;
	method?: string;
	/** Never read: cookies and auth headers stay out of telemetry. */
	headers?: unknown;
}

/** Next.js `onRequestError` context argument. */
export interface NextRequestErrorContext {
	/** `"App Router"` or `"Pages Router"` (also what Next passes for middleware and edge route handlers). */
	routerKind?: string;
	/**
	 * The route template, e.g. `/blog/[slug]` or `/api/orders`. Middleware:
	 * `/middleware` (Next 15) or `/proxy` (Next 16). An edge route handler
	 * reported by `next start`: the page, e.g. `/api/orders/route`.
	 */
	routePath?: string;
	/** `"render"`, `"route"`, `"action"`, `"middleware"` (Next 15) or `"proxy"` (Next 16). */
	routeType?: string;
	/** `"react-server-components"`, `"react-server-components-payload"` or `"server-rendering"`. */
	renderSource?: string;
	/** `"on-demand"`, `"stale"` or undefined (a normal request). */
	revalidateReason?: string;
	/** `"dynamic"` or `"dynamic-resume"` (PPR). */
	renderType?: string;
}

/** The function Next.js calls from `instrumentation.ts`. */
export type NextOnRequestError = (
	error: unknown,
	request: NextRequestErrorRequest,
	context: NextRequestErrorContext,
) => Promise<void>;

export interface AutterOnRequestErrorOptions {
	/**
	 * Which errors to report. Default: every error except Next's control-flow
	 * signals (`redirect()`, `notFound()`, `forbidden()`, `unauthorized()`,
	 * dynamic-rendering bailouts). `true` reports everything; a predicate
	 * decides per error.
	 */
	capture?: boolean | ((error: unknown) => boolean);
	/**
	 * Edge runtime only (middleware, `export const runtime = "edge"`): the
	 * Node tracker does not run there, so errors are sent straight to the
	 * ingester's `/v1/logs` with these options — a SERVER key. A function is
	 * called per error. Without it, edge errors are skipped (one warning).
	 */
	edge?: AutterEdgeOptions | (() => AutterEdgeOptions | undefined);
}

/** Digests Next attaches to its control-flow "errors". */
const CONTROL_FLOW_DIGEST =
	/^(?:NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)\b/;

function digestOf(error: unknown): string {
	try {
		const digest = (error as { digest?: unknown } | null)?.digest;
		return typeof digest === "string" ? digest : "";
	} catch {
		return "";
	}
}

export function shouldReport(
	error: unknown,
	rule: AutterOnRequestErrorOptions["capture"],
): boolean {
	if (rule === true) return true;
	if (rule === false) return false;
	if (typeof rule === "function") {
		try {
			return rule(error) === true;
		} catch {
			return false;
		}
	}
	return !CONTROL_FLOW_DIGEST.test(digestOf(error));
}

/**
 * Next's context as span/record attributes: route, router kind, route type,
 * render source/type, revalidate reason, digest, request method and path
 * (query string and fragment dropped). Headers are never read.
 */
export function requestErrorAttributes(
	error: unknown,
	request: NextRequestErrorRequest | undefined,
	context: NextRequestErrorContext | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	const put = (key: string, read: () => unknown, max: number) => {
		try {
			const value = read();
			if (typeof value === "string" && value) out[key] = value.slice(0, max);
		} catch {
			/* hostile getter: skip the field */
		}
	};
	put("next.route_path", () => context?.routePath, 500);
	put("next.router_kind", () => context?.routerKind, 40);
	put("next.route_type", () => context?.routeType, 40);
	put("next.render_source", () => context?.renderSource, 80);
	put("next.render_type", () => context?.renderType, 40);
	put("next.revalidate_reason", () => context?.revalidateReason, 40);
	put("next.digest", () => digestOf(error), 100);
	put("http.request.method", () => {
		const method = request?.method;
		return typeof method === "string" ? method.toUpperCase() : undefined;
	}, 16);
	put("url.path", () => {
		const path = request?.path;
		return typeof path === "string" ? (path.split(/[?#]/)[0] ?? "") : undefined;
	}, 1000);
	return out;
}

let warnedNoEdgeOptions = false;

/**
 * The current request's `waitUntil` from Next's request context (set on the
 * edge runtime and in `next start`'s edge sandbox). Next awaits
 * `onRequestError` for middleware, but calls it fire-and-forget for errors
 * React reports during a render, so the delivery is handed to the platform
 * too: an edge function may stop once its response is done.
 */
function nextWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
	try {
		const store = (globalThis as Record<symbol, unknown>)[Symbol.for("@next/request-context")] as
			| { get?: () => { waitUntil?: unknown } | undefined }
			| undefined;
		const context = typeof store?.get === "function" ? store.get() : undefined;
		const waitUntil = context?.waitUntil;
		if (typeof waitUntil !== "function") return undefined;
		return (promise) => (waitUntil as (promise: Promise<unknown>) => void).call(context, promise);
	} catch {
		return undefined;
	}
}

/** Edge runtime: one promoted error record over `/v1/logs`. */
export async function reportOnEdge(
	edge: AutterOnRequestErrorOptions["edge"],
	error: unknown,
	attributes: Record<string, string>,
): Promise<void> {
	const options = typeof edge === "function" ? edge() : edge;
	if (!options) {
		if (!warnedNoEdgeOptions) {
			warnedNoEdgeOptions = true;
			console.warn(
				"[autter-runtime] onRequestError ran on the edge runtime without edge options; " +
					"use autterOnRequestError({ edge: { apiKey, service } }) to report edge errors",
			);
		}
		return;
	}
	const delivery = captureEdgeException(options, error, attributes);
	try {
		nextWaitUntil()?.(delivery);
	} catch {
		/* no waitUntil: awaiting below is all there is */
	}
	await delivery;
}
