import type { IncomingMessage, ServerResponse } from "node:http";
import type { Attributes } from "@opentelemetry/api";
import { makeRedactor, type RedactOptions, type Redactor } from "./redact.js";
import {
	ensureCompatConfigured,
	noteCompatFeature,
	noteRelayRejection,
	observeIngesterResponse,
} from "./compat.js";
import { featuresForBrowserEvents } from "../../otlp-ingester/src/compat.js";
import { fingerprintValues, sanitizeBreadcrumbs } from "@autter/runtime-core";

/**
 * Same-origin browser relay. The browser tracker posts to a route on the
 * customer's own backend; this handler validates + sanitises the payload,
 * attaches the private ingest key server-side, forwards asynchronously to
 * the Autter ingester, and returns 202 immediately. The key never reaches
 * the browser, and there is no CORS/CSP surface.
 */

export interface RelayOptions {
	/** Private ingest key (autter_rt_…). Keep it in an env var. */
	apiKey: string;
	/** Ingester base URL. Default: https://otlp.autter.dev */
	endpoint?: string;
	/** Max accepted request body. Default 64 KB. */
	maxBodyBytes?: number;
	/**
	 * The relay route is necessarily public (browsers must reach it), so it
	 * ships with a per-IP fixed-window limit. Default 120 req/min; set
	 * `false` to disable (e.g. when a WAF already rate-limits).
	 */
	perIpRateLimit?: number | false;
	/**
	 * How the per-client rate limit finds the visitor's address. A caller can
	 * write anything into `X-Forwarded-For`, so the relay never takes its
	 * first (leftmost) entry unless told to.
	 *
	 * - `"auto"` (default): works behind any load balancer, CDN or platform
	 *   proxy without setup. Proxies append the address they saw to the right
	 *   of the header (or overwrite it), so the relay reads it right to left
	 *   and takes the first public address, skipping private and loopback
	 *   hops. The Node handler only does this when the connection itself came
	 *   from a private address (a proxy on your network); a public peer is the
	 *   visitor and its header is ignored. On Cloudflare Workers it uses
	 *   `CF-Connecting-IP`.
	 * - a number `n`: exactly `n` proxies you control sit in front; use the
	 *   entry `n` from the right (Express `trust proxy` semantics). Use `1`
	 *   for a Node origin behind Cloudflare with no load balancer.
	 * - `true`: every proxy in front is yours and strips client values; use
	 *   the leftmost entry.
	 * - `false`: never read the header. The Node handler keys the socket peer;
	 *   the fetch handler keys one shared bucket for the route.
	 *
	 * Strings from environment variables are read too (`"auto"`, `"true"`,
	 * `"false"`, `"0"`, `"2"`); anything else falls back to `"auto"`.
	 */
	trustProxy?: boolean | "auto" | number | string;
	/**
	 * Return the visitor's address yourself (Deno's `info.remoteAddr`, Bun's
	 * `server.requestIP`, a header your edge sets). Wins over `trustProxy`
	 * when it returns a non-empty string.
	 */
	clientIp?: (request: Request | IncomingMessage) => string | null | undefined;
	/** Called when the async forward fails (default: console.warn). */
	onError?: (err: unknown) => void;
	/**
	 * Scrub secrets/PII from browser events (message, stack, name, nested
	 * context) before they leave your server — the same patterns as
	 * `initAutterServer({ redactAttributes })`. Catches old browser SDK
	 * versions and anything the browser's lean redactor misses. Pass a
	 * RedactOptions object to add your own patterns; `false` disables.
	 * Default true.
	 */
	redact?: boolean | RedactOptions;
	/**
	 * Warn once (server-side) when browser features in the forwarded events
	 * — CSP violations, network/timing capture — need a newer ingester than
	 * the one answering. Reads the ingester's version header from the forward
	 * response; never blocks the 202. Also disabled by AUTTER_COMPAT_CHECK=0.
	 * Default true.
	 */
	compatCheck?: boolean;
}

class IpWindow {
	private windows = new Map<string, { start: number; count: number }>();

	constructor(private readonly limitPerMinute: number) {}

