/**
 * Attributes that identify a person, a machine or a command line rather
 * than describe a request: the client's IP address and port, the raw
 * user-agent string, the host's id and addresses, and the process's
 * command line and owner. OpenTelemetry adds them by default (sdk-node's
 * process and host resource detectors, HttpInstrumentation on every server
 * span, the Python process detector, framework instrumentations), and
 * redaction keeps them because none of them looks like a secret.
 *
 * Nothing in Autter reads them, so they are dropped by default: by
 * @autter/runtime-node's exporters (span, span event and link attributes,
 * and the resource), by adapters/python (`redact.py`) and by the ingester
 * on arrival (spans, logs and resources, whatever sent them). The same list
 * is mirrored there; parity is checked by test-vectors/redaction.json
 * (`identifying`).
 *
 * Kept on purpose: `service.instance.id` (a random id the ingester needs to
 * tell processes apart), `host.name` (container and pod names; on a laptop
 * or a VM it is the machine's name, so drop it with `dropAttributes` if
 * that matters to you), `process.pid`, `process.runtime.*`,
 * `process.executable.name`, `os.type`, `host.arch`, the server's own
 * address and port (`server.address`, `net.host.name`), and the coarse
 * `user_agent.browser` / `.os` / `.device` / `.bot` fields the request
 * enricher derives.
 *
 * Opt back in with `keepIdentifyingAttributes: true` (all of them) or a list
 * of keys, or `AUTTER_KEEP_IDENTIFYING_ATTRIBUTES` (`true`, or a
 * comma-separated list). The ingester drops them too unless it is given the
 * same setting. Drop more keys (`host.name`, say) with `dropAttributes` /
 * `AUTTER_DROP_ATTRIBUTES`.
 */
export const IDENTIFYING_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
	// The client's address (and, on outgoing calls, the peer's), in the old,
	// 1.2x and stable semantic conventions; the server's own IP address.
	"net.peer.ip",
	"net.peer.port",
	"net.sock.peer.addr",
	"net.sock.peer.port",
	"net.host.ip",
	"net.sock.host.addr",
	"network.local.address",
	"http.client_ip",
	"client.address",
	"client.port",
	"network.peer.address",
	"network.peer.port",
	// The raw user-agent string.
	"http.user_agent",
	"user_agent.original",
	// The machine (its id and addresses; host.name is kept, see above).
	"host.id",
	"host.mac",
	"host.ip",
	// The command line and the user running it.
	"process.command_args",
	"process.command",
	"process.command_line",
	"process.owner",
	"process.executable.path",
]);

/** `true` keeps every identifying attribute; a list keeps those keys only. */
export type KeepIdentifyingAttributes = boolean | readonly string[];

/** Environment variable read by the SDKs (and the ingester) when the option is not given. */
export const KEEP_IDENTIFYING_ATTRIBUTES_ENV = "AUTTER_KEEP_IDENTIFYING_ATTRIBUTES";
/** Extra keys to drop (comma-separated), when `dropAttributes` is not given. */
export const DROP_ATTRIBUTES_ENV = "AUTTER_DROP_ATTRIBUTES";

/** Parse `AUTTER_DROP_ATTRIBUTES`: a comma-separated list of keys. */
export function dropAttributesFromEnv(raw: string | undefined | null): string[] | undefined {
	if (typeof raw !== "string") return undefined;
	const keys = raw.split(",").map((key) => key.trim()).filter(Boolean);
	return keys.length ? keys : undefined;
}

/**
 * Parse `AUTTER_KEEP_IDENTIFYING_ATTRIBUTES`: `true` / `1` / `yes` / `on` /
 * `all` keep all of them, `false` / `0` / `no` / `off` / `none` keep none,
 * anything else is a comma-separated list of keys. Unset or blank:
 * `undefined` (the default, drop them all).
 */
export function keepIdentifyingFromEnv(raw: string | undefined | null): KeepIdentifyingAttributes | undefined {
	if (typeof raw !== "string") return undefined;
	const value = raw.trim();
	if (!value) return undefined;
	if (/^(?:1|true|yes|on|all)$/i.test(value)) return true;
	if (/^(?:0|false|no|off|none)$/i.test(value)) return false;
	return value.split(",").map((key) => key.trim()).filter(Boolean);
}

export interface IdentifyingAttributeFilter {
	/** The keys this filter removes (the list minus what is kept, plus the extra keys). */
	readonly dropped: ReadonlySet<string>;
	/**
	 * `attributes` without the dropped keys: the same object when none of
	 * them is present (or nothing is dropped), a copy otherwise. Never
	 * mutates its input.
	 */
	apply<T extends object>(attributes: T): T;
}

/**
 * Build the filter once per process; `keep` as for
 * `keepIdentifyingAttributes`, `extra` as for `dropAttributes` (exact keys
 * dropped as well; a key both kept and listed in `extra` is dropped).
 */
export function makeIdentifyingAttributeFilter(
	keep?: KeepIdentifyingAttributes | null,
	extra?: readonly string[] | null,
): IdentifyingAttributeFilter {
	const kept = keep === true
		? new Set(IDENTIFYING_ATTRIBUTE_KEYS)
		: new Set(Array.isArray(keep) ? keep.filter((key): key is string => typeof key === "string") : []);
	const dropped: ReadonlySet<string> = new Set([
		...IDENTIFYING_ATTRIBUTE_KEYS.filter((key) => !kept.has(key)),
		...(Array.isArray(extra) ? extra.filter((key): key is string => typeof key === "string" && key !== "") : []),
	]);
	return {
		dropped,
		apply<T extends object>(attributes: T): T {
			if (!dropped.size || !attributes || typeof attributes !== "object") return attributes;
			let hit = false;
			for (const key of Object.keys(attributes)) {
				if (dropped.has(key)) {
					hit = true;
					break;
				}
			}
			if (!hit) return attributes;
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(attributes)) {
				if (!dropped.has(key)) out[key] = (attributes as Record<string, unknown>)[key];
			}
			return out as T;
		},
	};
}
