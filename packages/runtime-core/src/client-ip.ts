/**
 * Hashed client IP (opt-in): the client's address is dropped with the other
 * identifying attributes (identifying.ts), and with `hashClientIp` one
 * attribute, `client.address_hash`, carries a keyed hash of it so distinct
 * clients can still be counted.
 *
 * The hash is HMAC-SHA256(salt, normalized IP), hex, first 32 characters
 * (128 bits). Never a plain hash: the IPv4 space is small enough to hash in
 * full, so without a secret salt any hash could be reversed. The salt is a
 * secret of the project: it is never logged, exported or written to an
 * attribute. Without one (or with one shorter than CLIENT_IP_SALT_MIN_LENGTH)
 * nothing is hashed. The same function, normalisation and source order run
 * in @autter/runtime-node, adapters/python and the ingester; parity is
 * checked by test-vectors/redaction.json (`clientIpHash`).
 *
 * This module holds the parts that need no crypto (runtime-core runs on
 * edge runtimes without node:crypto): which attribute to hash and how to
 * normalise it.
 */

/** The attribute carrying the hash. */
export const CLIENT_IP_HASH_ATTRIBUTE = "client.address_hash";
/** Hex characters kept from the HMAC-SHA256 digest (128 bits). */
export const CLIENT_IP_HASH_LENGTH = 32;
/** Shorter salts are refused (nothing is hashed). */
export const CLIENT_IP_SALT_MIN_LENGTH = 16;
/** `true` turns hashing on (the SDKs and the ingester). */
export const HASH_CLIENT_IP_ENV = "AUTTER_HASH_CLIENT_IP";
/** The secret salt (the SDKs and the ingester). */
export const CLIENT_IP_SALT_ENV = "AUTTER_CLIENT_IP_SALT";

/**
 * Where the client address is read from, first present and valid wins:
 * `client.address` (stable semconv; behind a proxy the instrumentation fills
 * it from `Forwarded` / `X-Forwarded-For`), `http.client_ip` (old semconv,
 * from `X-Forwarded-For`), then the socket peer (`net.peer.ip`,
 * `network.peer.address`, `net.sock.peer.addr`), which behind a proxy is
 * the proxy. The peer keys are read on server spans only: on a client span
 * the peer is the server being called.
 */
export const CLIENT_IP_SOURCE_KEYS: readonly string[] = Object.freeze([
	"client.address",
	"http.client_ip",
	"net.peer.ip",
	"network.peer.address",
	"net.sock.peer.addr",
]);
/** The source keys read on any span or log record (not only server spans). */
export const CLIENT_IP_CLIENT_KEYS: readonly string[] = Object.freeze(["client.address", "http.client_ip"]);

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const MAPPED_V4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * The canonical text of an IP address, or null when `raw` is not one: the
 * first entry of a comma-separated list (`X-Forwarded-For`), port and
 * brackets removed (`1.2.3.4:5678`, `[2001:db8::1]:443`), zone id removed
 * (`fe80::1%eth0`), IPv6 lower-cased and compressed (RFC 5952), and
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) turned into IPv4.
 */
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
		const host = new URL(`http://[${value}]/`).hostname;
		canonical = host.slice(1, -1);
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

/**
 * The normalised client address of a span or log record, or null: the
 * first CLIENT_IP_SOURCE_KEYS entry holding a valid IP, the peer keys only
 * when `serverSpan`.
 */
export function clientIpOf(attributes: Record<string, unknown>, serverSpan: boolean): string | null {
	for (const key of serverSpan ? CLIENT_IP_SOURCE_KEYS : CLIENT_IP_CLIENT_KEYS) {
		const ip = normalizeClientIp(attributes[key]);
		if (ip) return ip;
	}
	return null;
}

/** A usable salt: a string of at least CLIENT_IP_SALT_MIN_LENGTH characters, else null. */
export function usableClientIpSalt(salt: unknown): string | null {
	return typeof salt === "string" && salt.length >= CLIENT_IP_SALT_MIN_LENGTH ? salt : null;
}

/** `true` / `1` / `yes` / `on` (AUTTER_HASH_CLIENT_IP). */
export function envFlag(raw: string | undefined | null): boolean {
	return typeof raw === "string" && /^(?:1|true|yes|on)$/i.test(raw.trim());
}
