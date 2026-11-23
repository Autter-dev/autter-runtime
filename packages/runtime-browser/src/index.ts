/**
 * @autter/runtime-browser — tiny, dependency-free error + usage tracker.
 *
 * Design constraints (non-negotiable):
 * - zero runtime dependencies, < 10 KB gzipped (CI-enforced)
 * - no OTel SDK, no DOM recording, no offline storage; the only console
 *   patch is `console.error` (caught errors, `captureLoggedErrors`)
 * - privacy by construction: pathname-only routes, no cookies / form values /
 *   request bodies; query strings stripped everywhere; messages, stacks and
 *   (nested) custom context are scrubbed for secrets and PII before send
 *
 * Payload contract: `/v1/browser` version 1 of the Autter otlp-ingester,
 * normally reached through the customer's same-origin relay
 * (`createBrowserRelayHandler` in @autter/runtime-node).
 */

import { version as SDK_VERSION } from "../package.json";
import type { Breadcrumb } from "./breadcrumbs";
import { attachDebugIds } from "./debug-ids";
import { takeFingerprint, type Fingerprint } from "./fingerprint";

export type { Fingerprint } from "./fingerprint";

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
	/** Last-chance hook: mutate or drop (return null) an event before send. Throwing drops the event. */
	beforeSend?: (event: BrowserEvent) => BrowserEvent | null;
	/** Observe failed fetch and XHR requests and 5xx responses (default true). */
	captureNetworkFailures?: boolean;
	/** Observe long tasks and slow resource timings (default true). */
	captureTimings?: boolean;
	/** Attach the last safe click or form action to failures (default true). */
	captureActions?: boolean;
	/**
	 * An `Error` passed to `console.error` becomes an exception event marked
	 * `autter.handled` / `autter.handling: "caught"`, with the rest of the
	 * line as `autter.log.message` (default true). An error also passed to
	 * `captureException` in the same tick (an error boundary) is sent once.
	 */
	captureLoggedErrors?: boolean;
	/**
	 * Secret/PII scrubbing of messages, stacks, and context (on by default).
	 * Add your own patterns with `{ keys, values }` — `keys` masks whole
	 * context values whose key matches, `values` (use the `g` flag) masks
	 * matching substrings anywhere. `false` disables (not recommended; the
	 * relay and ingester still scrub).
	 */
	redact?: false | { keys?: RegExp; values?: RegExp[] };
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
	/** Steps before a failure, oldest first (`@autter/runtime-browser/breadcrumbs`). */
	breadcrumbs?: Breadcrumb[];
	/** Script URL → debug id for the scripts in `stack` (sourcemaps inject). */
	debugIds?: Record<string, string>;
	/** Groups every event that carries it into one issue (see fingerprint.ts). */
	fingerprint?: Fingerprint;
	/** W3C trace id of the request behind the event (`@autter/runtime-browser/tracing`). */
	traceId?: string;
}

const MAX_QUEUE = 10;
const FLUSH_INTERVAL_MS = 5000;
const ERROR_FLUSH_DELAY_MS = 500;
/**
 * Events per page load, counted per budget: errors and failures in one, usage
 * signals (session_start, track_event, timing) in the other, so a SPA that
 * tracks every navigation still reports its errors. Only events the server
 * answered (accepted, or refused with a 4xx that a resend would not change)
 * use up a budget; events lost to a network failure or a 5xx do not.
 */
const MAX_EVENTS_PER_SESSION = 200;
/** Failed scheduled sends retried in a row before their events are dropped. */
const MAX_RETRIES = 3;
/** Usage signals: no client details, no last action. */
const USAGE_TYPES: string[] = ["session_start", "track_event", "timing"];

let opts: Required<Pick<AutterBrowserOptions, "endpoint" | "service">> &
	AutterBrowserOptions;
