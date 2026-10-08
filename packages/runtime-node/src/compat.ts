import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
// Bundled at build time from the ingester's single source of truth (no
// runtime dependency on @autter/otlp-ingester).
import {
	COMPAT_MANIFEST,
	evaluateCompat,
	featureById,
	featuresForBrowserEvents,
	ingesterInfoFromReport,
	ingesterUpgradeHint,
	INGESTER_VERSION_HEADER,
	type CompatIssue,
	type IngesterCompatInfo,
	type SdkIdentity,
} from "../../otlp-ingester/src/compat.js";
import pkg from "../package.json" with { type: "json" };
import { debugLog } from "./lifecycle.js";

export {
	COMPAT_MANIFEST,
	evaluateCompat,
	INGESTER_VERSION_HEADER,
	type CompatIssue,
	type IngesterCompatInfo,
	type SdkIdentity,
};

/**
 * One-time, fire-and-forget version compatibility check.
 *
 * When a feature that needs a newer ingester is in use (operation logging,
 * memory metrics, …), ask the ingester once — `GET /v1/compat`, or the
 * `x-autter-ingester-version` header on responses the SDK already receives —
 * and print ONE clear warning per incompatible feature naming both versions
 * and the fix. Never throws, never blocks or delays startup or exit (the
 * socket is unref'd), and is silent when versions match or can't be
 * determined. Disable with `compatCheck: false` or AUTTER_COMPAT_CHECK=0.
 */

export const SDK_IDENTITY: SdkIdentity = {
	name: "@autter/runtime-node",
	version: (pkg as { version: string }).version,
};

const TIMEOUT_MS = 3000;

export interface HttpResult {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

/**
 * Minimal GET/POST that never rejects (null on any failure). With
 * `unref: true` the request never keeps the process alive — a short-lived
 * script exits normally even mid-check.
 */
export function compatRequest(
	method: "GET" | "POST",
	url: string,
	options: { body?: string; headers?: Record<string, string>; unref?: boolean; timeoutMs?: number } = {},
): Promise<HttpResult | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: HttpResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			req?.destroy();
			done(null);
		}, options.timeoutMs ?? TIMEOUT_MS);
		if (options.unref !== false) timer.unref();
		let req: ReturnType<typeof httpRequest> | undefined;
		try {
			const target = new URL(url);
			const send = target.protocol === "https:" ? httpsRequest : httpRequest;
			req = send(
				target,
				{
					method,
					headers: {
						accept: "application/json",
						"user-agent": `${SDK_IDENTITY.name}/${SDK_IDENTITY.version}`,
						...(options.body !== undefined
							? { "content-type": "application/json", "content-length": String(Buffer.byteLength(options.body)) }
							: {}),
						...options.headers,
					},
				},
				(res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						if (body.length < 256 * 1024) body += chunk;
					});
					res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
					res.on("error", () => done(null));
				},
			);
			if (options.unref !== false) req.on("socket", (socket) => socket.unref());
			req.on("error", () => done(null));
			req.end(options.body);
		} catch {
			done(null);
		}
	});
}

/**
 * What the ingester at `endpoint` supports. `null` = unknown (unreachable,
 * auth proxy, 5xx). A 404 on /v1/compat means a pre-compat ingester (1.4.0 or
 * older); `probeRoutes` then learns which feature routes exist (an
 * unauthenticated POST answers 401/503/… when the route exists, 404 when not).
 */
export async function fetchIngesterCompat(
	endpoint: string,
	options: { probeRoutes?: string[]; unref?: boolean; timeoutMs?: number } = {},
): Promise<{ info: IngesterCompatInfo | null; report: unknown; error?: string }> {
	const base = endpoint.replace(/\/$/, "");
	const res = await compatRequest("GET", `${base}/v1/compat`, options);
	if (!res) return { info: null, report: null, error: `could not reach ${base}/v1/compat` };
	if (res.status === 200) {
		let report: unknown = null;
		try {
			report = JSON.parse(res.body);
		} catch {
			// fall through to the header
		}
		const info = ingesterInfoFromReport(report) ?? headerInfo(res.headers);
		return info
			? { info, report }
			: { info: null, report, error: "unrecognised /v1/compat response" };
	}
	if (res.status === 404) {
		const fromHeader = headerInfo(res.headers);
		if (fromHeader) return { info: fromHeader, report: null };
		const routes: Record<string, boolean> = {};
		for (const route of options.probeRoutes ?? []) {
			const exists = await probeRoute(base, route, options);
			if (exists !== null) routes[route] = exists;
		}
		return { info: { version: null, legacy: true, routes }, report: null };
	}
	return { info: headerInfo(res.headers), report: null, error: `/v1/compat answered ${res.status}` };
}