	allow(ip: string): boolean {
		const start = Math.floor(Date.now() / 60_000) * 60_000;
		const entry = this.windows.get(ip);
		if (!entry || entry.start !== start) {
			this.windows.set(ip, { start, count: 1 });
			if (this.windows.size > 50_000) this.windows.clear();
			return true;
		}
		entry.count += 1;
		return entry.count <= this.limitPerMinute;
	}
}

function firstForwardedFor(value: string | string[] | undefined | null): string {
	const raw = Array.isArray(value) ? value[0] : value;
	return raw ? (raw.split(",")[0] ?? "").trim() : "";
}

// ── Client address for the rate limit ──────────────────────────────────────

type ProxyTrust =
	| { mode: "auto" }
	| { mode: "never" }
	| { mode: "all" }
	| { mode: "hops"; hops: number };

const TRUST_AUTO: ProxyTrust = { mode: "auto" };
let warnedTrustProxy = false;

/** Read `trustProxy` (including strings from env vars) into one mode. */
export function resolveTrustProxy(value: unknown): ProxyTrust {
	if (value === undefined || value === null || value === "auto") return TRUST_AUTO;
	if (value === true) return { mode: "all" };
	if (value === false || value === 0) return { mode: "never" };
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100) {
		return { mode: "hops", hops: value };
	}
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (v === "" || v === "auto") return TRUST_AUTO;
		if (v === "false" || v === "0" || v === "no" || v === "off") return { mode: "never" };
		if (v === "true" || v === "yes" || v === "on") return { mode: "all" };
		if (/^[1-9][0-9]?$/.test(v)) return { mode: "hops", hops: Number(v) };
	}
	if (!warnedTrustProxy) {
		warnedTrustProxy = true;
		console.warn(
			`[autter-runtime] relay: trustProxy ${JSON.stringify(value)} is not recognised; using "auto".`,
		);
	}
	return TRUST_AUTO;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** One forwarded/peer entry as a bare, lowercased IP, or null when it is not one. */
