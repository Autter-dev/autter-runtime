/**
 * @autter/runtime-browser — tiny, dependency-free error + usage tracker.
 *
 * Design constraints (non-negotiable):
 * - zero runtime dependencies, < 5 KB gzipped (CI-enforced)
 * - no OTel SDK, no console patching, no DOM recording, no offline storage
 * - privacy by construction: pathname-only routes, no cookies / form values /
 *   request bodies; query strings stripped everywhere; custom context is
 *   scrubbed for obvious PII (emails, sensitive keys) before send
 *
 * Payload contract: `/v1/browser` version 1 of the Autter otlp-ingester,
 * normally reached through the customer's same-origin relay
 * (`createBrowserRelayHandler` in @autter/runtime-node).
 */

export interface AutterBrowserOptions {
	/**
	 * Where to send events:
	 * - same-origin relay URL, e.g. "/api/autter-runtime" (recommended), or
	 * - the ingester's browser endpoint, e.g. "https://otlp.autter.dev/v1/browser",
	 *   together with a publishable `clientKey`.
	 */
	endpoint: string;
	/**
	 * PUBLISHABLE client key (autter_rtc_…) for direct cross-origin ingest —
	 * only valid on the browser endpoint, origin-restricted server-side.
	 * Never put a secret server key here. Omit when using a relay.
	 */
	clientKey?: string;
	service: string;
	environment?: string;
	release?: string;
	/** Send a session_start ping on init (default true). */
	sessionTracking?: boolean;
	/** Last-chance hook: mutate or drop (return null) an event before send. */
	beforeSend?: (event: BrowserEvent) => BrowserEvent | null;
	/** Observe failed fetch and XHR requests and 5xx responses (default true). */
	captureNetworkFailures?: boolean;
	/** Observe long tasks and slow resource timings (default true). */
	captureTimings?: boolean;
	/** Attach the last safe click or form action to failures (default true). */
	captureActions?: boolean;
}

export type AutterSeverity = "fatal" | "error" | "warning" | "info";

export interface BrowserEvent {
	type:
		| "exception"
		| "unhandled_rejection"
		| "message"
		| "session_start"
		| "track_event"
		| "outcome"
		| "request_failure"
		| "csp_violation"
		| "timing";
	timestamp: string;
	/** Signal level; the ingester defaults it per type when omitted. */
	severity?: AutterSeverity;
	message: string;
	name?: string;
	stack?: string;
	errorType?: string;
	filename?: string;
	line?: number;
	column?: number;
	route?: string;
	context?: Record<string, unknown>;
	durationMs?: number;
}

const MAX_QUEUE = 10;
const FLUSH_INTERVAL_MS = 5000;
const ERROR_FLUSH_DELAY_MS = 500;
const MAX_EVENTS_PER_SESSION = 200;

let opts: Required<Pick<AutterBrowserOptions, "endpoint" | "service">> &
	AutterBrowserOptions;
let queue: BrowserEvent[] = [];
let sessionId = "";
let userId: string | undefined;
let globalContext: Record<string, unknown> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let sentCount = 0;
let initialized = false;
let timingCount = 0;
let lastAction: { name: string; at: number; route: string } | undefined;
const ACTION_WINDOW_MS = 30_000;
const TRAIL_MAX = 8;
let trail: string[] = [];
let clientCache: { browser: string; os: string } | undefined;
let seenCspPolicyHash = "";

function uid(): string {
	try {
		return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	} catch {
		return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
	}
}

function getSessionId(): string {
	try {
		const KEY = "autter_sid";
		const existing = sessionStorage.getItem(KEY);
		if (existing) return existing;
		const fresh = "s_" + uid();
		sessionStorage.setItem(KEY, fresh);
		return fresh;
	} catch {
		return "s_" + uid();
	}
}

function stripQuery(value: string | undefined): string | undefined {
	return value ? value.split("?")[0] : undefined;
}

// Mini redaction — the browser twin of redactAttributes() in
// @autter/runtime-node. Custom context is free-form, so values under
// sensitive-looking keys and email-shaped strings are masked before
// anything leaves the page. Deliberately tiny: this bundle is size-capped.
const SENSITIVE_KEY_RE =
	/email|pass|token|secret|^auth([-_.]|$)|authorization|bearer|cookie|credential|api[-_.]?key|ssn|cvv|card([-_. ]?(number|num|no))?$/i;
// Bounded quantifiers keep this linear (lookbehind would break older
// Safari); scrub() also caps the input it scans.
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi;
const MASK = "[redacted]";
const scrub = (value: string) => value.slice(0, 8192).replace(EMAIL_RE, MASK);

