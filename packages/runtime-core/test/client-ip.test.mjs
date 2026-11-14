// Hashed client IP, the crypto-free half (runtime-core also runs on edge
// runtimes): which address of a span is hashed and its canonical form. The
// Python adapter and the ingester run the same vectors.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	CLIENT_IP_HASH_ATTRIBUTE,
	CLIENT_IP_HASH_LENGTH,
	CLIENT_IP_SALT_MIN_LENGTH,
	CLIENT_IP_SOURCE_KEYS,
	IDENTIFYING_ATTRIBUTE_KEYS,
	clientIpOf,
	envFlag,
	normalizeClientIp,
	usableClientIpSalt,
} from "../dist/index.js";

const vectors = JSON.parse(
	readFileSync(new URL("../../../test-vectors/redaction.json", import.meta.url), "utf8"),
).clientIpHash;

test("constants match the shared vectors", () => {
	assert.equal(CLIENT_IP_HASH_ATTRIBUTE, vectors.attribute);
	assert.equal(CLIENT_IP_HASH_LENGTH, vectors.length);
	// The hash is not an identifying attribute: it survives the drop.
	assert.ok(!IDENTIFYING_ATTRIBUTE_KEYS.includes(CLIENT_IP_HASH_ATTRIBUTE));
	// Every source is itself dropped.
	for (const key of CLIENT_IP_SOURCE_KEYS) assert.ok(IDENTIFYING_ATTRIBUTE_KEYS.includes(key), key);
});

test("normalizeClientIp: ports, brackets, zone ids, case, IPv4-mapped IPv6, lists", () => {
	for (const { input, expect } of vectors.normalize) assert.equal(normalizeClientIp(input), expect, JSON.stringify(input));
	assert.equal(normalizeClientIp(undefined), null);
	assert.equal(normalizeClientIp(42), null);
});

test("clientIpOf: client.address, then http.client_ip, then the peer on server spans only", () => {
	for (const { attributes, server, expect } of vectors.source)
		assert.equal(clientIpOf(attributes, server), expect, JSON.stringify({ attributes, server }));
});

test("salts shorter than the minimum are refused; env flag", () => {
	assert.equal(usableClientIpSalt("x".repeat(CLIENT_IP_SALT_MIN_LENGTH - 1)), null);
	assert.equal(usableClientIpSalt("x".repeat(CLIENT_IP_SALT_MIN_LENGTH)), "x".repeat(CLIENT_IP_SALT_MIN_LENGTH));
	assert.equal(usableClientIpSalt(undefined), null);
	for (const raw of ["true", "1", "YES", " on "]) assert.equal(envFlag(raw), true, raw);
	for (const raw of [undefined, "", "false", "0", "salt"]) assert.equal(envFlag(raw), false, String(raw));
});
