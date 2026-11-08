import { sharedSlot } from "./shared.js";

/**
 * Ingest key hygiene for every exporter this package owns (traces,
 * metrics, logs, the browser relay).
 *
 * Before 1.10 a missing key was interpolated as the literal header
 * `Bearer undefined`, and every 401 that followed was dropped silently by
 * the OpenTelemetry exporters (they report through `diag`, which is off by
 * default). Now:
 *
 * - `resolveIngestKey` treats unset, empty, "undefined" and "null" as no
 *   key, and falls back to AUTTER_RUNTIME_KEY.
 * - With no key, nothing is sent and ONE warning says so at startup.
 * - The first refusal from the ingester (401, 403, or a 404 on a route)
 *   is logged ONCE per status and route, with the ingester's own reason
 *   and what to do next.
 *
 * Never throws: a broken console must not break the host app.
 */

const NOT_A_KEY = new Set(["", "undefined", "null"]);

/** The key to send, or null when there is none worth sending. */
export function resolveIngestKey(
	explicit: unknown,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	for (const candidate of [explicit, env.AUTTER_RUNTIME_KEY]) {
		if (typeof candidate !== "string") continue;
		const key = candidate.trim();
		if (!NOT_A_KEY.has(key.toLowerCase())) return key;
	}
	return null;
}

/** Authorization header for a key; empty (no header at all) without one. */
export function authHeaders(key: string | null): Record<string, string> {
	return key ? { authorization: `Bearer ${key}` } : {};
}

type Warn = (message: string) => void;

interface AuthWarnState {
	warned: Set<string>;
	warn: Warn;
}

const defaultWarn: Warn = (message) => console.warn(`[autter-runtime] ${message}`);
const state = sharedSlot("ingest-auth", () => ({ warned: new Set<string>(), warn: defaultWarn }) as AuthWarnState);

function once(id: string, message: string): boolean {
	if (state.warned.has(id)) return false;
	state.warned.add(id);
	try {
		state.warn(message);
	} catch {
		// a throwing logger must not break telemetry
	}
	return true;
}

const VERIFY_HINT = "Then run: npx @autter/runtime-node verify";

/** Where the key came from and what it is for, for the startup warning. */
export function warnMissingKey(where: "server" | "relay", service?: string): boolean {
	const what =
		where === "relay"
			? "the browser relay has no ingest key (apiKey is unset and AUTTER_RUNTIME_KEY is not set), so browser events are refused (500) instead of being sent"
			: `initAutterServer() got no apiKey and AUTTER_RUNTIME_KEY is not set, so traces, metrics and logs${service ? ` from "${service}"` : ""} are not sent`;
	return once(
		`missing:${where}`,
		`No ingest key: ${what}. Set AUTTER_RUNTIME_KEY to a server key (autter_rt_…). ${VERIFY_HINT}`,
	);
}

/** A key of the wrong kind for a server SDK: say so at startup, not at the first 403. */
export function warnKeyKind(key: string | null): boolean {
	if (!key) return false;
	if (key.startsWith("autter_rtc_")) {
		return once(
			"kind:client",
			"AUTTER_RUNTIME_KEY is a client (browser) key (autter_rtc_…). Server SDKs and the relay need a server key (autter_rt_…); the ingester refuses this one with 403.",
		);
	}
	if (key.startsWith("autter_rtu_")) {
		return once(
			"kind:upload",
			"AUTTER_RUNTIME_KEY is an upload-only key (autter_rtu_…) for source maps. Server SDKs need a server key (autter_rt_…); the ingester refuses this one with 403.",
		);
	}
	return false;
}

/** The ingester's `{"error": "…"}` (or a short plain body), on one line. */
export function refusalReason(body: unknown): string {
	let text = "";
	if (typeof body === "string") {
		try {
			const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown };
			text = [parsed.error, parsed.detail].filter((v) => typeof v === "string" && v).join(": ");
		} catch {
			text = body;
		}
	}
	return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * The ingester refused a request. Logs once per status (and route, for
 * 404) with the reason; returns true when this call printed. 429 and 5xx
 * are retried by every exporter and are not logged here.
 */
export function noteIngestRefusal(input: {
	status: number;
	route: string;
	endpoint: string;
	body?: unknown;
	/** "relay" for the browser relay's forwards. */
	via?: "sdk" | "relay";
}): boolean {
	try {
		const { status, route, endpoint } = input;
		const reason = refusalReason(input.body);
		const said = reason ? ` (${status}: ${reason})` : ` (${status})`;
		const who = input.via === "relay" ? "browser events forwarded by the relay are" : "this data is";
		if (status === 401) {
			return once(
				"status:401",
				`The ingester at ${endpoint} refused the ingest key on ${route}${said}. Nothing is stored until it is fixed: ${who} dropped. ` +
					`Check AUTTER_RUNTIME_KEY (a server key, autter_rt_…, for this repository). ${VERIFY_HINT}`,
			);
		}
		if (status === 403) {
			return once(
				`status:403:${route}`,
				`The ingester at ${endpoint} refused ${route}${said}; ${who} dropped. ${VERIFY_HINT}`,
			);
		}
		if (status === 404) {
			return once(
				`status:404:${route}`,
				`${endpoint}${route} answered 404: this ingester has no ${route} route, so ${who} dropped. ` +
					`Either the ingester is older than the feature (run: npx @autter/runtime-node doctor) or the endpoint has an extra path (set it to the ingester's base URL).`,
			);
		}
		if (status === 400 || status === 413 || status === 415) {
			return once(
				`status:${status}:${route}`,
				`The ingester at ${endpoint} rejected a ${route} batch${said}; ${who} dropped.`,
			);
		}
		return false;
	} catch {
		return false;
	}
}

/** Test hook: forget what was warned, optionally capture warnings. */
export function resetIngestAuthWarnings(warn?: Warn): void {
	state.warned = new Set();
	state.warn = warn ?? defaultWarn;
}

/** Test hook: the warning ids printed so far. */
export function ingestAuthWarnings(): string[] {
	return [...state.warned];
}