export function redactContext(
	context: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key in context) {
		const value = context[key];
		out[key] = SENSITIVE_KEY_RE.test(key)
			? MASK
			: typeof value === "string"
				? scrub(value)
				: value;
	}
	return out;
}

// Coded errors: the same CODE_PATTERN as runtime-core and the ingester. A
// value that doesn't match (e.g. "ECONNRESET") is simply not sent, and the
// error groups by message as before.
const CODE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
const REQUEST_ID_RE = /^[\w.-]{8,128}$/;

/**
 * Declared error fields duck-typed off ANY thrown value — RuntimeError,
 * `autterErrorFromResponse` results, or an app's own error class with a
 * `code` property — as `autter.error.*` / `autter.request.id` context keys.
 */
function errorContext(error: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!error || typeof error !== "object") return out;
	// Metadata is optional: a throwing getter or Proxy must never stop the
	// original error from being reported, so read every field defensively.
	const e: Record<string, unknown> = {};
	for (const key of ["code", "why", "fix", "link", "expected", "requestId"]) {
		try {
			e[key] = (error as Record<string, unknown>)[key];
		} catch {
			/* ignore unreadable metadata */
		}
	}
	if (typeof e.code === "string" && e.code.length <= 80 && CODE_RE.test(e.code)) {
		out["autter.error.code"] = e.code;
	}
	if (typeof e.why === "string") out["autter.error.why"] = e.why.slice(0, 1000);
	if (typeof e.fix === "string") out["autter.error.fix"] = e.fix.slice(0, 1000);
	if (typeof e.link === "string" && e.link.length <= 500 && /^https?:\/\//.test(e.link)) {
		out["autter.error.link"] = e.link;
	}
	if (e.expected === true) out["autter.error.expected"] = true;
	if (typeof e.requestId === "string" && REQUEST_ID_RE.test(e.requestId)) {
		out["autter.request.id"] = e.requestId;
	}
	return out;
}

function addContext(event: BrowserEvent, extra: Record<string, unknown>): void {
	if (Object.keys(extra).length > 0) event.context = { ...event.context, ...extra };
}

/** `x-request-id` of a failed response → `autter.request.id`, linking the
 * browser failure to the server's request summary. Cross-origin APIs must
 * list the header in Access-Control-Expose-Headers for the page to see it. */
function addRequestId(event: BrowserEvent, id: string | null | undefined): void {
	if (id && REQUEST_ID_RE.test(id)) addContext(event, { "autter.request.id": id });
}

/**
 * Turn a failed `fetch` Response into an Error carrying the server's
 * declared fields. Reads `{ error: { message, code, why, fix, link,
 * requestId } }` (the `autterErrorResponse` / `toClientError` body) from a
 * clone, so the caller can still read the original body; anything else
 * falls back to the status text. Pass the result to `captureException` (or
 * throw it) and the error groups by its code.
 */
export async function autterErrorFromResponse(response: Response): Promise<Error> {
	let body: Record<string, unknown> = {};
	try {
		const parsed = (await response.clone().json())?.error;
		body = typeof parsed === "string" ? { message: parsed } : parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		/* Not JSON, or the body was already read. */
	}
	const error = new Error(
		typeof body.message === "string" && body.message
			? body.message
			: response.statusText || `Request failed with status ${response.status}`,
	) as Error & Record<string, unknown>;
	error.name = "HttpResponseError";
	error.status = response.status;
	for (const key of ["code", "why", "fix", "link", "requestId"]) {
		if (typeof body[key] === "string") error[key] = body[key];
	}
	if (!error.requestId) {
		try {
			error.requestId = response.headers.get("x-request-id") || undefined;
		} catch {
			/* No headers. */
		}
	}
	return error;
}

function route(): string {
	try {
		return location.pathname;
	} catch {
		return "";
	}
}

function pushTrail(step: string): void {
	const clean = step.slice(0, 80);
	if (!clean || trail[trail.length - 1] === clean) return;
	trail.push(clean);
	if (trail.length > TRAIL_MAX) trail.shift();
}

