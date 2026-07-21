/**
 * @autter/runtime-browser — tiny, dependency-free error + usage tracker.
 *
 * Design constraints (non-negotiable):
 * - zero runtime dependencies, < 5 KB gzipped (CI-enforced)
 * - no OTel SDK, no console patching, no DOM recording, no offline storage
 * - privacy by construction: pathname-only routes, no cookies / form values /
 *   request bodies / emails; query strings stripped everywhere
 *
 * Payload contract: `/v1/browser` version 1 of the Autter otlp-ingester,
 * normally reached through the customer's same-origin relay
 * (`createBrowserRelayHandler` in @autter/runtime-node).
 */

export interface AutterBrowserOptions {
	/** Same-origin relay URL, e.g. "/api/autter-runtime". */
	endpoint: string;
	service: string;
	environment?: string;
	release?: string;
	/** Send a session_start ping on init (default true). */
	sessionTracking?: boolean;
	/** Last-chance hook: mutate or drop (return null) an event before send. */
	beforeSend?: (event: BrowserEvent) => BrowserEvent | null;
}

export interface BrowserEvent {
	type: "exception" | "unhandled_rejection" | "session_start" | "track_event";
	timestamp: string;
	message: string;
	name?: string;
	stack?: string;
	errorType?: string;
	filename?: string;
	line?: number;
	column?: number;
	route?: string;
	context?: Record<string, unknown>;
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

function route(): string {
	try {
		return location.pathname;
	} catch {
		return "";
	}
}

function enqueue(event: BrowserEvent, urgent?: boolean): void {
	if (!initialized || sentCount + queue.length >= MAX_EVENTS_PER_SESSION) return;
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
	try {
		if (
			typeof navigator !== "undefined" &&
			navigator.sendBeacon &&
			navigator.sendBeacon(
				opts.endpoint,
				new Blob([body], { type: "application/json" }),
			)
		) {
			return;
		}
	} catch {
		// fall through to fetch
	}
	void fetch(opts.endpoint, {
		method: "POST",
		body,
		headers: { "content-type": "application/json" },
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
	if (isError) {
		event.errorType = error.name;
		if (error.stack) event.stack = String(error.stack).slice(0, 32000);
	}
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

	window.addEventListener("error", (event: ErrorEvent) => {
		const e = baseEvent("exception", event.message || "Unknown error");
		e.errorType = event.error instanceof Error ? event.error.name : "Error";
		if (event.error instanceof Error && event.error.stack) {
			e.stack = String(event.error.stack).slice(0, 32000);
		}
		e.filename = stripQuery(event.filename);
		if (event.lineno) e.line = event.lineno;
		if (event.colno) e.column = event.colno;
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
			if (isError) {
				e.errorType = reason.name;
				if (reason.stack) e.stack = String(reason.stack).slice(0, 32000);
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
