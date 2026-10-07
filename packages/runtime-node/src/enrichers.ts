import { parseUserAgent } from "@autter/runtime-core";
import type { RuntimeEnricher } from "./logger.js";

/**
 * Built-in enrichers for `logging.enrich`. They run on operation/request
 * summaries before redaction and bounding, and only ever add COARSE values:
 * no raw user agents, IPs, cities or headers.
 *
 *   initAutterServer({ ..., logging: { enrich: [enrichUserAgent(), enrichDeployment()] } });
 */

function headerOf(req: unknown, name: string): string | undefined {
	const headers = (req as { headers?: unknown } | null | undefined)?.headers;
	if (!headers) return undefined;
	if (typeof (headers as Headers).get === "function") {
		return (headers as Headers).get(name) ?? undefined;
	}
	const value = (headers as Record<string, unknown>)[name.toLowerCase()];
	if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
	return value === undefined || value === null ? undefined : String(value);
}

/** `user_agent.browser` ("Chrome 120"), `user_agent.os`, `user_agent.device`, `user_agent.bot`. */
export function enrichUserAgent(): RuntimeEnricher {
	return (event, { req }) => {
		const ua = headerOf(req, "user-agent");
		if (!ua) return;
		const info = parseUserAgent(ua);
		if (info.browser) event.attributes["user_agent.browser"] = info.browser;
		if (info.os) event.attributes["user_agent.os"] = info.os;
		event.attributes["user_agent.device"] = info.device;
		event.attributes["user_agent.bot"] = info.bot;
	};
}

/** `http.request.body.size` / `http.response.body.size` from Content-Length. */
export function enrichRequestSize(): RuntimeEnricher {
	return (event, { req, res }) => {
		const request = Number(headerOf(req, "content-length"));
		if (Number.isFinite(request) && request >= 0)
			event.attributes["http.request.body.size"] = request;
		const raw = (res as { getHeader?: (name: string) => unknown } | undefined)?.getHeader?.(
			"content-length",
		);
		const response = Number(raw);
		if (raw !== undefined && Number.isFinite(response) && response >= 0)
			event.attributes["http.response.body.size"] = response;
	};
}

const COUNTRY_HEADERS = [
	"cf-ipcountry",
	"x-vercel-ip-country",
	"cloudfront-viewer-country",
	"x-country-code",
	"fastly-geo-country-code",
];

/** `geo.country.iso_code` from CDN/edge headers (Cloudflare, Vercel, CloudFront, Fastly). Country only. */
export function enrichEdgeGeo(): RuntimeEnricher {
	return (event, { req }) => {
		for (const name of COUNTRY_HEADERS) {
			const value = headerOf(req, name)?.trim().toUpperCase();
			if (value && /^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "T1") {
				event.attributes["geo.country.iso_code"] = value;
				return;
			}
		}
	};
}

const REGION_VARS = [
	"AUTTER_REGION",
	"AWS_REGION",
	"VERCEL_REGION",
	"FLY_REGION",
	"RAILWAY_REPLICA_REGION",
	"GOOGLE_CLOUD_REGION",
	"CLOUD_RUN_REGION",
	"RENDER_REGION",
	"AZURE_REGION",
];
const COMMIT_VARS = [
	"AUTTER_COMMIT",
	"GIT_SHA",
	"GIT_COMMIT",
	"COMMIT_SHA",
	"SOURCE_COMMIT",
	"VERCEL_GIT_COMMIT_SHA",
	"GITHUB_SHA",
	"RENDER_GIT_COMMIT",
	"RAILWAY_GIT_COMMIT_SHA",
	"CF_PAGES_COMMIT_SHA",
	"HEROKU_SLUG_COMMIT",
	"SOURCE_VERSION",
];

/** `deployment.region` and `deployment.commit` from common platform environment variables. */
export function enrichDeployment(
	env: Record<string, string | undefined> = process.env,
): RuntimeEnricher {
	const pick = (names: string[]) =>
		names.map((name) => env[name]?.trim()).find((value) => value);
	const region = pick(REGION_VARS)?.slice(0, 64);
	const commit = pick(COMMIT_VARS)?.slice(0, 64);
	return (event) => {
		if (region) event.attributes["deployment.region"] = region;
		if (commit) event.attributes["deployment.commit"] = commit;
	};
}