/** Coarse browser and OS only. The raw User-Agent is a fingerprint and is never sent. */
function clientEnv(): { browser: string; os: string } {
	if (clientCache) return clientCache;
	let browser = "";
	let os = "";
	try {
		const nav = navigator as Navigator & {
			userAgentData?: {
				platform?: string;
				brands?: Array<{ brand: string; version: string }>;
			};
		};
		const hints = nav.userAgentData;
		if (hints) {
			os = (hints.platform || "").slice(0, 40);
			const brand = (hints.brands || []).find(
				(item) => !/not.?a.?brand|chromium/i.test(item.brand),
			);
			if (brand) browser = `${brand.brand} ${brand.version}`.trim().slice(0, 40);
		}
		const ua = nav.userAgent || "";
		if (!os) {
			os = /Windows/.test(ua)
				? "Windows"
				: /Android/.test(ua)
					? "Android"
					: /iPhone|iPad|iPod/.test(ua)
						? "iOS"
						: /Mac OS X/.test(ua)
							? "macOS"
							: /CrOS/.test(ua)
								? "ChromeOS"
								: /Linux/.test(ua)
									? "Linux"
									: "";
		}
		if (!browser) {
			const edge = /Edg\/(\d+)/.exec(ua);
			const firefox = /Firefox\/(\d+)/.exec(ua);
			const chrome = /Chrome\/(\d+)/.exec(ua);
			const safari = /Version\/(\d+).+Safari/.exec(ua);
			browser = edge
				? `Edge ${edge[1]}`
				: firefox
					? `Firefox ${firefox[1]}`
					: chrome
						? `Chrome ${chrome[1]}`
						: safari
							? `Safari ${safari[1]}`
							: "";
		}
	} catch {
		/* Navigator is unavailable. */
	}
	clientCache = { browser, os };
	return clientCache;
}

/** Query-stripped script identity: pathname on this origin, origin+path elsewhere, extension id for injected scripts. */
function scriptLabel(raw: string | undefined): string | undefined {
	if (!raw || raw === "inline" || raw === "eval" || raw === "self") return undefined;
	try {
		const url = new URL(raw, location.href);
		if (/^(chrome-extension|moz-extension|safari-web-extension|iabjs):$/.test(url.protocol)) {
			return `${url.protocol}//${url.host}`.slice(0, 160);
		}
		if (url.origin === location.origin) return (url.pathname || "/").slice(0, 180);
		const path = url.pathname === "/" ? "" : url.pathname;
		return `${url.origin}${path}`.slice(0, 180);
	} catch {
		return undefined;
	}
}

function pageScripts(): string {
	try {
		const list = document.scripts;
		if (!list || list.length === 0) return "";
		const seen: string[] = [];
		for (let i = 0; i < list.length && seen.length < 12; i++) {
			const label = scriptLabel(list[i]?.src);
			if (label && !seen.includes(label)) seen.push(label);
		}
		return seen.join(" | ").slice(0, 700);
	} catch {
		return "";
	}
}

function attachClient(event: BrowserEvent): void {
	if (event.type === "session_start" || event.type === "track_event" || event.type === "timing") return;
	const env = clientEnv();
	const extra: Record<string, unknown> = {};
	if (env.browser) extra["autter.browser"] = env.browser;
	if (env.os) extra["autter.os"] = env.os;
	if (trail.length > 0) extra["autter.trail"] = trail.join(" > ").slice(0, 400);
	if (event.type === "exception" || event.type === "unhandled_rejection" || event.type === "csp_violation") {
		const scripts = pageScripts();
		if (scripts) extra["autter.scripts"] = scripts;
	}
	if (
		seenCspPolicyHash &&
		(event.type === "exception" || event.type === "unhandled_rejection") &&
		event.context?.cspPolicyHash == null
	) {
		extra.cspPolicyHash = seenCspPolicyHash;
	}
	if (Object.keys(extra).length > 0) {
		event.context = { ...event.context, ...extra };
	}
}

function watchRoutes(): void {
	const record = () => {
		const path = route();
		if (path) pushTrail(`nav:${path}`);
	};
	record();
	try {
		const hist = window.history;
		if (hist && typeof hist.pushState === "function") {
			const push = hist.pushState.bind(hist);
			const replace = hist.replaceState.bind(hist);
			hist.pushState = ((...args: Parameters<History["pushState"]>) => {
				push(...args);
				record();
			}) as History["pushState"];
			hist.replaceState = ((...args: Parameters<History["replaceState"]>) => {
				replace(...args);
				record();
			}) as History["replaceState"];
		}
	} catch {
		/* History is unavailable. */
	}
	window.addEventListener("popstate", record);
}

