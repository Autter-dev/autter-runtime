import type { IncomingMessage, ServerResponse } from "node:http";

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
	/** Called when the async forward fails (default: console.warn). */
	onError?: (err: unknown) => void;
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

const DEFAULT_ENDPOINT = "https://otlp.autter.dev";
const DEFAULT_MAX_BODY = 64 * 1024;
const MAX_EVENTS = 50;

const EVENT_TYPES = new Set([
	"exception",
	"unhandled_rejection",
	"message",
	"session_start",
	"track_event",
]);

const SEVERITIES = new Set(["fatal", "error", "warning", "info"]);

// Whitelist sanitiser — anything not listed here is dropped, so a
// compromised or buggy client can't smuggle cookies/DOM/bodies through the
// relay. Returns null when the payload is structurally invalid.
export function sanitizeBrowserPayload(raw: unknown): object | null {
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
				typeof e.message === "string" ? e.message.slice(0, 4000) : "",
			...(typeof e.name === "string" ? { name: e.name.slice(0, 200) } : {}),
			...(typeof e.stack === "string"
				? { stack: e.stack.slice(0, 32000) }
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
				? { context: e.context }
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
		events,
	};
}

function forward(payload: object, opts: RelayOptions): void {
	const url = `${(opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")}/v1/browser`;
	void fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${opts.apiKey}`,
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(10_000),
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
	const limiter =
		opts.perIpRateLimit === false
			? null
			: new IpWindow(opts.perIpRateLimit ?? 120);
	return async (request: Request): Promise<Response> => {
		if (request.method !== "POST") {
			return new Response(null, { status: 405 });
		}
		if (limiter) {
			const ip =
				firstForwardedFor(request.headers.get("x-forwarded-for")) || "unknown";
			if (!limiter.allow(ip)) {
				return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
					status: 429,
				});
			}
		}
		const text = await request.text();
		if (text.length > maxBody) {
			return new Response(JSON.stringify({ error: "payload too large" }), {
				status: 413,
			});
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return new Response(JSON.stringify({ error: "invalid json" }), {
				status: 400,
			});
		}
		const payload = sanitizeBrowserPayload(raw);
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
		const payload = sanitizeBrowserPayload(raw);
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
			const ip =
				firstForwardedFor(req.headers["x-forwarded-for"]) ||
				req.socket?.remoteAddress ||
				"unknown";
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