export function normalizeAddress(entry: string | null | undefined): string | null {
	if (!entry) return null;
	let a = entry.trim();
	if (!a || a.length > 64) return null;
	const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/.exec(a);
	if (bracketed) a = bracketed[1] ?? "";
	else if (/^[\d.]+:\d{1,5}$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
	a = a.toLowerCase();
	if (a.startsWith("::ffff:") && IPV4_RE.test(a.slice(7))) a = a.slice(7);
	if (IPV4_RE.test(a)) return a;
	if (/^[0-9a-f:]+(:(\d{1,3}\.){3}\d{1,3})?$/.test(a) && a.includes(":") && a.split(":").length <= 9) {
		return a;
	}
	return null;
}

/** Loopback, private, link-local, carrier-grade NAT or unique-local: a hop on your own network. */
export function isPrivateAddress(a: string): boolean {
	if (IPV4_RE.test(a)) {
		const [x, y] = a.split(".").map(Number) as [number, number];
		return (
			x === 10 ||
			x === 127 ||
			x === 0 ||
			(x === 169 && y === 254) ||
			(x === 172 && y >= 16 && y <= 31) ||
			(x === 192 && y === 168) ||
			(x === 100 && y >= 64 && y <= 127)
		);
	}
	return a === "::1" || a === "::" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

function forwardedEntries(value: string | string[] | undefined | null): string[] {
	const raw = Array.isArray(value) ? value.join(",") : value;
	if (!raw) return [];
	const out: string[] = [];
	for (const part of raw.split(",")) {
		const a = normalizeAddress(part);
		if (a) out.push(a);
	}
	return out;
}

/** Right to left, the first address that is not a hop on your own network. */
function rightmostPublic(entries: string[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const a = entries[i];
		if (a && !isPrivateAddress(a)) return a;
	}
	return null;
}

function fromCustom(
	opts: RelayOptions,
	request: Request | IncomingMessage,
): string | null {
	if (!opts.clientIp) return null;
	try {
		const v = opts.clientIp(request);
		return typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : null;
	} catch {
		return null;
	}
}

/** Rate-limit key for the fetch handler, which has no peer address. */
export function fetchClientKey(request: Request, opts: RelayOptions): string {
	const custom = fromCustom(opts, request);
	if (custom) return custom;
	const trust = resolveTrustProxy(opts.trustProxy);
	if (trust.mode === "never") return "shared";
	const header = request.headers.get("x-forwarded-for");
	if (trust.mode === "all") return firstForwardedFor(header) || "shared";
	const entries = forwardedEntries(header);
	if (trust.mode === "hops") {
		return entries[Math.max(0, entries.length - trust.hops)] ?? "shared";
	}
	// auto. Cloudflare Workers: `request.cf` is set by the runtime, never by a
	// header, so its CF-Connecting-IP is the address Cloudflare accepted.
	const cf = (request as unknown as { cf?: unknown }).cf;
	if (cf !== null && typeof cf === "object") {
		const viaCf = normalizeAddress(request.headers.get("cf-connecting-ip"));
		if (viaCf) return viaCf;
	}
	// Fetch runtimes sit behind the platform's edge, which appends (or
	// overwrites) the address it saw: the rightmost public entry.
	return rightmostPublic(entries) ?? entries[entries.length - 1] ?? "shared";
}

/** Rate-limit key for the Node handler. */
export function nodeClientKey(req: IncomingMessage, opts: RelayOptions): string {
	const custom = fromCustom(opts, req);
	if (custom) return custom;
	const trust = resolveTrustProxy(opts.trustProxy);
	const peer = normalizeAddress(req.socket?.remoteAddress);
	if (trust.mode === "never") return peer ?? "unknown";
	const header = req.headers["x-forwarded-for"];
	if (trust.mode === "all") return firstForwardedFor(header) || peer || "unknown";
	const entries = forwardedEntries(header);
	if (trust.mode === "hops") {
		return entries[Math.max(0, entries.length - trust.hops)] ?? peer ?? "unknown";
	}
	// auto: a public peer is the visitor itself, whatever header it sent.
	if (peer && !isPrivateAddress(peer)) return peer;
	// The connection came from a proxy on your network.
	return rightmostPublic(entries) ?? peer ?? entries[entries.length - 1] ?? "unknown";
}

const DEFAULT_ENDPOINT = "https://otlp.autter.dev";
const DEFAULT_MAX_BODY = 64 * 1024;
const MAX_EVENTS = 50;

const EVENT_TYPES = new Set([
	"exception",
	"unhandled_rejection",
	"message",
	"session_start",
	"track_event",
	"outcome",
	"request_failure",
	"csp_violation",
	"timing",
]);

const SEVERITIES = new Set(["fatal", "error", "warning", "info"]);
/** W3C trace id (runtime-browser traceparent): 32 lowercase hex, not all zero. */
const TRACE_ID = /^(?!0{32})[0-9a-f]{32}$/;

// Bound a browser-supplied `context` object so it honors the sanitiser's
// guarantee that a client can't smuggle unbounded cookies/DOM/bodies through
// the relay: like every other field, context is capped — bounded depth, a
// total-node budget, per-string length, and array/key limits. Cycles and
// throwing/revoked Proxy traps fail open (that value is dropped, sanitising
// continues).
const CONTEXT_MAX_DEPTH = 6;
const CONTEXT_MAX_NODES = 256;
const CONTEXT_MAX_STRING = 4000;
const CONTEXT_MAX_ARRAY = 100;
const CONTEXT_MAX_KEYS = 100;

/** UTF-8 byte length of a string (portable across edge runtimes). */
export function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Bounded, cycle-safe deep copy of an untrusted `context` value. Anything
 * past a depth/node/length limit, a cycle, or a hostile/revoked Proxy (whose
 * trap throws on classification, `length`, key enumeration, or element reads)
 * is dropped. Never throws — returns a plain, bounded object.
 */
export function boundContext(value: unknown): unknown {
	let nodes = 0;
	const seen = new WeakSet<object>();
	const walk = (v: unknown, depth: number): unknown => {
		if (v === null) return null;
		const t = typeof v;
		if (t === "string") return (v as string).slice(0, CONTEXT_MAX_STRING);
		if (t === "number" || t === "boolean") return v;
		if (t !== "object") return undefined;
		if (depth >= CONTEXT_MAX_DEPTH || nodes >= CONTEXT_MAX_NODES) return undefined;
		const obj = v as object;
		if (seen.has(obj)) return undefined;
		seen.add(obj);
		// Array.isArray can throw on a revoked Proxy — guard the classification.
		let isArr = false;
		try {
			isArr = Array.isArray(v);
		} catch {
			return undefined;
		}
		if (isArr) {
			const arr = v as unknown[];
			const out: unknown[] = [];
			// `length` can be a throwing/hostile trap — guard the read.
			let len = 0;
			try {
				len = arr.length;
			} catch {
				return out;
			}
			for (let i = 0; i < len && i < CONTEXT_MAX_ARRAY; i++) {
				if (nodes >= CONTEXT_MAX_NODES) break;
				nodes++;
				let el: unknown;
				try {
					el = walk(arr[i], depth + 1);
				} catch {
					el = undefined;
				}
				if (el !== undefined) out.push(el);
			}
			return out;
		}
		let keys: string[];
		try {
			keys = Object.keys(obj);
		} catch {
			return undefined;
		}
		const out: Record<string, unknown> = {};
		for (let i = 0; i < keys.length && i < CONTEXT_MAX_KEYS; i++) {
			if (nodes >= CONTEXT_MAX_NODES) break;
			const key = keys[i];
			if (key === undefined) continue;
			nodes++;
			let child: unknown;
			try {
				child = walk((obj as Record<string, unknown>)[key], depth + 1);
			} catch {
				child = undefined;
			}
			if (child !== undefined) out[key] = child;
		}
		return out;
	};
	let result: unknown;
	try {
		result = walk(value, 0);
	} catch {
		result = undefined;
	}
	return result && typeof result === "object" ? result : {};
}

/**
 * Read a fetch `Request` body while enforcing `maxBody` as it is consumed,
 * counting real UTF-8 bytes from the byte stream (so multibyte payloads are
 * measured correctly). An oversized body is rejected as soon as the limit is
 * crossed — the stream is cancelled instead of being fully buffered first.
 */
async function readBodyBounded(
	request: Request,
	maxBody: number,
): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
	const body = request.body;
	if (!body) {
		// No readable stream to meter — fall back to a buffered read + byte check.
		const text = await request.text();
		return byteLength(text) > maxBody
			? { tooLarge: true }
			: { tooLarge: false, text };
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBody) {
			// Cancel is fire-and-forget: awaiting a cancel() that throws,
			// rejects, or never settles would hang the response (or drop it to
			// a 400). The oversize decision is already made — detach the cancel
			// and return 413 immediately.
			void Promise.resolve()
				.then(() => reader.cancel())
				.catch(() => {});
			return { tooLarge: true };
		}
		chunks.push(value);
	}
	const buf = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buf.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { tooLarge: false, text: new TextDecoder().decode(buf) };
}