let queue: BrowserEvent[] = [];
let sessionId = "";
let userId: string | undefined;
let globalContext: Record<string, unknown> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
/** Per budget (0 errors, 1 usage): events the server answered, and events queued or in flight. */
const spent = [0, 0];
const pending = [0, 0];
/** Each console warning is printed once per page (a cap, a refused status). */
const warned: Record<string, 1> = {};
/** True while an event is being prepared: a hook that reports from in there is ignored. */
let enqueuing = false;
/** Environment when none is given: "development" on a local host, else "production". */
let defaultEnvironment = "production";
let retries = 0;
let initialized = false;
let timingCount = 0;
let lastAction: { name: string; at: number; route: string } | undefined;
const ACTION_WINDOW_MS = 30_000;
const TRAIL_MAX = 8;
let trail: string[] = [];
let clientCache: { browser: string; os: string } | undefined;
let seenCspPolicyHash = "";
/** Errors already sent: a `console.error` of one is not sent again. */
const sent = new WeakSet<object>();
// Breadcrumbs live in the opt-in `@autter/runtime-browser/breadcrumbs`
// module (they stay out of this bundle to keep it small); it installs these
// hooks, and the request wrappers, history patch and click listener report to them.
let crumbs: { add(kind: string, a?: unknown, b?: unknown, status?: number, ms?: number): void; list(type: string): Breadcrumb[] | undefined } | undefined;
/** @internal Installed by `@autter/runtime-browser/breadcrumbs`. */
export function _useBreadcrumbs(hooks: typeof crumbs): void {
	crumbs = hooks;
}

// W3C trace propagation lives in the opt-in `@autter/runtime-browser/tracing`
// module (it stays out of this bundle to keep it small). It installs these hooks:
// the fetch observer asks it for a traceparent and reports when the request
// settled, and every event passes through `link` for its trace id. XHR is
// wrapped by the module itself.
let tracer: {
	fetch(url: string, input: RequestInfo | URL, init?: RequestInit): [RequestInit?, string?];
	settle(id?: string): void;
	link(event: BrowserEvent): void;
} | undefined;
/** @internal Installed by `@autter/runtime-browser/tracing`. */
export function _useTracing(hooks: typeof tracer): void {
	tracer = hooks;
}

function uid(): string {
	try {
		return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	} catch {
		return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
	}
}

/** 1 for a usage signal, 0 for an error or failure: the index of its budget. */
const budget = (event: BrowserEvent) => +USAGE_TYPES.includes(event.type);

function warnOnce(key: string, message: string): void {
	if (warned[key]) return;
	warned[key] = 1;
	try {
		console.warn("[autter-runtime] " + message);
	} catch {
		/* No console. */
	}
}

/**
 * Runs SDK work so that nothing it does can throw into the host app: every
 * public function, patched browser API and timer goes through here. Telemetry
 * fails open, and an SDK failure never reaches the page's error listeners,
 * where the SDK would report itself.
 */
function guard(fn: () => unknown): void {
	try {
		fn();
	} catch {
		/* Telemetry fails open. */
	}
}

/**
 * JSON.stringify replacer for events a plain stringify refused: a BigInt
 * becomes its decimal string and a reference back to an enclosing object
 * becomes "[Circular]". Functions and symbols are dropped by stringify itself.
 */