function enqueue(event: BrowserEvent, urgent?: boolean): void {
	if (!initialized || sentCount + queue.length >= MAX_EVENTS_PER_SESSION) return;
	if (lastAction && !["session_start", "track_event", "timing"].includes(event.type)) {
		const age = Date.now() - lastAction.at;
		if (age >= 0 && age <= ACTION_WINDOW_MS) {
			event.context = {
				...(event.context || {}),
				"autter.action": lastAction.name,
				"autter.actionRoute": lastAction.route,
				"autter.actionAgeMs": age,
			};
		}
	}
	attachClient(event);
	// Scrub before beforeSend so the last-chance hook sees the final form.
	if (event.context) event.context = redactContext(event.context);
	if (opts.beforeSend) {
		const mapped = opts.beforeSend(event);
		if (!mapped) return;
		event = mapped;
	}
	queue.push(event);
	if (queue.length >= MAX_QUEUE) {
		flush();
	} else if (urgent) {
		schedule(ERROR_FLUSH_DELAY_MS);
	} else {
		schedule(FLUSH_INTERVAL_MS);
	}
}

function schedule(delay: number): void {
	if (flushTimer !== undefined) return;
	flushTimer = setTimeout(flush, delay);
}

function baseEvent(
	type: BrowserEvent["type"],
	message: string,
): BrowserEvent {
	return {
		type,
		timestamp: new Date().toISOString(),
		message: String(message).slice(0, 4000),
		route: route(),
		...(userId || globalContext
			? { context: { ...(globalContext || {}), ...(userId ? { userId } : {}) } }
			: {}),
	};
}

/** Send everything queued, now. Uses sendBeacon when available so a closing
 * page still delivers; falls back to keepalive fetch. */
export function flush(): void {
	if (flushTimer !== undefined) {
		clearTimeout(flushTimer);
		flushTimer = undefined;
	}
	if (!initialized || queue.length === 0) return;
	const events = queue.splice(0, queue.length);
	sentCount += events.length;
	const body = JSON.stringify({
		version: 1,
		sessionId,
		service: opts.service,
		environment: opts.environment || "production",
		...(opts.release ? { release: opts.release } : {}),
		events,
	});
	// Direct mode: key as query param (sendBeacon can't set headers) and
	// text/plain content type (CORS-safelisted — no preflight round-trip).
	const direct = !!opts.clientKey;
	const url = direct
		? opts.endpoint +
			(opts.endpoint.indexOf("?") < 0 ? "?" : "&") +
			"key=" +
			encodeURIComponent(opts.clientKey!)
		: opts.endpoint;
	const contentType = direct ? "text/plain" : "application/json";
	try {
		if (
			typeof navigator !== "undefined" &&
			navigator.sendBeacon &&
			navigator.sendBeacon(url, new Blob([body], { type: contentType }))
		) {
			return;
		}
	} catch {
		// fall through to fetch
	}
	void fetch(url, {
		method: "POST",
		body,
		headers: { "content-type": contentType },
		keepalive: true,
		credentials: "omit",
	}).catch(() => {});
}

export function captureException(
	error: unknown,
	context?: Record<string, unknown>,
): void {
	const isError = error instanceof Error;
	const event = baseEvent(
		"exception",
		isError ? error.message : String(error),
	);
	event.severity = "error";
	if (isError) {
		event.errorType = error.name;
		if (error.stack) event.stack = String(error.stack).slice(0, 32000);
	}
	// Explicit context wins over the duck-typed declared fields.
	addContext(event, { ...errorContext(error), ...context });
	enqueue(event, true);
}

/**
 * Report a warning (or info) without an exception — e.g. a deprecated code
 * path, a slow resource, a recoverable failure. Grouped and aggregated
 * exactly like errors, just with a lower severity.
 */
export function captureMessage(
	message: string,
	severity: AutterSeverity = "warning",
	context?: Record<string, unknown>,
): void {
	const event = baseEvent("message", message);
	event.severity = severity;
	event.errorType = "Message";
	if (context) event.context = { ...(event.context || {}), ...context };
	enqueue(event, severity === "error" || severity === "fatal");
}

/** Report an application outcome that failed without throwing. Use a stable name. */
export function captureOutcome(name: string, message: string, context?: Record<string, unknown>): void {
	const event = baseEvent("outcome", scrub(String(message)));
	event.name = scrub(String(name)).slice(0, 200);
	event.errorType = "OutcomeFailure";
	event.severity = "error";
	if (context) event.context = { ...(event.context || {}), ...context };
	enqueue(event, true);
}

