import type { Attributes } from "@opentelemetry/api";

/**
 * Query strings in span URLs. They carry what a path should not: emails,
 * one-time codes, API keys, session ids, search terms. Applied at export
 * (redact-exporter.ts) to every span, whichever instrumentation made it
 * (http, undici/fetch, Express, Fastify, Next.js's own spans, …):
 *
 * - `http.target`, `http.url`, `url.full` and `url.original` (and
 *   `url.path`, which should never have one) lose their query string and
 *   fragment: `/search?q=jane@example.com` → `/search`. `http.route` is a
 *   template, where `?` marks an optional parameter (`/users/:id?`), and is
 *   left alone;
 * - `url.query` keeps only the parameter names:
 *   `email=[redacted]&page=[redacted]`. A span whose query was only inside
 *   `http.target` / `http.url` / `url.full` gets `url.query` in that form, so
 *   which parameters a request used is not lost. A parameter without `=`
 *   (`?<token>`) may itself be the secret and is masked whole;
 * - span names lose the query of any path or URL in them: Next.js names a
 *   request span `GET /search?q=…` until it knows the route (and Next 15
 *   copies that name into `next.span_name`).
 *
 * `keepQueryParams` lists parameters whose values are safe to keep in
 * `url.query` (pagination, sorting): `page=2&email=[redacted]`. Names match
 * exactly, after percent-decoding. Kept values are still scrubbed by
 * `redactAttributes`.
 */
export interface UrlQueryPolicy {
	/** `attributes` with the policy applied; the same object when nothing changed. */
	attributes(attributes: Attributes): Attributes;
	/** A span name without query strings. */
	name(name: string): string;
}

/** Attributes holding a URL or a path with an optional query. */
const URL_KEYS = ["http.target", "http.url", "url.full", "url.original", "url.path"];
const QUERY_KEY = "url.query";
/** Attributes holding a span name. */
const NAME_KEYS = ["next.span_name"];
const MASK = "[redacted]";
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Split `value` at its query or fragment (after the authority of an
 * absolute URL); null when it has neither. */
function splitUrl(value: string): { base: string; query: string | null } | null {
	const from = SCHEME.test(value) ? value.indexOf("://") + 3 : 0;
	const question = value.indexOf("?", from);
	const hash = value.indexOf("#", from);
	const at = question < 0 ? hash : hash < 0 ? question : Math.min(question, hash);
	if (at < 0) return null;
	const query = at === question ? value.slice(at + 1, hash > at ? hash : undefined) : null;
	return { base: value.slice(0, at), query };
}

function decodeName(raw: string): string {
	try {
		return decodeURIComponent(raw.replace(/\+/g, " "));
	} catch {
		return raw;
	}
}

export function makeUrlQueryPolicy(keepQueryParams: readonly string[] = []): UrlQueryPolicy {
	const keep = new Set(keepQueryParams.filter((name) => typeof name === "string"));

	const maskQuery = (query: string): string => {
		const out: string[] = [];
		for (const part of query.split("&")) {
			if (!part) continue;
			const eq = part.indexOf("=");
			const name = eq < 0 ? part : part.slice(0, eq);
			if (keep.size && keep.has(decodeName(name))) out.push(part);
			else if (eq < 0) out.push(MASK);
			else out.push(eq === part.length - 1 ? part : `${name}=${MASK}`);
		}
		return out.join("&");
	};

	const stripName = (name: string): string => {
		if (!name.includes("?") && !name.includes("#")) return name;
		return name
			.split(" ")
			.map((token) => {
				if (!token.startsWith("/") && !SCHEME.test(token)) return token;
				return splitUrl(token)?.base ?? token;
			})
			.join(" ");
	};

	return {
		attributes(attributes) {
			let out: Attributes | null = null;
			const set = (key: string, value: string) => {
				out ??= { ...attributes };
				out[key] = value;
			};
			let dropped: string | null = null;
			for (const key of URL_KEYS) {
				const value = attributes[key];
				if (typeof value !== "string") continue;
				const split = splitUrl(value);
				if (!split) continue;
				set(key, split.base);
				if (split.query) dropped ??= split.query;
			}
			for (const key of NAME_KEYS) {
				const value = attributes[key];
				if (typeof value !== "string") continue;
				const stripped = stripName(value);
				if (stripped !== value) set(key, stripped);
			}
			const current = attributes[QUERY_KEY];
			if (typeof current === "string") {
				const masked = maskQuery(current.startsWith("?") ? current.slice(1) : current);
				if (masked !== current) set(QUERY_KEY, masked);
			} else if (current !== undefined) {
				set(QUERY_KEY, MASK);
			} else if (dropped !== null) {
				const masked = maskQuery(dropped);
				if (masked) set(QUERY_KEY, masked);
			}
			return out ?? attributes;
		},
		name: stripName,
	};
}
