/**
 * @autter/runtime-browser/tracing — W3C trace propagation, so a browser
 * failure links to the server trace that served it.
 *
 * Opt-in on purpose: it does not fit the main tracker's 5 KB budget.
 * Importing this module and calling `enableTracePropagation()` turns it on:
 *
 *   import { initAutterBrowser } from "@autter/runtime-browser";
 *   import { enableTracePropagation } from "@autter/runtime-browser/tracing";
 *   initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web" });
 *   enableTracePropagation({ tracePropagationTargets: ["https://api.example.com/"] });
 *
 * Which requests get a header (`fetch` through the tracker's observer,
 * `XMLHttpRequest` through this module's own wrapper):
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

export interface TracePropagationOptions {
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
/** A request_failure is reported in the same task its request settled in. */
const FAILURE_WINDOW_MS = 100;

const TP = "traceparent";
type Xhr = XMLHttpRequest & { __autterUrl?: string; __autterTp?: string | null };
let enabled = false;
let targets: (string | RegExp)[] = [];
/** [trace id, settled at] of the request that settled last, when it was traced. */
let last: [string, number] | undefined;
let xhrWrapped = false;

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
	/** From the fetch observer: the init to send and the request's trace id. */
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
	settle,
	/**
	 * Every event the tracker reports passes here. A request_failure is
	 * reported right after its request settled; exceptions and unhandled
	 * rejections take the trace of the request that settled last.
	 */
	link(event: BrowserEvent): void {
		if (!last || event.traceId) return;
		const age = Date.now() - last[1];
		const linked =
			event.type === "request_failure"
				? age <= FAILURE_WINDOW_MS
				: (event.type === "exception" || event.type === "unhandled_rejection") && age <= LINK_WINDOW_MS;
		if (linked) event.traceId = last[0];
	},
};

/**
 * XMLHttpRequest: remember the URL (open) and any traceparent the app sets,
 * add ours at send, and report the request settled at readystatechange(4),
 * which fires before load/loadend handlers and the promise reactions they
 * trigger (axios settles there), so an error thrown from them still links.
 */
function wrapXhr(): void {
	if (xhrWrapped || typeof XMLHttpRequest === "undefined") return;
	xhrWrapped = true;
	const proto = XMLHttpRequest.prototype;
	const { open, send, setRequestHeader } = proto;
	proto.open = function (this: Xhr, ...args: unknown[]) {
		this.__autterUrl = String(args[1] ?? "");
		this.__autterTp = null;
		return Reflect.apply(open, this, args);
	} as typeof proto.open;
	proto.setRequestHeader = function (this: Xhr, name: string, value: string) {
		if (String(name).toLowerCase() === TP) this.__autterTp = String(value);
		return setRequestHeader.call(this, name, value);
	};
	proto.send = function (this: Xhr, ...args: Parameters<XMLHttpRequest["send"]>) {
		if (enabled && this.__autterUrl !== undefined) {
			try {
				const id = traceFor(this.__autterUrl, this.__autterTp, (value) => setRequestHeader.call(this, TP, value));
				this.addEventListener("readystatechange", () => {
					if (this.readyState === 4) settle(id);
				});
			} catch {
				// Telemetry must never break the request.
			}
		}
		return Reflect.apply(send, this, args);
	};
}

/**
 * Turn on W3C trace propagation for fetch (through the tracker's network
 * observer, `captureNetworkFailures`, on by default) and XMLHttpRequest.
 * Call it once, before or after `initAutterBrowser`; a later call replaces
 * the targets.
 */
export function enableTracePropagation(options: TracePropagationOptions = {}): void {
	targets = Array.isArray(options.tracePropagationTargets) ? options.tracePropagationTargets : [];
	enabled = true;
	wrapXhr();
	_useTracing(hooks as Parameters<typeof _useTracing>[0]);
}

/** Turn propagation off again (tests, or an app that starts its own tracing). */
export function disableTracePropagation(): void {
	enabled = false;
	last = undefined;
	_useTracing(undefined);
}