/** Coarse usage signal — counts only, no PII in `props`. */
export function trackEvent(
	name: string,
	props?: Record<string, string | number | boolean>,
): void {
	const event = baseEvent("track_event", "");
	event.name = String(name).slice(0, 200);
	if (props) event.context = { ...(event.context || {}), ...props };
	enqueue(event);
}

/** Customer-provided OPAQUE identifier — never an email address. */
export function setUser(id: string | null): void {
	userId = id ? String(id).slice(0, 200) : undefined;
}

export function setContext(context: Record<string, unknown> | null): void {
	globalContext = context ?? undefined;
}

export function initAutterBrowser(options: AutterBrowserOptions): void {
	if (initialized || typeof window === "undefined") return;
	opts = options as typeof opts;
	sessionId = getSessionId();
	initialized = true;
	watchRoutes();
	if (options.captureActions !== false) {
		const rememberAction = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const element = event.type === "submit"
				? target.closest("form")
				: target.closest("button, a, [role='button'], input[type='submit'], input[type='button']");
			if (!element) return;
			// Application-owned labels are opt-in. Never read text, values, hrefs,
			// arbitrary ids, or form data from the DOM.
			const explicit = element.getAttribute("data-autter-action");
			const label = explicit && /^[a-zA-Z0-9_.:-]{1,80}$/.test(explicit)
				? explicit : element.tagName.toLowerCase();
			lastAction = { name: `${event.type}:${label}`, at: Date.now(), route: route() };
			pushTrail(`${event.type}:${label}`);
		};
		document.addEventListener("click", rememberAction, true);
		document.addEventListener("submit", rememberAction, true);
	}
	if (options.captureNetworkFailures !== false && typeof fetch === "function") {
		const originalFetch = window.fetch.bind(window);
		window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const started = performance.now();
			const target = input instanceof Request ? input.url : String(input);
			const isTelemetry = target.includes(options.endpoint);
			const path = (() => { try { return new URL(target, location.href).pathname; } catch { return ""; } })();
			return originalFetch(input, init).then((response) => {
				if (!isTelemetry && response.status >= 500) {
					const event = baseEvent("request_failure", `Request returned ${response.status}`);
					event.name = path;
					event.errorType = "HttpRequestError";
					event.durationMs = Math.min(120000, Math.round(performance.now() - started));
					try { addRequestId(event, response.headers.get("x-request-id")); } catch { /* No headers. */ }
					enqueue(event, true);
				}
				return response;
			}, (error: unknown) => {
				if (!isTelemetry) {
					const event = baseEvent("request_failure", "Request failed");
					event.name = path;
					event.errorType = "NetworkError";
					event.durationMs = Math.min(120000, Math.round(performance.now() - started));
					enqueue(event, true);
				}
				throw error;
			});
		}) as typeof fetch;
	}
	if (options.captureNetworkFailures !== false && typeof XMLHttpRequest !== "undefined") {
		const xhrUrls = new WeakMap<XMLHttpRequest, string>();
		const originalOpen = XMLHttpRequest.prototype.open;
		const originalSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.open = (function (this: XMLHttpRequest, ...args: unknown[]) {
			xhrUrls.set(this, String(args[1] ?? ""));
			return Reflect.apply(originalOpen, this, args);
		}) as typeof XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.send = function (...args: Parameters<XMLHttpRequest["send"]>) {
			const target = xhrUrls.get(this) ?? "";
			if (!target.includes(options.endpoint)) {
				const started = performance.now();
				const path = (() => { try { return new URL(target, location.href).pathname; } catch { return ""; } })();
				let recorded = false;
				const record = (message: string, errorType: string, requestId?: string | null) => {
					if (recorded) return;
					recorded = true;
					const event = baseEvent("request_failure", message);
					event.name = path;
					event.errorType = errorType;
					event.durationMs = Math.min(120000, Math.round(performance.now() - started));
					addRequestId(event, requestId);
					enqueue(event, true);
				};
				const onError = () => record("Request failed", "NetworkError");
				const onTimeout = () => record("Request timed out", "NetworkError");
				this.addEventListener("loadend", () => {
					if (this.status >= 500) {
						let requestId: string | null = null;
						try { requestId = this.getResponseHeader("x-request-id"); } catch { /* Not exposed. */ }
						record(`Request returned ${this.status}`, "HttpRequestError", requestId);
					}
					this.removeEventListener("error", onError);
					this.removeEventListener("timeout", onTimeout);
				}, { once: true });
				this.addEventListener("error", onError, { once: true });
				this.addEventListener("timeout", onTimeout, { once: true });
			}
			return Reflect.apply(originalSend, this, args);
		};
	}
	if (options.captureTimings !== false && typeof PerformanceObserver !== "undefined") {
		try {
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					if (entry.duration < 200 || entry.name.includes(options.endpoint) || timingCount >= 20) continue;
					const event = baseEvent("timing", "");
					event.name = entry.entryType === "longtask" ? "browser.longtask" : "browser.resource:" + (() => {
						try { return new URL(entry.name, location.href).pathname; } catch { return "unknown"; }
					})();
					event.durationMs = Math.min(120000, Math.round(entry.duration));
					timingCount++;
					enqueue(event);
				}
			});
			observer.observe({ entryTypes: ["longtask", "resource"] });
		} catch { /* Browser does not support these entry types. */ }
	}

	window.addEventListener("error", (event: ErrorEvent) => {
		const target = event.target as (EventTarget & { tagName?: string; src?: string }) | null;
		const failedScript = target && target !== window && target.tagName === "SCRIPT" ? target : null;
		const e = baseEvent("exception", failedScript ? "Script failed to load" : event.message || "Unknown error");
		if (failedScript) {
			e.errorType = "ScriptLoadError";
			const label = scriptLabel(failedScript.src);
			if (label) e.filename = label;
		} else {
			e.errorType = event.error instanceof Error ? event.error.name : "Error";
			addContext(e, errorContext(event.error));
			if (event.error instanceof Error && event.error.stack) {
				e.stack = String(event.error.stack).slice(0, 32000);
			}
			e.filename = stripQuery(event.filename);
			if (event.lineno) e.line = event.lineno;
			if (event.colno) e.column = event.colno;
			// Cross-origin scripts without CORS are reported as "Script error." with no file.
			if (!e.filename && /^Script error\.?$/i.test(e.message)) {
				e.context = { ...(e.context || {}), "autter.crossOriginScript": true };
			}
		}
		enqueue(e, true);
	}, true);
	window.addEventListener("securitypolicyviolation", (event: SecurityPolicyViolationEvent) => {
		if (event.disposition === "report") return;
		const directive = event.effectiveDirective || event.violatedDirective || "unknown";
		const e = baseEvent("csp_violation", `Content Security Policy blocked ${directive}`);
		e.errorType = "CspViolation";
		e.severity = "error";
		let blockedOrigin = event.blockedURI;
		if (blockedOrigin && !["inline", "eval", "self"].includes(blockedOrigin)) {
			try { blockedOrigin = new URL(blockedOrigin).origin; } catch { blockedOrigin = "other"; }
		}
		const source = scriptLabel(event.sourceFile) || scriptLabel(event.blockedURI);
		if (source) e.filename = source;
		if (event.lineNumber) e.line = event.lineNumber;
		if (event.columnNumber) e.column = event.columnNumber;
		let policyHash = "";
		const policy = event.originalPolicy;
		if (policy) {
			let hash = 5381;
			const length = Math.min(policy.length, 4000);
			for (let i = 0; i < length; i++) hash = ((hash << 5) + hash) ^ policy.charCodeAt(i);
			policyHash = (hash >>> 0).toString(16);
			seenCspPolicyHash = policyHash;
		}
		e.context = { ...(e.context || {}), cspDirective: directive.slice(0, 100),
			...(blockedOrigin ? { cspBlockedOrigin: blockedOrigin.slice(0, 200) } : {}),
			...(policyHash ? { cspPolicyHash: policyHash } : {}) };
		enqueue(e, true);
	});

	window.addEventListener(
		"unhandledrejection",
		(event: PromiseRejectionEvent) => {
			const reason: unknown = event.reason;
			const isError = reason instanceof Error;
			const e = baseEvent(
				"unhandled_rejection",
				isError ? reason.message : String(reason),
			);
			addContext(e, errorContext(reason));
			if (isError) {
				e.errorType = reason.name;
				if (reason.stack) e.stack = String(reason.stack).slice(0, 32000);
			} else {
				// A rejection whose reason isn't an Error carries no stack and no
				// meaningful type. In practice most are injected third-party
				// scripts (email/link scanners, browser extensions) rejecting a
				// plain value, not a real app fault — so report it as a warning
				// rather than a first-class error/issue. Still visible for
				// debugging; `beforeSend` can drop it entirely.
				e.severity = "warning";
			}
			enqueue(e, true);
		},
	);

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flush();
	});
	window.addEventListener("pagehide", flush);

	if (options.sessionTracking !== false) {
		enqueue(baseEvent("session_start", ""));
	}
}
