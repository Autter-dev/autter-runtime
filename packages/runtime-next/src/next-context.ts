// Next.js's per-request context, read without importing Next (it is optional
// and resolved at runtime). Shared by the server and instrumentation entries.

/**
 * The current request's `waitUntil` from Next's request context (set on the
 * edge runtime and in `next start`'s edge sandbox). Next awaits
 * `onRequestError` for middleware, but calls it fire-and-forget for errors
 * React reports during a render, so the delivery is handed to the platform
 * too: an edge function may stop once its response is done.
 */
export function nextWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
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
