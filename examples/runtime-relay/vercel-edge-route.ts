// Vercel Edge same-origin relay for @autter/runtime-browser.
// Place at `app/api/autter-runtime/route.ts` (App Router) or
// `pages/api/autter-runtime.ts` (adapt export). Same contract as the
// Cloudflare Worker template in `src/index.ts` and Express
// `createBrowserRelayHandler`: POST-only, 64KB cap, per-visitor rate limit,
// no cookies forwarded.
//
//   initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web-app" })

export const runtime = "edge";

const UPSTREAM =
  process.env.AUTTER_INGEST_URL ?? "https://otlp.autter.dev/v1/browser";
const MAX_BODY_BYTES = 64 * 1024;

// ── Per-visitor rate limit ─────────────────────────────────────────────────
// The relay is public, so without a cap anyone can push unbounded traffic
// through it under your key. The visitor is the address the platform itself
// vouches for: Vercel overwrites X-Forwarded-For with the
// client address, so the rightmost public entry is the visitor on Vercel and
// behind any other proxy that appends. Never the first
// X-Forwarded-For entry: any caller can write it to get a fresh window on
// every request. The window lives in this function instance's memory, so it is a backstop
// per instance rather than a global quota. AUTTER_RELAY_RATE_LIMIT sets requests
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

const RATE_LIMIT = rateLimitFrom(process.env.AUTTER_RELAY_RATE_LIMIT);
const visitors = RATE_LIMIT === null ? null : new VisitorWindow(RATE_LIMIT);

function cors(origin: string | null): Headers {
  const headers = new Headers();
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return headers;
}

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: cors(request.headers.get("Origin")),
  });
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (visitors) {
    const key = rightmostPublicForwardedFor(request.headers.get("X-Forwarded-For")) ?? "shared";
    if (!visitors.allow(key)) {
      return new Response("Rate limit exceeded", { status: 429, headers: cors(origin) });
    }
  }
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413, headers: cors(origin) });
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  if (origin) headers.set("Origin", origin);
  const clientKey = request.headers.get("Authorization");
  if (clientKey) headers.set("Authorization", clientKey);
  else if (process.env.AUTTER_RUNTIME_KEY)
    headers.set("Authorization", `Bearer ${process.env.AUTTER_RUNTIME_KEY}`);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(UPSTREAM, {
      method: "POST",
      headers,
      body: request.body,
      // @ts-expect-error Edge runtime streaming
      duplex: "half",
      redirect: "manual",
    });
  } catch {
    return new Response("Bad gateway", { status: 502, headers: cors(origin) });
  }
  return new Response(null, {
    status: upstreamRes.ok ? 202 : upstreamRes.status,
    headers: cors(origin),
  });
}