async function probeRoute(
	base: string,
	route: string,
	options: { unref?: boolean; timeoutMs?: number },
): Promise<boolean | null> {
	const res = await compatRequest("POST", `${base}${route}`, { ...options, body: "{}" });
	return res ? res.status !== 404 : null;
}

function headerInfo(headers: IncomingHttpHeaders | Headers): IngesterCompatInfo | null {
	const raw =
		typeof (headers as Headers).get === "function"
			? (headers as Headers).get(INGESTER_VERSION_HEADER)
			: (headers as IncomingHttpHeaders)[INGESTER_VERSION_HEADER];
	const version = Array.isArray(raw) ? raw[0] : raw;
	return version ? ingesterInfoFromReport({ ingester: { version } }) : null;
}

// ── process-wide check state ────────────────────────────────────────────

interface CompatState {
	endpoint: string | null;
	enabled: boolean;
	sdk: SdkIdentity;
	features: Set<string>;
	info: IngesterCompatInfo | null;
	started: boolean;
	pendingProbes: Set<string>;
	warned: Set<string>;
	warn: (message: string) => void;
}

function envDisabled(): boolean {
	const value = process.env.AUTTER_COMPAT_CHECK?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

const defaultWarn = (message: string) => console.warn(`[autter-runtime] ${message}`);

let state: CompatState = freshState(null, false);

function freshState(endpoint: string | null, enabled: boolean, sdk = SDK_IDENTITY, warn = defaultWarn): CompatState {
	return {
		endpoint,
		enabled,
		sdk,
		features: new Set(),
		info: null,
		started: false,
		pendingProbes: new Set(),
		warned: new Set(),
		warn,
	};
}

/** Called by initAutterServer. Resets per-process state. */
export function configureCompatCheck(options: {
	endpoint: string;
	enabled?: boolean;
	sdk?: SdkIdentity;
	warn?: (message: string) => void;
}): void {
	state = freshState(
		options.endpoint.replace(/\/$/, ""),
		options.enabled !== false && !envDisabled(),
		options.sdk ?? SDK_IDENTITY,
		options.warn ?? defaultWarn,
	);
}

/** Relay-only processes (no initAutterServer): check against the relay's
 * ingester. A no-op once initAutterServer configured the check. */
export function ensureCompatConfigured(endpoint: string): void {
	if (state.endpoint === null && !envDisabled()) {
		state = freshState(endpoint.replace(/\/$/, ""), true);
	}
}

/** Test hook: back to the unconfigured, disabled state. */
export function resetCompatCheck(): void {
	state = freshState(null, false);
}

/** A feature is in use. Starts the one-time check if needed. Never throws. */
export function noteCompatFeature(id: string): void {
	try {
		if (!state.enabled || state.features.has(id) || !featureById(id)) return;
		state.features.add(id);
		if (state.info) {
			evaluateAndWarn();
			return;
		}
		if (state.started) return;
		state.started = true;
		const current = state;
		// Deferred and unref'd: never on the init call path.
		setTimeout(() => void runCheck(current), 0).unref();
	} catch {
		// never break the host app
	}
}

async function runCheck(current: CompatState): Promise<void> {
	try {
		if (!current.endpoint) return;
		const { info, error } = await fetchIngesterCompat(current.endpoint, {
			probeRoutes: routesFor(current.features),
		});
		if (state !== current) return; // reconfigured meanwhile
		if (!info) {
			debugLog(`compat check skipped: ${error ?? "ingester version unknown"}`);
			return;
		}
		mergeInfo(info);
		for (const route of routesFor(current.features)) current.pendingProbes.add(route);
		debugLog(
			`compat check: ingester ${info.version ?? "1.4.0 or older (no /v1/compat)"}` +
				(info.schema ? `, schema ${info.schema.status}` : "") +
				`, sdk ${current.sdk.name}@${current.sdk.version}, features ${[...current.features].join(", ") || "none"}`,
		);
		evaluateAndWarn();
	} catch (err) {
		debugLog("compat check failed", err);
	}
}

function routesFor(features: Iterable<string>): string[] {
	const routes: string[] = [];
	for (const id of features) {
		const route = featureById(id)?.route;
		if (route && !routes.includes(route)) routes.push(route);
	}
	return routes;
}

function mergeInfo(next: IngesterCompatInfo): void {
	const prev = state.info;
	state.info = {
		version: next.version ?? prev?.version ?? null,
		...(next.legacy || prev?.legacy ? { legacy: true } : {}),
		...(next.schema ?? prev?.schema ? { schema: (next.schema ?? prev?.schema)! } : {}),
		routes: { ...prev?.routes, ...next.routes },
	};
}

function evaluateAndWarn(): void {
	const info = state.info;
	if (!info) return;
	// Legacy ingester + a newly used feature with an unprobed route: probe it.
	if (info.version === null && state.endpoint) {
		const unprobed = routesFor(state.features).filter(
			(route) => info.routes?.[route] === undefined && !state.pendingProbes.has(route),
		);
		if (unprobed.length) {
			const current = state;
			for (const route of unprobed) current.pendingProbes.add(route);
			void Promise.all(unprobed.map((route) => probeRoute(current.endpoint!, route, {}).then((exists) => [route, exists] as const)))
				.then((results) => {
					if (state !== current) return;
					const routes: Record<string, boolean> = {};
					for (const [route, exists] of results) if (exists !== null) routes[route] = exists;
					mergeInfo({ version: null, legacy: true, routes });
					evaluateAndWarn();
				})
				.catch(() => {});
		}
	}
	for (const issue of evaluateCompat({ features: state.features, ingester: info })) {
		warnOnce(issue);
	}
}

function warnOnce(issue: CompatIssue): void {
	const key = `${issue.feature}:${issue.kind}`;
	if (state.warned.has(key)) return;
	state.warned.add(key);
	try {
		state.warn(issue.message);
	} catch {
		// a throwing custom logger must not break telemetry
	}
}

/**
 * Feed a response the SDK already received from the ingester (log export,
 * browser relay). Learns the version from the header for free, and a 404 on
 * a feature route proves a pre-feature ingester. Never throws.
 */
export function observeIngesterResponse(response: {
	status: number;
	headers: Headers | IncomingHttpHeaders;
	route?: string;
}): void {
	try {
		if (!state.enabled) return;
		const fromHeader = headerInfo(response.headers);
		if (fromHeader) {
			if (state.info?.version !== fromHeader.version) {
				mergeInfo(fromHeader);
				evaluateAndWarn();
			}
			return;
		}
		if (response.status === 404 && response.route && !state.info?.version) {
			mergeInfo({ version: null, legacy: true, routes: { [response.route]: false } });
			evaluateAndWarn();
		}
	} catch {
		// never break the host app
	}
}

/**
 * Browser relay: the ingester rejected (400) a batch that contained events
 * of a newer browser feature, and the ingester doesn't report a version —
 * i.e. it predates version reporting (1.4.0 or older). One hedged warning per
 * feature; returns the features named (for tests).
 */
export function noteRelayRejection(eventTypes: Iterable<string>, status: number, headers: Headers): string[] {
	try {
		if (!state.enabled || status !== 400 || headerInfo(headers)) return [];
		const named: string[] = [];
		for (const id of featuresForBrowserEvents(eventTypes)) {
			const feature = featureById(id)!;
			const key = `${id}:relay_rejected`;
			if (state.warned.has(key)) continue;
			state.warned.add(key);
			named.push(id);
			try {
				state.warn(
					`The ingester rejected a browser batch containing ${feature.title.toLowerCase()} events. ` +
						`${feature.title} needs ingester >= ${feature.ingester}; yours is 1.4.0 or older (it predates version reporting), ` +
						`so those batches are dropped. ${ingesterUpgradeHint(COMPAT_MANIFEST)}`,
				);
			} catch {
				// ignore
			}
		}
		return named;
	} catch {
		return [];
	}
}

/** For tests and `doctor`: what the process-wide check knows. */
export function compatCheckState(): {
	enabled: boolean;
	features: string[];
	info: IngesterCompatInfo | null;
	warned: string[];
} {
	return {
		enabled: state.enabled,
		features: [...state.features],
		info: state.info,
		warned: [...state.warned],
	};
}