// Bound first (cycle- and Proxy-safe), then scrub with the shared redactor.
// Arrays are not valid context and are dropped, as before.
function relayContext(raw: object, redactor: Redactor): { context?: Attributes } {
	const bounded = boundContext(raw);
	return Array.isArray(bounded) ? {} : { context: redactor(bounded as Attributes) };
}

// runtime-browser `/breadcrumbs`: the newest 30, each re-validated (type,
// level, time) and re-scrubbed with the relay's redactor.
function relayBreadcrumbs(raw: unknown, redactor: Redactor): { breadcrumbs?: object[] } {
	const breadcrumbs = sanitizeBreadcrumbs(raw, redactor);
	return breadcrumbs ? { breadcrumbs } : {};
}

// runtime-browser ≥1.6.0 `debugIds` (EI-13): script URL → debug id for the
// scripts in the event's stack. Query-stripped, scrubbed, at most 50 entries.
const DEBUG_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function relayDebugIds(raw: unknown, redactor: Redactor): { debugIds?: Record<string, string> } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const debugIds: Record<string, string> = {};
	let count = 0;
	for (const [url, id] of Object.entries(raw)) {
		if (count >= 50) break;
		if (typeof id !== "string" || !DEBUG_ID_RE.test(id) || url.length > 1000) continue;
		debugIds[redactor.text(url.split(/[?#]/)[0]!)] = id.toLowerCase();
		count++;
	}
	return count ? { debugIds } : {};
}

// Fingerprint override (runtime-browser 1.6.0+): a string or up to 10
// strings, scrubbed and bounded; a string stays a string.
function relayFingerprint(raw: unknown, redactor: Redactor): { fingerprint?: string | string[] } {
	const values = fingerprintValues(raw, redactor.text);
	return values ? { fingerprint: Array.isArray(raw) ? values : values[0]! } : {};
}

// Whitelist sanitiser — anything not listed here is dropped, so a
// compromised or buggy client can't smuggle cookies/DOM/bodies through the
// relay. Returns null when the payload is structurally invalid.
const defaultRelayRedactor = makeRedactor(true);

export function sanitizeBrowserPayload(
	raw: unknown,
	redactor: Redactor = defaultRelayRedactor,
): object | null {
	if (typeof raw !== "object" || raw === null) return null;
	const p = raw as Record<string, unknown>;
	if (p.version !== 1) return null;
	if (typeof p.service !== "string" || !p.service) return null;
	if (typeof p.environment !== "string" || !p.environment) return null;
	if (!Array.isArray(p.events) || p.events.length > MAX_EVENTS) return null;

	const events: object[] = [];
	for (const rawEvent of p.events) {
		if (typeof rawEvent !== "object" || rawEvent === null) return null;
		const e = rawEvent as Record<string, unknown>;
		if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type)) return null;
		if (typeof e.timestamp !== "string") return null;
		events.push({
			type: e.type,
			timestamp: e.timestamp,
			...(typeof e.severity === "string" && SEVERITIES.has(e.severity)
				? { severity: e.severity }
				: {}),
			message:
				typeof e.message === "string"
					? redactor.text(e.message.slice(0, 4512)).slice(0, 4000)
					: "",
			...(typeof e.name === "string"
				? { name: redactor.text(e.name.slice(0, 712)).slice(0, 200) }
				: {}),
			...(typeof e.durationMs === "number" && Number.isFinite(e.durationMs)
				? { durationMs: Math.max(0, Math.min(120000, e.durationMs)) } : {}),
			...(typeof e.stack === "string"
				? { stack: redactor.text(e.stack.slice(0, 32512)).slice(0, 32000) }
				: {}),
			...(typeof e.errorType === "string"
				? { errorType: e.errorType.slice(0, 200) }
				: {}),
			...(typeof e.filename === "string"
				? { filename: e.filename.split("?")[0]!.slice(0, 1000) }
				: {}),
			...(typeof e.line === "number" ? { line: e.line } : {}),
			...(typeof e.column === "number" ? { column: e.column } : {}),
			...(typeof e.route === "string"
				? { route: e.route.split("?")[0]!.slice(0, 1000) }
				: {}),
			...(typeof e.context === "object" && e.context !== null
				? relayContext(e.context, redactor)
				: {}),
			...relayBreadcrumbs(e.breadcrumbs, redactor),
			...relayDebugIds(e.debugIds, redactor),
			...relayFingerprint(e.fingerprint, redactor),
			...(typeof e.traceId === "string" && TRACE_ID.test(e.traceId)
				? { traceId: e.traceId }
				: {}),
		});
	}

	return {
		version: 1,
		...(typeof p.sessionId === "string"
			? { sessionId: p.sessionId.slice(0, 100) }
			: {}),
		service: p.service.slice(0, 200),
		environment: p.environment.slice(0, 100),
		...(typeof p.release === "string"
			? { release: p.release.slice(0, 200) }
			: {}),
		// @autter/runtime-browser version, for the ingester's compat records.
		...(typeof p.sdk === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}[0-9A-Za-z.+-]{0,20}$/.test(p.sdk)
			? { sdk: p.sdk }
			: {}),
		events,
	};
}

