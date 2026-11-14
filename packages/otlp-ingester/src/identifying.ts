/**
 * Identifying attributes, dropped on arrival: the client's IP address and
 * port, the raw user-agent string, the host's id and addresses, and the
 * process's command line and owner. OpenTelemetry SDKs add them by default
 * (resource detectors, HTTP server instrumentations) and nothing in Autter
 * reads them. The SDKs drop them before export (@autter/runtime-node,
 * adapters/python); the ingester drops them again so plain
 * OpenTelemetry senders, other languages and older SDK versions are covered.
 *
 * Dropped from span, span event and span link attributes, log record
 * attributes (and the keys of a structured log body), and the resource of
 * traces, logs and metrics, before anything is stored or forwarded.
 *
 * Same list as runtime-core's identifying.ts and adapters/python/redact.py;
 * parity is checked by test-vectors/redaction.json (`identifying`).
 * `service.instance.id`, `host.name`, `process.pid`, `process.runtime.*`,
 * `os.type` and `host.arch` are kept.
 *
 * Self-hosters opt back in with AUTTER_KEEP_IDENTIFYING_ATTRIBUTES (`true`,
 * or a comma-separated list of keys) and drop more keys with
 * AUTTER_DROP_ATTRIBUTES (a comma-separated list, `host.name` say). An SDK
 * that keeps an attribute gets it stored only when the ingester keeps it too.
 */
export const IDENTIFYING_ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
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
	"http.user_agent",
	"user_agent.original",
	"host.id",
	"host.mac",
	"host.ip",
	"process.command_args",
	"process.command",
	"process.command_line",
	"process.owner",
	"process.executable.path",
]);

export type KeepIdentifyingAttributes = boolean | string[];

/** AUTTER_KEEP_IDENTIFYING_ATTRIBUTES: `true`/`1`/`yes`/`on`/`all`, `false`/`0`/`no`/`off`/`none`, or a comma-separated list. */
export function keepIdentifyingEnv(raw: string | undefined): KeepIdentifyingAttributes | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	const value = raw.trim();
	if (/^(?:1|true|yes|on|all)$/i.test(value)) return true;
	if (/^(?:0|false|no|off|none)$/i.test(value)) return false;
	return value.split(",").map((key) => key.trim()).filter(Boolean);
}

/** AUTTER_DROP_ATTRIBUTES: a comma-separated list of keys. */
export function dropAttributesEnv(raw: string | undefined): string[] | undefined {
	if (typeof raw !== "string") return undefined;
	const keys = raw.split(",").map((key) => key.trim()).filter(Boolean);
	return keys.length ? keys : undefined;
}

/** The keys to drop: the list minus `keep`, plus `extra` (a key both kept and extra is dropped). */
export function identifyingKeysToDrop(
	keep?: KeepIdentifyingAttributes | null,
	extra?: readonly string[] | null,
): ReadonlySet<string> {
	const kept = keep === true
		? new Set(IDENTIFYING_ATTRIBUTE_KEYS)
		: new Set(Array.isArray(keep) ? keep.filter((key) => typeof key === "string") : []);
	return new Set([
		...IDENTIFYING_ATTRIBUTE_KEYS.filter((key) => !kept.has(key)),
		...(Array.isArray(extra) ? extra.filter((key) => typeof key === "string" && key !== "") : []),
	]);
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** `list` with `fn` applied to each item; the same array when nothing changed. */
function mapSame<T>(list: T[], fn: (item: T) => T): T[] {
	let out: T[] | null = null;
	for (let i = 0; i < list.length; i++) {
		const next = fn(list[i]!);
		if (next !== list[i] && !out) out = list.slice(0, i);
		if (out) out.push(next);
	}
	return out ?? list;
}

/** `obj` with `field` replaced by `fn(obj[field])`; the same object when it did not change. */
function withField(obj: unknown, field: string, fn: (value: unknown) => unknown): unknown {
	if (!isObject(obj)) return obj;
	const value = obj[field];
	const next = fn(value);
	return next === value ? obj : { ...obj, [field]: next };
}

/** Each item of the array under `field` through `fn` (anything not an array is left for the normaliser to refuse). */
function eachIn(obj: unknown, field: string, fn: (item: unknown) => unknown): unknown {
	return withField(obj, field, (list) => (Array.isArray(list) ? mapSame(list as unknown[], fn) : list));
}

export class IdentifyingAttributeFilter {
	constructor(readonly dropped: ReadonlySet<string> = identifyingKeysToDrop()) {}

	/** An OTLP key/value list without the dropped keys; the same array when none is present. */
	list = (attributes: unknown): unknown => {
		if (!Array.isArray(attributes) || !this.dropped.size) return attributes;
		const dropped = (entry: unknown) =>
			isObject(entry) && typeof entry.key === "string" && this.dropped.has(entry.key);
		if (!attributes.some(dropped)) return attributes;
		return attributes.filter((entry) => !dropped(entry));
	};

	private attributesOf = (obj: unknown): unknown => withField(obj, "attributes", this.list);

	private resourceOf = (container: unknown): unknown => withField(container, "resource", this.attributesOf);

	/** A traces request without identifying attributes (resource, spans, events, links). */
	traces<T>(request: T): T {
		if (!this.dropped.size) return request;
		const span = (item: unknown) =>
			eachIn(eachIn(this.attributesOf(item), "events", this.attributesOf), "links", this.attributesOf);
		return eachIn(request, "resourceSpans", (rs) =>
			eachIn(this.resourceOf(rs), "scopeSpans", (ss) => eachIn(ss, "spans", span)),
		) as T;
	}

	/** A logs request without identifying attributes (resource, record attributes, the keys of a structured body). */
	logs<T>(request: T): T {
		if (!this.dropped.size) return request;
		const body = (value: unknown) =>
			withField(value, "kvlistValue", (kv) => withField(kv, "values", this.list));
		const record = (item: unknown) => withField(this.attributesOf(item), "body", body);
		return eachIn(request, "resourceLogs", (rl) =>
			eachIn(this.resourceOf(rl), "scopeLogs", (sl) => eachIn(sl, "logRecords", record)),
		) as T;
	}

	/** A metrics request without identifying resource attributes (data points are left alone). */
	metrics<T>(request: T): T {
		if (!this.dropped.size) return request;
		return eachIn(request, "resourceMetrics", this.resourceOf) as T;
	}
}
