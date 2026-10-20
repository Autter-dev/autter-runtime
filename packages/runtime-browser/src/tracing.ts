/**
 * @autter/runtime-browser/tracing — W3C trace propagation, so a browser
 * failure links to the server trace that served it.
 *
 * Opt-in on purpose: it does not fit the main tracker's 5 KB budget.
 * Importing this module and calling `enableTracing()` turns it on:
 *
 *   import { initAutterBrowser } from "@autter/runtime-browser";
 *   import { enableTracing } from "@autter/runtime-browser/tracing";
 *   initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web" });
 *   enableTracing({ tracePropagationTargets: ["https://api.example.com/"] });
 *
 * Which requests get a header (fetch and XMLHttpRequest, through the
 * tracker's network observers):
 * - same-origin requests, and URLs matching `tracePropagationTargets` (a
 *   string matches as a URL prefix, a RegExp is tested against the URL), get
 *   `traceparent: 00-<trace id>-<span id>-00`. Other cross-origin requests
 *   never do, so third-party APIs see no new CORS preflight;
 * - the tracker's own endpoint (the same-origin relay) never does;
 * - an existing `traceparent` is never overwritten; its trace id is used;
 * - the header is unsampled (`-00`): the browser makes no sampling decision.
 *   @autter/runtime-node applies its own `traceSampleRate` to such requests
 *   and keeps error traces in full.
 *
 * Trace ids on events:
 * - `request_failure`: the trace id its own request carried;
 * - `exception` / `unhandled_rejection`: the trace id of the request that
 *   most recently finished or failed, when that was at most 5 s earlier and
 *   that request was traced (an untraced cross-origin request settling last
 *   means no link).
 */

import { _useTracing, type BrowserEvent } from "./index";

export interface TracingOptions {
	/**
	 * Cross-origin URLs that also get a `traceparent`: a string matches as a
	 * URL prefix, a RegExp is tested against the full URL. Same-origin
	 * requests always get one. A listed API must allow the header in CORS
	 * (`Access-Control-Allow-Headers: traceparent`).
	 */
	tracePropagationTargets?: (string | RegExp)[];
}

/** How recently a request must have settled for an exception to link to it. */
export const LINK_WINDOW_MS = 5000;

const TP = "traceparent";
type Xhr = XMLHttpRequest & { __autterTp?: string | null };
let targets: (string | RegExp)[] = [];
/** [trace id, settled at] of the request that settled last, when it was traced. */
let last: [string, number] | undefined;
let setHeader: XMLHttpRequest["setRequestHeader"] | undefined;

/** A new trace id + header for same-origin and target URLs; the app's own traceparent wins. */
function traceFor(url: string, existing: string | null | undefined, set: (value: string) => void): string | undefined {
	if (existing != null) return /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}/.exec(existing.trim())?.[1];
	const href = new URL(url, location.href).href;
	const own = window.origin && window.origin !== "null" ? window.origin + "/" : null;
	const allowed =
		(own !== null && href.startsWith(own)) ||
		targets.some((target) => (typeof target === "string" ? href.startsWith(target) : href.search(target) > -1));
	if (!allowed) return undefined;
	const id = hex(16);
	set(`00-${id}-${hex(8)}-00`);
	return id;
}

/** Random lowercase hex, never all zeros (invalid in W3C trace context). */
function hex(bytes: number): string {
	const out = Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => (b | 256).toString(16).slice(1)).join("");
	return /[^0]/.test(out) ? out : hex(bytes);
}

function settle(id?: string): void {
	last = id ? [id, Date.now()] : undefined;
}

const hooks = {
	/** The init to send (with a traceparent when one is added) and the request's trace id. */
	fetch(url: string, input: RequestInfo | URL, init?: RequestInit): [RequestInit?, string?] {
		try {
			// init.headers replace a Request's own headers, as in fetch itself.
			const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
			let sent = init;
			const id = traceFor(url, headers.get(TP), (value) => {
				headers.set(TP, value);
				sent = { ...init, headers };
			});
			return [sent, id];
		} catch {
			return [init];
		}
	},
	/** From `send`: adds the header when needed and returns the request's trace id. */
	xhr(xhr: Xhr, url: string): string | undefined {
		let id: string | undefined;
		try {
			const existing = xhr.__autterTp;
			xhr.__autterTp = null;
			id = traceFor(url, existing, (value) => setHeader?.call(xhr, TP, value));
			// readystatechange(4) fires before load/loadend handlers and the
			// promise reactions they trigger (axios settles there), so an
			// error thrown from them still links to this request.
			xhr.addEventListener("readystatechange", () => {
				if (xhr.readyState === 4) settle(id);
			});
		} catch {
			// Telemetry must never break the request.
		}
		return id;
	},
	settle,
	/** Exceptions and unhandled rejections take the trace of the request that just settled. */
	link(event: BrowserEvent): void {
		if (
			last &&
			!event.traceId &&
			(event.type === "exception" || event.type === "unhandled_rejection") &&
			Date.now() - last[1] <= LINK_WINDOW_MS
		) {
			event.traceId = last[0];
		}
	},
};

/**
 * Turn on W3C trace propagation for the tracker's fetch and XHR observers
 * (`captureNetworkFailures`, on by default). Call it once, before or after
 * `initAutterBrowser`; a later call replaces the targets.
 */
export function enableTracing(options: TracingOptions = {}): void {
	targets = Array.isArray(options.tracePropagationTargets) ? options.tracePropagationTargets : [];
	if (!setHeader && typeof XMLHttpRequest !== "undefined") {
		// Remember a traceparent the app sets on an XHR, so it is never overwritten.
		const original = XMLHttpRequest.prototype.setRequestHeader;
		setHeader = original;
		XMLHttpRequest.prototype.setRequestHeader = function (this: Xhr, name: string, value: string) {
			if (String(name).toLowerCase() === TP) this.__autterTp = String(value);
			return original.call(this, name, value);
		};
	}
	_useTracing(hooks as Parameters<typeof _useTracing>[0]);
}

/** Turn propagation off again (tests, or an app that starts its own tracing). */
export function disableTracing(): void {
	_useTracing(undefined);
	last = undefined;
}
