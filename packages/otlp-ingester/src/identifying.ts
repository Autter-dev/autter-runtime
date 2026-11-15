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
 *
 * Opt-in hashed client IP (AUTTER_HASH_CLIENT_IP=true with
 * AUTTER_CLIENT_IP_SALT): a span or log record that names a client address
 * and carries no `client.address_hash` yet gets one, HMAC-SHA256 of the
 * normalised address under the salt (32 hex characters), the same value the
 * SDKs compute from the same salt (test-vectors/redaction.json,
 * `clientIpHash`). A hash already sent is kept as it is, never hashed again.
 * The raw address is dropped either way.
 */
import { createHmac } from "node:crypto";
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
	constructor(
		readonly dropped: ReadonlySet<string> = identifyingKeysToDrop(),
		private readonly hasher: ClientIpHasher | null = null,
	) {}

	/**
	 * The attributes of a span or log record: what is read from the raw list
	 * added first (the client IP hash; on a SERVER span, the test-client
	 * marker, a hint only), then the drop.
	 */
	private recordAttributes = (obj: unknown, serverSpan: boolean): unknown => {
		if (!isObject(obj)) return this.attributesOf(obj);
		const added: Json[] = [];
		const hasher = this.hasher;
		if (hasher && !hasKey(obj.attributes, CLIENT_IP_HASH_ATTRIBUTE)) {
			const ip = clientIpOfList(obj.attributes, serverSpan);
			if (ip) added.push({ key: CLIENT_IP_HASH_ATTRIBUTE, value: { stringValue: hasher(ip) } });
		}
		if (serverSpan && testClientUserAgentIn(obj.attributes) && !hasKey(obj.attributes, TEST_CLIENT_ATTRIBUTE)) {
			added.push({ key: TEST_CLIENT_ATTRIBUTE, value: { boolValue: true } });
		}
		const filtered = this.attributesOf(obj);
		if (!added.length || !isObject(filtered) || !Array.isArray(filtered.attributes)) return filtered;
		return { ...filtered, attributes: [...filtered.attributes, ...added] };
	};

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
		if (!this.dropped.size && !this.hasher) return request;
		const span = (item: unknown) =>
			eachIn(
				eachIn(this.recordAttributes(item, isObject(item) && isServerKind(item.kind)), "events", this.attributesOf),
				"links",
				this.attributesOf,
			);
		return eachIn(request, "resourceSpans", (rs) =>
			eachIn(this.resourceOf(rs), "scopeSpans", (ss) => eachIn(ss, "spans", span)),
		) as T;
	}

	/** A logs request without identifying attributes (resource, record attributes, the keys of a structured body). */
	logs<T>(request: T): T {
		if (!this.dropped.size && !this.hasher) return request;
		const body = (value: unknown) =>
			withField(value, "kvlistValue", (kv) => withField(kv, "values", this.list));
		const record = (item: unknown) => withField(this.recordAttributes(item, false), "body", body);
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

// ---------------------------------------------------------------------------
// Hashed client IP

export const CLIENT_IP_HASH_ATTRIBUTE = "client.address_hash";
export const CLIENT_IP_HASH_LENGTH = 32;
export const CLIENT_IP_SALT_MIN_LENGTH = 16;
/** First valid wins; the peer keys only on server spans (on a client span the peer is the server called). */
export const CLIENT_IP_SOURCE_KEYS: readonly string[] = ["client.address", "http.client_ip", "net.peer.ip", "network.peer.address", "net.sock.peer.addr"];
const CLIENT_IP_CLIENT_KEYS: readonly string[] = ["client.address", "http.client_ip"];

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const MAPPED_V4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/** Canonical IP text or null (same rules as runtime-core normalizeClientIp and redact.py). */
export function normalizeClientIp(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	let value = raw.split(",")[0]!.trim();
	if (!value || value.length > 100) return null;
	const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
	if (bracketed) value = bracketed[1]!;
	else if (/^[\d.]+:\d{1,5}$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
	const zone = value.indexOf("%");
	if (zone >= 0) value = value.slice(0, zone);
	value = value.toLowerCase();
	if (IPV4.test(value)) return value;
	if (!value.includes(":") || !/^[0-9a-f:.]+$/.test(value)) return null;
	let canonical: string;
	try {
		canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
	} catch {
		return null;
	}
	const mapped = MAPPED_V4.exec(canonical);
	if (mapped) {
		const high = Number.parseInt(mapped[1]!, 16);
		const low = Number.parseInt(mapped[2]!, 16);
		return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
	}
	return canonical;
}

/** HMAC-SHA256(salt, ip), hex, first CLIENT_IP_HASH_LENGTH characters. */
export function hashClientIp(salt: string, ip: string): string {
	return createHmac("sha256", salt).update(ip).digest("hex").slice(0, CLIENT_IP_HASH_LENGTH);
}

export type ClientIpHasher = (ip: string) => string;

/**
 * The hasher for AUTTER_HASH_CLIENT_IP / AUTTER_CLIENT_IP_SALT, or null:
 * off, or on without a salt of CLIENT_IP_SALT_MIN_LENGTH characters (never
 * an unsalted hash; index.ts warns at startup). The salt stays in the
 * closure.
 */
export function clientIpHasher(enabled: boolean | undefined, salt: string | null | undefined): ClientIpHasher | null {
	if (!enabled || typeof salt !== "string" || salt.length < CLIENT_IP_SALT_MIN_LENGTH) return null;
	return (ip) => hashClientIp(salt, ip);
}

/** The string value of `key` in an OTLP key/value list. */
function stringAttribute(list: unknown, key: string): string | undefined {
	if (!Array.isArray(list)) return undefined;
	for (const entry of list) {
		if (isObject(entry) && entry.key === key && isObject(entry.value) && typeof entry.value.stringValue === "string")
			return entry.value.stringValue;
	}
	return undefined;
}

const hasKey = (list: unknown, key: string) =>
	Array.isArray(list) && list.some((entry) => isObject(entry) && entry.key === key);

/** The normalised client address in an OTLP attribute list (peer keys only on server spans). */
export function clientIpOfList(list: unknown, serverSpan: boolean): string | null {
	for (const key of serverSpan ? CLIENT_IP_SOURCE_KEYS : CLIENT_IP_CLIENT_KEYS) {
		const ip = normalizeClientIp(stringAttribute(list, key));
		if (ip) return ip;
	}
	return null;
}

/** OTLP SERVER span kind, as a number or the enum name. */
export const isServerKind = (kind: unknown) => kind === 2 || kind === "SPAN_KIND_SERVER";

// ---------------------------------------------------------------------------
// Test-client marker (a hint, never trusted)

/**
 * On a SERVER span whose raw user agent is exactly `testclient` (what
 * Starlette's and FastAPI's in-process TestClient sends): added before the
 * user agent is dropped, so the stored span still says so. A hint only: the
 * user agent is whatever the caller sent, so anyone can produce it, and
 * nothing in the ingester acts on it. The environment is never changed
 * because of it: test runs set `deployment.environment=test` themselves.
 * Not added when nothing is dropped (AUTTER_KEEP_IDENTIFYING_ATTRIBUTES=true
 * and no client IP hash): the request passes through with its user agent.
 */
export const TEST_CLIENT_ATTRIBUTE = "autter.test_client";
const TEST_CLIENT_USER_AGENT = "testclient";
const USER_AGENT_KEYS: readonly string[] = ["user_agent.original", "http.user_agent"];

/** The raw OTLP attribute list names the test client's user agent, exactly. */
function testClientUserAgentIn(list: unknown): boolean {
	return USER_AGENT_KEYS.some((key) => stringAttribute(list, key) === TEST_CLIENT_USER_AGENT);
}
