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
	/** Maximum events accepted during one page lifecycle (default 200). */
	maxEvents?: number;
	/** Maximum copies of the same error accepted per page (default 20). */
	maxDuplicateErrors?: number;
	/**
	 * Called when an event is discarded by a safety limit or delivery failure.
	 * `detail` carries the server's rejection reason when one arrived
	 * ("invalid ingest key", "rate limit exceeded", …).
	 */
	onDrop?: (
		count: number,
		reason: BrowserDropReason,
		detail?: string,
	) => void;
}

export type BrowserDropReason = "session_cap" | "duplicate" | "delivery_failed";

export interface BrowserDeliveryStats {
	accepted: number;
	delivered: number;
	beaconAccepted: number;
	dropped: number;
	pending: number;
}

export type AutterSeverity = "fatal" | "error" | "warning" | "info";

export interface BrowserEvent {
	id?: string;
	type:
		| "exception"
		| "unhandled_rejection"
		| "message"
		| "session_start"
		| "track_event";
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
}

const MAX_QUEUE = 10;
const FLUSH_INTERVAL_MS = 5000;
const ERROR_FLUSH_DELAY_MS = 500;
const MAX_EVENTS_PER_SESSION = 200;
const MAX_DUPLICATE_ERRORS = 20;
const MAX_RETRIES = 3;

let opts: Required<Pick<AutterBrowserOptions, "endpoint" | "service">> &
	AutterBrowserOptions;
let queue: BrowserEvent[] = [];
let sessionId = "";
let userId: string | undefined;
let globalContext: Record<string, unknown> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let acceptedCount = 0;
let deliveredCount = 0;
let beaconAcceptedCount = 0;
let droppedCount = 0;
let sending = false;
let inFlightCount = 0;
const duplicateCounts = new Map<string, number>();
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
	if (!initialized) return;
	if (opts.beforeSend) {
		const mapped = opts.beforeSend(event);
		if (!mapped) return;
		event = mapped;
	}
	if (acceptedCount >= Math.max(1, opts.maxEvents ?? MAX_EVENTS_PER_SESSION)) {
		recordDrop(1, "session_cap");
		return;
	}
	if (
		event.type === "exception" ||
		event.type === "unhandled_rejection" ||
		event.type === "message"
	) {
		const signature = [
			event.type,
			event.errorType,
			event.message,
			event.stack?.split("\n", 2)[1],
			event.route,
		].join("|");
		const count = duplicateCounts.get(signature) ?? 0;
		if (count >= Math.max(1, opts.maxDuplicateErrors ?? MAX_DUPLICATE_ERRORS)) {
			recordDrop(1, "duplicate");
			return;
		}
		duplicateCounts.set(signature, count + 1);
	}
	event.id ||= uid();
	acceptedCount++;
	queue.push(event);
	if (queue.length >= MAX_QUEUE) {
		flush();
	} else if (urgent) {
		schedule(ERROR_FLUSH_DELAY_MS);
	} else {
		schedule(FLUSH_INTERVAL_MS);
	}
}

function recordDrop(
	count: number,
	reason: BrowserDropReason,
	detail?: string,
): void {
	droppedCount += count;
	try {
		if (opts.onDrop) {
			opts.onDrop(count, reason, detail);
		} else if (reason === "delivery_failed") {
			// No consumer hook installed: a lost report must still be visible,
			// not silently swallowed. Routine caps stay quiet to avoid noise.
			console.warn(
				`[autter] delivery failed: ${count} report(s) lost` +
					(detail ? ` — ${detail}` : ""),
			);
		}
	} catch {
		// Diagnostics must never break the host application.
	}
}

export function getDeliveryStats(): BrowserDeliveryStats {
	return {
		accepted: acceptedCount,
		delivered: deliveredCount,
		beaconAccepted: beaconAcceptedCount,
		dropped: droppedCount,
		pending: queue.length + inFlightCount,
	};
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
		id: uid(),
		type,
		timestamp: new Date().toISOString(),
		message: String(message).slice(0, 4000),
		route: route(),
		...(userId || globalContext
			? { context: { ...(globalContext || {}), ...(userId ? { userId } : {}) } }
			: {}),
	};
}

/** Send queued events now, retaining and retrying a batch until acknowledged. */
export function flush(): void {
	if (flushTimer !== undefined) {
		clearTimeout(flushTimer);
		flushTimer = undefined;
	}
	if (!initialized || queue.length === 0 || sending) return;
	const events = queue.splice(0, MAX_QUEUE);
	sending = true;
	inFlightCount = events.length;
	void deliver(events, 0);
}

function payload(events: BrowserEvent[]): string {
	return JSON.stringify({
		version: 1,
		...(opts.clientKey ? { clientKey: opts.clientKey } : {}),
		sessionId,
		service: opts.service,
		environment: opts.environment || "production",
		...(opts.release ? { release: opts.release } : {}),
		events,
	});
}

/** Extract the server's rejection reason ("invalid ingest key", "rate
 * limit exceeded", …) from a refused response body. */
function refusalReason(response: Response): Promise<string | undefined> {
	return response.text().then((text) => {
		try {
			const parsed = JSON.parse(text) as { error?: unknown } | null;
			if (typeof parsed?.error === "string" && parsed.error) {
				return parsed.error.slice(0, 200);
			}
		} catch {
			// Non-JSON body — no usable reason.
		}
		return undefined;
	}, () => undefined);
}

/**
 * Send queued events now, retaining and retrying a batch until acknowledged.
 * A refusal the server explained won't change on retry — permanent 4xx
 * rejections fail fast with the reason; only rate limits (429), transient
 * upstream failures (5xx) and network errors are retried.
 */
async function deliver(events: BrowserEvent[], attempt: number): Promise<void> {
	const direct = !!opts.clientKey;
	let detail: string | undefined;
	let retriable = true;
	try {
		const response = await fetch(opts.endpoint, {
			method: "POST",
			body: payload(events),
			headers: { "content-type": direct ? "text/plain" : "application/json" },
			keepalive: true,
			credentials: "omit",
		});
		if (response.ok) {
			deliveredCount += events.length;
			sending = false;
			inFlightCount = 0;
			if (queue.length > 0) flush();
			return;
		}
		detail = await refusalReason(response);
		retriable = response.status === 429 || response.status >= 500;
	} catch {
		detail = undefined;
	}
	if (retriable && attempt < MAX_RETRIES) {
		setTimeout(() => void deliver(events, attempt + 1), 500 * 2 ** attempt);
		return;
	}
	sending = false;
	inFlightCount = 0;
	recordDrop(events.length, "delivery_failed", detail);
	if (queue.length > 0) flush();
}

/** Last-chance unload delivery. Beacon acceptance is not a server ack. */
function flushBeacon(): void {
	if (!initialized || queue.length === 0) return;
	const events = queue.splice(0, queue.length);
	const body = payload(events);
	const contentType = opts.clientKey ? "text/plain" : "application/json";
	try {
		if (
			navigator.sendBeacon?.(
				opts.endpoint,
				new Blob([body], { type: contentType }),
			)
		) {
			beaconAcceptedCount += events.length;
			return;
		}
	} catch {
		// Fall through to keepalive fetch.
	}
	queue.unshift(...events);
	flush();
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
	if (context) event.context = { ...(event.context || {}), ...context };
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
		if (document.visibilityState === "hidden") flushBeacon();
	});
	window.addEventListener("pagehide", flushBeacon);

	if (options.sessionTracking !== false) {
		enqueue(baseEvent("session_start", ""));
	}
}
