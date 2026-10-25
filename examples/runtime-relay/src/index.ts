// Same-origin relay for @autter/runtime-browser on serverless static sites.
//
// Why: the direct ingest path (https://otlp.autter.dev/v1/browser with an
// `autter_rtc_*` client key) is a third-party cross-origin call, so
// tracker/ad-blockers (EasyPrivacy/uBlock-style lists) can silently drop it.
// A same-origin relay (your domain's /api/autter-runtime -> ingester) looks
// like your own API traffic and is not blocklisted.
//
// Mount: deploy this worker on your domain's /api/autter-runtime* route, then
//   initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" })
// No key ships to the browser — the ingester validates the Origin allow-list
// on `autter_rtc_*`, or use a server key via the `Authorization` header when
// your relay holds `AUTTER_RUNTIME_KEY` as a secret.

const MAX_BODY_BYTES = 64 * 1024;

// ── Per-visitor rate limit ─────────────────────────────────────────────────
// The relay is public, so without a cap anyone can push unbounded traffic
// through it under your key. The visitor is the address the platform itself
// vouches for: on a Worker, CF-Connecting-IP (trusted only
// because the runtime set `request.cf`), else the rightmost public
// X-Forwarded-For entry. Never the first
// X-Forwarded-For entry: any caller can write it to get a fresh window on
// every request. The window lives in this isolate's memory, so it is a backstop
// per isolate rather than a global quota. AUTTER_RELAY_RATE_LIMIT sets requests
// per minute (default 120); "0" or "false" turns it off when a WAF already
// limits the route.

const DEFAULT_RATE_LIMIT = 120;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function normalizeAddress(entry: string | null | undefined): string | null {
  if (!entry) return null;
  let a = entry.trim().toLowerCase();
  if (!a || a.length > 64) return null;
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(a);
  if (bracketed) a = bracketed[1] ?? "";
  else if (/^[\d.]+:\d{1,5}$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
  if (a.startsWith("::ffff:") && IPV4.test(a.slice(7))) a = a.slice(7);
  if (IPV4.test(a)) return a;
  return /^[0-9a-f:]+$/.test(a) && a.includes(":") ? a : null;
}

// Loopback, private, link-local, carrier-grade NAT, unique-local: your own hops.
function isPrivateAddress(a: string): boolean {
  if (IPV4.test(a)) {
    const [x, y] = a.split(".").map(Number) as [number, number];
    return x === 10 || x === 127 || x === 0 || (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) ||
      (x === 100 && y >= 64 && y <= 127);
  }
  return a === "::1" || a === "::" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

// Proxies append the address they saw on the right (or overwrite the header):
// read right to left and take the first public entry.
function rightmostPublicForwardedFor(header: string | null): string | null {
  const entries = (header ?? "").split(",").map(normalizeAddress).filter((a): a is string => a !== null);
  for (let i = entries.length - 1; i >= 0; i--) {
    const a = entries[i];
    if (a && !isPrivateAddress(a)) return a;
  }
  return entries[entries.length - 1] ?? null;
}

class VisitorWindow {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly limitPerMinute: number) {}
  allow(key: string): boolean {
    const start = Math.floor(Date.now() / 60_000) * 60_000;
    const entry = this.windows.get(key);
    if (!entry || entry.start !== start) {
      if (this.windows.size >= 50_000) this.windows.clear();
      this.windows.set(key, { start, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limitPerMinute;
  }
}

function rateLimitFrom(value: string | undefined): number | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RATE_LIMIT;
}

let windowFor: { limit: number; window: VisitorWindow } | null = null;

function visitorKey(request: Request): string {
  const cf = (request as unknown as { cf?: unknown }).cf;
  if (cf !== null && typeof cf === "object") {
    const viaCf = normalizeAddress(request.headers.get("CF-Connecting-IP"));
    if (viaCf) return viaCf;
  }
  return rightmostPublicForwardedFor(request.headers.get("X-Forwarded-For")) ?? "shared";
}

interface Env {
  ASSETS?: Fetcher;
  AUTTER_INGEST_URL?: string;
  // Optional: set via `wrangler secret put AUTTER_RUNTIME_KEY` to upgrade the
  // relay from publishable client key to server key (never exposed to browser).
  AUTTER_RUNTIME_KEY?: string;
  // Optional: requests per minute per visitor (default 120; "0" turns it off).
  AUTTER_RELAY_RATE_LIMIT?: string;
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    const limit = rateLimitFrom(env.AUTTER_RELAY_RATE_LIMIT);
    if (limit !== null) {
      if (!windowFor || windowFor.limit !== limit) windowFor = { limit, window: new VisitorWindow(limit) };
      if (!windowFor.window.allow(visitorKey(request))) {
        return new Response("Rate limit exceeded", { status: 429, headers: corsHeaders(origin) });
      }
    }

    const contentLength = Number(request.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return new Response("Payload too large", { status: 413, headers: corsHeaders(origin) });
    }

    const upstream = env.AUTTER_INGEST_URL ?? "https://otlp.autter.dev/v1/browser";
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    // Forward Origin so the ingester can enforce the client key's allow-list.
    if (origin) headers.set("Origin", origin);
    const clientKey = request.headers.get("Authorization");
    if (clientKey) headers.set("Authorization", clientKey);
    else if (env.AUTTER_RUNTIME_KEY) headers.set("Authorization", `Bearer ${env.AUTTER_RUNTIME_KEY}`);
    // Never forward browser cookies to a third party.
    // (Deliberately not copying Cookie / Host from the incoming request.)

    const init: RequestInit = {
      method: "POST",
      headers,
      redirect: "manual",
    };
    if (request.body) {
      init.body = request.body;
      (init as RequestInit & { duplex: "half" }).duplex = "half";
    }
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstream, init);
    } catch {
      return new Response("Bad gateway", { status: 502, headers: corsHeaders(origin) });
    }
    // Return 202 fast like createBrowserRelayHandler — the SDK treats any 2xx as accepted.
    return new Response(null, {
      status: upstreamRes.ok ? 202 : upstreamRes.status,
      headers: corsHeaders(origin),
    });
  },
};
