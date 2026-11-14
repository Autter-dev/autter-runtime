import { createHmac } from "node:crypto";
import {
	CLIENT_IP_HASH_LENGTH,
	CLIENT_IP_SALT_ENV,
	CLIENT_IP_SALT_MIN_LENGTH,
	HASH_CLIENT_IP_ENV,
	envFlag,
	usableClientIpSalt,
} from "@autter/runtime-core";

/** `hashClientIp`: `true` (salt from AUTTER_CLIENT_IP_SALT) or `{ salt }`. */
export type HashClientIpOption = boolean | { salt?: string };

/** Hashes one normalised IP address (runtime-core normalizeClientIp). */
export type ClientIpHasher = (ip: string) => string;

/** HMAC-SHA256(salt, ip), hex, first CLIENT_IP_HASH_LENGTH characters. */
export function hashClientIp(salt: string, ip: string): string {
	return createHmac("sha256", salt).update(ip).digest("hex").slice(0, CLIENT_IP_HASH_LENGTH);
}

/**
 * The hasher for `hashClientIp` (else AUTTER_HASH_CLIENT_IP), or null when
 * hashing is off. On without a usable salt (`{ salt }`, else
 * AUTTER_CLIENT_IP_SALT; at least CLIENT_IP_SALT_MIN_LENGTH characters) it is
 * off too, with one warning: never an unsalted hash. The salt stays in this
 * closure; it is never logged or exported.
 */
export function clientIpHasher(
	option: HashClientIpOption | undefined,
	env: Record<string, string | undefined> = process.env,
	warn: (message: string) => void = (message) => console.warn(`[autter-runtime] ${message}`),
): ClientIpHasher | null {
	const enabled = option === undefined ? envFlag(env[HASH_CLIENT_IP_ENV]) : option !== false;
	if (!enabled) return null;
	const salt = usableClientIpSalt(
		(typeof option === "object" && option !== null ? option.salt : undefined) ?? env[CLIENT_IP_SALT_ENV],
	);
	if (!salt) {
		warn(
			`hashClientIp is on but no salt of at least ${CLIENT_IP_SALT_MIN_LENGTH} characters is set ` +
				`(hashClientIp: { salt } or ${CLIENT_IP_SALT_ENV}): client IP addresses are dropped and not hashed.`,
		);
		return null;
	}
	return (ip) => hashClientIp(salt, ip);
}