function forward(payload: object, opts: RelayOptions): void {
	const endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
	const url = `${endpoint}/v1/browser`;
	const compat = opts.compatCheck !== false;
	if (compat) ensureCompatConfigured(endpoint);
	void fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${opts.apiKey}`,
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(10_000),
	}).then((response) => {
		if (!compat) return;
		const types = new Set(
			((payload as { events?: Array<{ type?: string }> }).events ?? []).map((e) => String(e.type)),
		);
		observeIngesterResponse({ status: response.status, headers: response.headers });
		for (const feature of featuresForBrowserEvents(types)) noteCompatFeature(feature);
		// Ingesters before 1.6.0 drop browser trace ids silently.
		if (((payload as { events?: Array<{ traceId?: string }> }).events ?? []).some((e) => e.traceId)) {
			noteCompatFeature("browser_trace_propagation");
		}
		noteRelayRejection(types, response.status, response.headers);
	}).catch((err) => {
		(opts.onError ?? ((e) => console.warn("autter relay forward failed:", e)))(
			err,
		);
	});
}

/**
 * Fetch-style handler (Next.js App Router route, Remix, Hono, Bun, Deno):
 *
 *   export const POST = createBrowserRelayFetchHandler({ apiKey: env.AUTTER_RUNTIME_KEY });
 */
export function createBrowserRelayFetchHandler(
	opts: RelayOptions,
): (request: Request) => Promise<Response> {
	const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
	const redactor =
		opts.redact === undefined || opts.redact === true
			? defaultRelayRedactor
			: makeRedactor(opts.redact);
	const limiter =
		opts.perIpRateLimit === false
			? null
			: new IpWindow(opts.perIpRateLimit ?? 120);
	return async (request: Request): Promise<Response> => {
		if (request.method !== "POST") {
			return new Response(null, { status: 405 });
		}
		if (limiter) {
			const ip = fetchClientKey(request, opts);
			if (!limiter.allow(ip)) {
				return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
					status: 429,
				});
			}
		}
		let bounded: { tooLarge: true } | { tooLarge: false; text: string };
		try {
			bounded = await readBodyBounded(request, maxBody);
		} catch {
			return new Response(JSON.stringify({ error: "invalid json" }), {
				status: 400,
			});
		}
		if (bounded.tooLarge) {
			return new Response(JSON.stringify({ error: "payload too large" }), {
				status: 413,
			});
		}
		let raw: unknown;
		try {
			raw = JSON.parse(bounded.text);
		} catch {
			return new Response(JSON.stringify({ error: "invalid json" }), {
				status: 400,
			});
		}
		const payload = sanitizeBrowserPayload(raw, redactor);
		if (!payload) {
			return new Response(JSON.stringify({ error: "invalid payload" }), {
				status: 400,
			});
		}
		forward(payload, opts);
		return new Response(null, { status: 202 });
	};
}

/**
 * Node http / Express / Fastify(raw) handler:
 *
 *   app.post("/api/autter-runtime", createBrowserRelayHandler({ apiKey: process.env.AUTTER_RUNTIME_KEY! }));
 *
 * Works with or without a body parser: uses `req.body` when a middleware
 * already parsed it, otherwise reads the raw stream (capped).
 */
export function createBrowserRelayHandler(
	opts: RelayOptions,
): (
	req: IncomingMessage & { body?: unknown },
	res: ServerResponse,
) => void {
	const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
	const redactor =
		opts.redact === undefined || opts.redact === true
			? defaultRelayRedactor
			: makeRedactor(opts.redact);
	const limiter =
		opts.perIpRateLimit === false
			? null
			: new IpWindow(opts.perIpRateLimit ?? 120);

	function respond(res: ServerResponse, status: number, body?: object): void {
		res.statusCode = status;
		if (body) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(body));
		} else {
			res.end();
		}
	}

	function handleParsed(raw: unknown, res: ServerResponse): void {
		const payload = sanitizeBrowserPayload(raw, redactor);
		if (!payload) {
			respond(res, 400, { error: "invalid payload" });
			return;
		}
		forward(payload, opts);
		respond(res, 202);
	}

	return (req, res) => {
		if (req.method !== "POST") {
			respond(res, 405);
			return;
		}
		if (limiter) {
			const ip = nodeClientKey(req, opts);
			if (!limiter.allow(ip)) {
				respond(res, 429, { error: "rate limit exceeded" });
				return;
			}
		}
		if (req.body !== undefined) {
			let raw: unknown = req.body;
			if (typeof raw === "string" || Buffer.isBuffer(raw)) {
				try {
					raw = JSON.parse(raw.toString());
				} catch {
					respond(res, 400, { error: "invalid json" });
					return;
				}
			}
			handleParsed(raw, res);
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBody) {
				aborted = true;
				respond(res, 413, { error: "payload too large" });
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				handleParsed(JSON.parse(Buffer.concat(chunks).toString()), res);
			} catch {
				respond(res, 400, { error: "invalid json" });
			}
		});
		req.on("error", () => {
			if (!aborted) respond(res, 400, { error: "read error" });
		});
	};
}