function safeJson(): (this: unknown, key: string, value: unknown) => unknown {
	const parents: unknown[] = [];
	return function (this: unknown, _key: string, value: unknown) {
		if (typeof value === "bigint") return String(value);
		if (value && typeof value === "object") {
			// `this` is the object holding `value`: everything after it on the
			// stack is a finished sibling branch, not an ancestor.
			parents.length = parents.indexOf(this) + 1;
			if (parents.includes(value)) return "[Circular]";
			parents.push(value);
		}
		return value;
	};
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

// Mini redaction — the browser twin of redactText()/redactAttributes() in
// @autter/runtime-node (parity checked by test-vectors/redaction.json).
// Deliberately compact: this bundle is size-capped.
const SENSITIVE_KEY_RE =
	/email|pass|token|secret|^auth([-_.]|$)|authorization|bearer|cookie|credential|api[-_.]?key|private[-_.]?key|(^|[._-])session$|^(j|php)?sess(ion)?id$|^sid$|(^|[^a-z])ssn($|[^a-z])|cvv|(^|[^a-z])card([-_. ]?(number|num|no))?$/i;
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi;
// Vendor-prefixed keys, JWTs, Bearer/Basic credentials. Server-only shapes
// (PEM blocks, npm/GitLab/SendGrid tokens) are left to the relay/ingester.
const SECRET_RE =
	/\b(sk-[\w-]{20,}|[sr]k_(live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[\w-]{30,}|(AKIA|ASIA)[0-9A-Z]{16}|bearer\s+[\w.~+/=-]{10,}|basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2})/gi;
// JWTs may only start after a non-token character (lookbehind would break
// older Safari): a \b start at every "eyJ" after "-" is quadratic.
const JWT_RE = /(^|[^\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
const HEADER_RE =
	/((^|[^\w-])(proxy-)?(authorization|(set-)?cookie)["']?\s*[:=]\s*["']?)[^"'\r\n]+/gim;
const ASSIGN_RE =
	/(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|signature|session[_-]?id|sessionid|ssn)(["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'&,;)}\]\[<>]+)/gi;
const URL_CRED_RE =
	/\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/:@"'<>]*:[^\s/"'<>]*|[^\s/:@"'<>]{16,})@/gi;
const CARD_RE = /\b(4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(011|5\d{2}))([ -]?\d){9,15}\b/g;
const MASK = "[redacted]";

function luhn(value: string): boolean {
	const digits = value.replace(/\D/g, "");
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = +digits[digits.length - 1 - i]!;
		if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
		sum += d;
	}
	return sum % 10 === 0;
}

function redactOptions(): { keys?: RegExp; values?: RegExp[] } | false | undefined {
	return opts ? opts.redact : undefined;
}

/** Scrub secrets/PII embedded in one string (message, stack, URL, value). */
export function scrubText(value: string): string {
	const custom = redactOptions();
	if (custom === false) return value;
	// Capped: context values are otherwise unbounded (a 1 MB value took
	// ~0.6 s on the main thread). Stacks are cut to 32 000 after this.
	let out = String(value).slice(0, 32768)
		.replace(SECRET_RE, MASK)
		.replace(JWT_RE, "$1" + MASK)
		.replace(HEADER_RE, "$1" + MASK)
		.replace(ASSIGN_RE, (_m, key: string, sep: string, val: string) =>
			key + sep + (/^["']/.test(val) ? val[0] + MASK + val[0] : MASK))
		.replace(URL_CRED_RE, "$1" + MASK + "@")
		.replace(CARD_RE, (m) => (luhn(m) ? MASK : m))
		.replace(EMAIL_RE, MASK);
	// Always global (a plain /x/ would mask only the first hit), never sticky.
	for (const re of (custom && custom.values) || [])
		out = out.replace(new RegExp(re.source, re.flags.replace(/[gy]/g, "") + "g"), MASK);
	return out;
}

function scrubValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return scrubText(value);
	// JSON.stringify throws on a BigInt (an id from setContext): send its digits.
	if (typeof value === "bigint") return String(value);
	if (!value || typeof value !== "object") return value;
	if (depth > 5) return MASK;
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubValue(item, depth + 1));
	return redactContext(value as Record<string, unknown>, depth + 1);
}

export function redactContext(
	context: Record<string, unknown>,
	depth = 0,
): Record<string, unknown> {
	const custom = redactOptions();
	if (custom === false) return context;
	const out: Record<string, unknown> = {};
	for (const key in context) {
		out[key] = SENSITIVE_KEY_RE.test(key) || (custom && custom.keys && key.search(custom.keys) > -1)
			? MASK
			: scrubValue(context[key], depth);
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
	for (const key of ["why", "fix"]) if (typeof e[key] === "string") out["autter.error." + key] = (e[key] as string).slice(0, 1000);
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
/** Type, stack and declared fields of a thrown value; false when it is no Error. */
function fromError(event: BrowserEvent, error: unknown): boolean {
	addContext(event, errorContext(error));
	if (!(error instanceof Error)) return false;
	sent.add(error);
	event.errorType = error.name;
	if (error.stack) event.stack = String(error.stack).slice(0, 32512);
	return true;
}

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
		// First match wins, in this order.
		if (!os)
			os = ([["Windows", /Windows/], ["Android", /Android/], ["iOS", /iPhone|iPad|iPod/], ["macOS", /Mac OS X/],
				["ChromeOS", /CrOS/], ["Linux", /Linux/]] as const).find(([, re]) => re.test(ua))?.[0] || "";
		if (!browser)
			for (const [name, re] of [["Edge", /Edg\/(\d+)/], ["Firefox", /Firefox\/(\d+)/], ["Chrome", /Chrome\/(\d+)/],
				["Safari", /Version\/(\d+).+Safari/]] as const) {
				const match = re.exec(ua);
				if (match) {
					browser = `${name} ${match[1]}`;
					break;
				}
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
	if (USAGE_TYPES.includes(event.type)) return;
	const env = clientEnv();
	const extra: Record<string, unknown> = {};
	if (env.browser) extra["autter.browser"] = env.browser;
	if (env.os) extra["autter.os"] = env.os;
	if (trail.length > 0) extra["autter.trail"] = trail.join(" > ").slice(0, 400);
	const thrown = /^(exception|unhandled_rejection)$/.test(event.type);
	if (thrown || event.type === "csp_violation") {
		const scripts = pageScripts();
		if (scripts) extra["autter.scripts"] = scripts;
	}
	if (seenCspPolicyHash && thrown && event.context?.cspPolicyHash == null) {
		extra.cspPolicyHash = seenCspPolicyHash;
	}
	addContext(event, extra);
}

function watchRoutes(): void {
	const record = () => guard(() => {
		const path = route();
		if (path) pushTrail(`nav:${path}`);
		crumbs?.add("navigation", path);
	});
	record();
	try {
		const hist = window.history;
		if (hist && typeof hist.pushState === "function") {
			for (const key of ["pushState", "replaceState"] as const) {
				const original = hist[key].bind(hist);
				hist[key] = (...args: Parameters<History["pushState"]>) => {
					original(...args);
					record();
				};
			}
		}
	} catch {
		/* History is unavailable. */
	}
	window.addEventListener("popstate", record);
}

function enqueue(event: BrowserEvent, urgent?: boolean): void {
	// A beforeSend or console hook that reports while an event is prepared
	// would recurse: ignore it.
	if (!initialized || enqueuing) return;
	enqueuing = true;
	try {
		prepare(event, urgent);
	} finally {
		enqueuing = false;
	}
}

function prepare(event: BrowserEvent, urgent?: boolean): void {
	const kind = budget(event);
	if (spent[kind]! + pending[kind]! >= MAX_EVENTS_PER_SESSION) {
		warnOnce("cap" + kind, `${MAX_EVENTS_PER_SESSION} ${kind ? "usage events" : "errors"} sent from this page: more are dropped until it reloads.`);
		return;
	}
	if (lastAction && !USAGE_TYPES.includes(event.type)) {
		const age = Date.now() - lastAction.at;
		if (age >= 0 && age <= ACTION_WINDOW_MS) {
			addContext(event, {
				"autter.action": lastAction.name,
				"autter.actionRoute": lastAction.route,
				"autter.actionAgeMs": age,
			});
		}
	}
	attachClient(event);
	if (crumbs) event.breadcrumbs = crumbs.list(event.type);
	tracer?.link(event);
	// Scrub before beforeSend so the last-chance hook sees the final form.
	// Fields arrive cut with 512 chars of slack; scrub, then cut, so a secret
	// straddling the limit is masked whole instead of half-exported.
	event.message = scrubText(event.message).slice(0, 4000);
	if (event.stack) event.stack = scrubText(event.stack).slice(0, 32000);
	attachDebugIds(event);
	if (event.name) event.name = scrubText(event.name).slice(0, 200);
	if (event.context) {
		try {
			event.context = redactContext(event.context);
		} catch {
			// Throwing getter / revoked Proxy: drop the context, never throw.
			delete event.context;
		}
	}
	if (opts.beforeSend) {
		try {
			const mapped = opts.beforeSend(event);
			if (!mapped) return;
			event = mapped;
		} catch {
			// A telemetry hook must not change application request outcomes.
			return;
		}
	}
	pending[budget(event)]!++;
	queue.push(event);
	if (queue.length >= MAX_QUEUE) {
		send(false);
	} else if (urgent) {
		schedule(ERROR_FLUSH_DELAY_MS);
	} else {
		schedule(FLUSH_INTERVAL_MS);
	}
}

function schedule(delay: number): void {
	if (flushTimer !== undefined) return;
	flushTimer = setTimeout(sendLater, delay);
}

/** Timer callback: a scheduled send, which must never throw from the timer. */
const sendLater = () => guard(() => send(false));

/** The batch left the queue for good: free its pending slots, and use up budget if the server answered. */
function settle(events: BrowserEvent[], answered: boolean): void {
	for (const event of events) {
		const kind = budget(event);
		pending[kind]!--;
		if (answered) spent[kind]!++;
	}
}

/**
 * The batch's JSON body, or "" when no event in it can be serialised. A value
 * JSON.stringify refuses (a BigInt left by `redact: false`, a cycle or BigInt
 * added by beforeSend) must not lose the whole batch or throw into the app:
 * the events are then serialised one by one with a replacer, and only those
 * that still fail (a throwing getter or toJSON) are dropped.
 */
function serialise(events: BrowserEvent[]): string {
	const body = (list: unknown[]) => JSON.stringify({
		version: 1,
		sessionId,
		service: opts.service,
		environment: opts.environment || defaultEnvironment,
		...(opts.release ? { release: opts.release } : {}),
		// SDK version: the ingester records it so version mismatches are
		// visible (and checked server-side by the relay). Ignored by older ingesters.
		sdk: SDK_VERSION,
		events: list,
	});
	try {
		return body(events);
	} catch {
		const kept: unknown[] = [];
		for (const event of events) {
			try {
				kept.push(JSON.parse(JSON.stringify(event, safeJson())));
			} catch {
				/* Still not serialisable: drop this event only. */
			}
		}
		return kept.length ? body(kept) : "";
	}
}

function baseEvent(
	type: BrowserEvent["type"],
	message: string,
): BrowserEvent {
	return {
		type,
		timestamp: new Date().toISOString(),
		message: String(message).slice(0, 4512),
		route: route(),
		...(userId || globalContext
			? { context: { ...(globalContext || {}), ...(userId ? { userId } : {}) } }
			: {}),
	};
}

/** Send everything queued, now. Uses sendBeacon when available so a closing
 * page still delivers; falls back to keepalive fetch. */
export function flush(): void {
	guard(() => send(true));
}

/**
 * `final` (flush(), page hidden or closing): sendBeacon, which can't report
 * the answer. Otherwise (the timer, a full queue): fetch, so a 429 or 5xx —
 * e.g. the ingester's 503 while it can't check the key — puts the events
 * back and tries again after Retry-After (else 5 s, 10 s, 20 s), up to
 * MAX_RETRIES times in a row before they are dropped.
 */
function send(final: boolean): void {
	if (flushTimer !== undefined) {
		clearTimeout(flushTimer);
		flushTimer = undefined;
	}
	if (!initialized || queue.length === 0) return;
	const events = queue.splice(0, queue.length);
	const body = serialise(events);
	if (!body) return settle(events, false);
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
	if (final || typeof fetch !== "function") {
		try {
			// No navigator (or no sendBeacon): fetch below.
			// Queued by the browser: counted as delivered, the answer is never seen.
			if (navigator.sendBeacon?.(url, new Blob([body], { type: contentType }))) return settle(events, true);
		} catch {
			// fall through to fetch
		}
	}
	const retry = (retryAfter?: string | null) => {
		// A final send (page closing) is not retried.
		if (final || retries >= MAX_RETRIES) {
			retries = 0;
			return settle(events, false);
		}
		const seconds = Number(retryAfter);
		const delay = seconds > 0 ? Math.min(seconds, 60) * 1000 : FLUSH_INTERVAL_MS * 2 ** retries;
		retries++;
		queue = events.concat(queue);
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		flushTimer = setTimeout(sendLater, delay);
	};
	try {
		void fetch(url, {
			method: "POST",
			body,
			headers: { "content-type": contentType },
			keepalive: final,
			credentials: "omit",
		}).then(
			(response) => guard(() => {
				const status = response.status;
				if (status === 429 || status >= 500) return retry(response.headers?.get("retry-after"));
				if (!final) retries = 0;
				settle(events, true);
				// Refused for good: say why, once per status, instead of dropping silently.
				if (/^(400|401|403|413)$/.test(String(status)))
					warnOnce(
						"s" + status,
						`${opts.endpoint} answered ${status}: ${events.length} events dropped. ` +
							(status === 413
								? "The batch was too large."
								: status === 400
									? "Check service, environment and release in initAutterBrowser()."
									: direct
										? "Browser errors need a runtime client key (autter_rtc_…) that allows this origin in initAutterBrowser({ clientKey }). Create one in the Autter dashboard at Settings > Keys and tokens."
										: "Check the relay's server key (AUTTER_RUNTIME_KEY)."),
					);
			}),
			() => guard(() => retry()),
		);
	} catch {
		// fetch threw synchronously (no fetch at all): nothing to deliver with.
		settle(events, false);
	}
}

export function captureException(
	error: unknown,
	context?: Record<string, unknown> & { fingerprint?: Fingerprint },
): void {
	guard(() => {
		const isError = error instanceof Error;
		const event = baseEvent(
			"exception",
			isError ? error.message : String(error),
		);
		event.severity = "error";
		// Explicit context wins over the duck-typed declared fields.
		fromError(event, error);
		addContext(event, takeFingerprint(event, context));
		enqueue(event, true);
	});
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
	guard(() => {
		const event = baseEvent("message", message);
		event.severity = severity;
		event.errorType = "Message";
		if (context) addContext(event, context);
		enqueue(event, severity === "error" || severity === "fatal");
	});
}

/** Report an application outcome that failed without throwing. Use a stable name. */
export function captureOutcome(name: string, message: string, context?: Record<string, unknown>): void {
	guard(() => {
		const event = baseEvent("outcome", message);
		event.name = String(name).slice(0, 712);
		event.errorType = "OutcomeFailure";
		event.severity = "error";
		if (context) addContext(event, context);
		enqueue(event, true);
	});
}

/** Coarse usage signal — counts only, no PII in `props`. */
export function trackEvent(
	name: string,
	props?: Record<string, string | number | boolean>,
): void {
	guard(() => {
		const event = baseEvent("track_event", "");
		event.name = String(name).slice(0, 712);
		if (props) addContext(event, props);
		enqueue(event);
	});
}

/** Customer-provided OPAQUE identifier — never an email address. */
export function setUser(id: string | null): void {
	guard(() => {
		userId = id ? String(id).slice(0, 200) : undefined;
	});
}

export function setContext(context: Record<string, unknown> | null): void {
	guard(() => {
		globalContext = context ?? undefined;
	});
}

/** Milliseconds since `from`, capped at two minutes. */
const cap = (ms: number) => Math.min(120000, Math.round(ms));
const elapsed = (from: number) => cap(performance.now() - from);

/** Pathname of a URL relative to the page, or `fallback`. */
function pathOf(url: string, fallback = ""): string {
	try { return new URL(url, location.href).pathname; } catch { return fallback; }
}

/** A failed fetch/XHR as a `request_failure` event. */
function failure(message: string, errorType: string, path: string, started: number): BrowserEvent {
	const event = baseEvent("request_failure", message);
	event.name = path;
	event.errorType = errorType;
	event.durationMs = elapsed(started);
	return event;
}

export function initAutterBrowser(options: AutterBrowserOptions): void {
	if (initialized || typeof window === "undefined") return;
	// A secret key (server, upload) or personal access token in clientKey would
	// travel in ?key= (CDN and proxy logs): refuse it, send nothing.
	const secret = /autter_(pat|rtu?)_/.exec(options.clientKey || "");
	if (secret) {
		console.error(
			"[autter-runtime] clientKey is " +
				{ pat: "a personal access token (autter_pat_…)", rt: "a runtime server key (autter_rt_…)", rtu: "a source map upload key (autter_rtu_…)" }[secret[1] as "pat"] +
				", not a client key. Browser errors need a runtime client key (autter_rtc_…) in initAutterBrowser({ clientKey }). Create one in the Autter dashboard at Settings > Keys and tokens. Nothing is sent.",
		);
		return;
	}
	// The ingester and the relay refuse a payload without these, so a bad
	// value would lose every event: say what to set, and do not start (no
	// patches, every call a no-op).
	const text = (value: unknown, max: number, min = 1) =>
		typeof value === "string" && value.length >= min && value.length <= max;
	const bad = !text(options.endpoint, 2000)
		? "endpoint (your relay route, e.g. \"/api/autter-runtime\", or the ingester's /v1/browser URL with a clientKey)"
		: !text(options.service, 200)
			? "service (your app's name, 1 to 200 characters)"
			: options.release != null && !text(options.release, 200, 0)
				? "release (at most 200 characters)"
				: options.environment != null && !text(options.environment, 100, 0)
					? "environment (at most 100 characters)"
					: "";
	if (bad) {
		console.error(`[autter-runtime] initAutterBrowser() needs ${bad}. Nothing is sent.`);
		return;
	}
	opts = options as typeof opts;
	// No environment given: a page served from this machine is development,
	// so its errors stay out of production views and alerts.
	try {
		if (/^(localhost|127\.0\.0\.1|\[::1\])$|\.(local|localhost)$/.test(location.hostname)) defaultEnvironment = "development";
	} catch {
		/* No location. */
	}
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
			pushTrail(lastAction.name);
			crumbs?.add("click", lastAction.name);
		};
		document.addEventListener("click", rememberAction, true);
		document.addEventListener("submit", rememberAction, true);
	}
	if (options.captureLoggedErrors !== false) {
		const original = console.error;
		console.error = function (this: unknown, ...args: unknown[]) {
			guard(() => {
				for (const arg of args)
					if (arg instanceof Error)
						// The rest of the line (without the error) as context; the
						// ingester marks it `autter.handled`, `autter.handling: "caught"`,
						// `autter.log.source: "console"`. Joining runs the other
						// arguments' toString, which may throw: guarded too.
						setTimeout(guard, 0, () => sent.has(arg) || captureException(arg, { "autter.log.message": args.filter((other) => other !== arg).join(" ") }));
			});
			return original.apply(this, args);
		};
	}
	const network = options.captureNetworkFailures !== false;
	if (network && typeof fetch === "function") {
		const originalFetch = window.fetch.bind(window);
		window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			// The app's request goes out, and settles, exactly as without the SDK:
			// observing it is guarded, so it can neither throw nor change the result.
			let started = 0, isTelemetry = true, path = "", method: string | undefined, traced = init, traceId: string | undefined;
			guard(() => {
				started = performance.now();
				const target = input instanceof Request ? input.url : String(input);
				isTelemetry = target.includes(options.endpoint);
				path = pathOf(target);
				method = init?.method || (input as Request).method;
				[traced, traceId] = (!isTelemetry && tracer?.fetch(target, input, init)) || [init];
			});
			return originalFetch(input, traced).then((response) => {
				guard(() => {
					tracer?.settle(traceId);
					if (isTelemetry) return;
					crumbs?.add("request", method, path, response.status, elapsed(started));
					if (response.status >= 500) {
						const event = failure(`Request returned ${response.status}`, "HttpRequestError", path, started);
						try { addRequestId(event, response.headers.get("x-request-id")); } catch { /* No headers. */ }
						enqueue(event, true);
					}
				});
				return response;
			}, (error: unknown) => {
				guard(() => {
					tracer?.settle(traceId);
					if (isTelemetry) return;
					crumbs?.add("request", method, path, 0, elapsed(started));
					enqueue(failure("Request failed", "NetworkError", path, started), true);
				});
				throw error;
			});
		}) as typeof fetch;
	}
	if (network && typeof XMLHttpRequest !== "undefined") {
		const xhrUrls = new WeakMap<XMLHttpRequest, unknown[]>();
		const xhr = XMLHttpRequest.prototype;
		const originalOpen = xhr.open;
		const originalSend = xhr.send;
		xhr.open = (function (this: XMLHttpRequest, ...args: unknown[]) {
			xhrUrls.set(this, args);
			return Reflect.apply(originalOpen, this, args);
		}) as typeof XMLHttpRequest.prototype.open;
		xhr.send = function (...args: Parameters<XMLHttpRequest["send"]>) {
			guard(() => {
				const [method, url] = xhrUrls.get(this) ?? [];
				const target = String(url ?? "");
				if (!target.includes(options.endpoint)) {
					const started = performance.now();
					const path = pathOf(target);
					let recorded = false;
					const record = (message: string, errorType: string, requestId?: string | null) => guard(() => {
						if (recorded) return;
						recorded = true;
						crumbs?.add("request", method, path, this.status, elapsed(started));
						const event = failure(message, errorType, path, started);
						addRequestId(event, requestId);
						enqueue(event, true);
					});
					const onError = () => record("Request failed", "NetworkError");
					const onTimeout = () => record("Request timed out", "NetworkError");
					this.addEventListener("loadend", () => guard(() => {
						if (this.status < 500 && !recorded) crumbs?.add("request", method, path, this.status, elapsed(started));
						if (this.status >= 500) {
							let requestId: string | null = null;
							try { requestId = this.getResponseHeader("x-request-id"); } catch { /* Not exposed. */ }
							record(`Request returned ${this.status}`, "HttpRequestError", requestId);
						}
						this.removeEventListener("error", onError);
						this.removeEventListener("timeout", onTimeout);
					}), { once: true });
					this.addEventListener("error", onError, { once: true });
					this.addEventListener("timeout", onTimeout, { once: true });
				}
			});
			return Reflect.apply(originalSend, this, args);
		};
	}
	if (options.captureTimings !== false && typeof PerformanceObserver !== "undefined") {
		try {
			const observer = new PerformanceObserver((list) => guard(() => {
				for (const entry of list.getEntries()) {
					if (entry.duration < 200 || entry.name.includes(options.endpoint) || timingCount >= 20) continue;
					const event = baseEvent("timing", "");
					event.name = entry.entryType === "longtask" ? "browser.longtask" : "browser.resource:" + pathOf(entry.name, "unknown");
					event.durationMs = cap(entry.duration);
					timingCount++;
					enqueue(event);
				}
			}));
			observer.observe({ entryTypes: ["longtask", "resource"] });
		} catch { /* Browser does not support these entry types. */ }
	}

	window.addEventListener("error", (event: ErrorEvent) => guard(() => {
		const target = event.target as (EventTarget & { tagName?: string; src?: string }) | null;
		const failedScript = target && target !== window && target.tagName === "SCRIPT" ? target : null;
		const e = baseEvent("exception", failedScript ? "Script failed to load" : event.message || "Unknown error");
		if (failedScript) {
			e.errorType = "ScriptLoadError";
			const label = scriptLabel(failedScript.src);
			if (label) e.filename = label;
		} else {
			if (!fromError(e, event.error)) e.errorType = "Error";
			e.filename = stripQuery(event.filename);
			if (event.lineno) e.line = event.lineno;
			if (event.colno) e.column = event.colno;
			// Cross-origin scripts without CORS are reported as "Script error." with no file.
			if (!e.filename && /^Script error\.?$/i.test(e.message)) {
				addContext(e, { "autter.crossOriginScript": true });
			}
		}
		enqueue(e, true);
	}), true);
	window.addEventListener("securitypolicyviolation", (event: SecurityPolicyViolationEvent) => guard(() => {
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
		addContext(e, { cspDirective: directive.slice(0, 100),
			...(blockedOrigin ? { cspBlockedOrigin: blockedOrigin.slice(0, 200) } : {}),
			...(policyHash ? { cspPolicyHash: policyHash } : {}) });
		enqueue(e, true);
	}));

	window.addEventListener(
		"unhandledrejection",
		(event: PromiseRejectionEvent) => guard(() => {
			const reason: unknown = event.reason;
			const isError = reason instanceof Error;
			const e = baseEvent(
				"unhandled_rejection",
				isError ? reason.message : String(reason),
			);
			if (!fromError(e, reason)) {
				// A rejection whose reason isn't an Error carries no stack and no
				// meaningful type. In practice most are injected third-party
				// scripts (email/link scanners, browser extensions) rejecting a
				// plain value, not a real app fault — so report it as a warning
				// rather than a first-class error/issue. Still visible for
				// debugging; `beforeSend` can drop it entirely.
				e.severity = "warning";
			}
			enqueue(e, true);
		}),
	);

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flush();
	});
	window.addEventListener("pagehide", flush);

	if (options.sessionTracking !== false) {
		enqueue(baseEvent("session_start", ""));
	}
}
