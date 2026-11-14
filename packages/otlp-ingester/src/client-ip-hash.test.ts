// Opt-in hashed client IP at the ingester (AUTTER_HASH_CLIENT_IP with
// AUTTER_CLIENT_IP_SALT): plain OpenTelemetry senders get the same
// `client.address_hash` the SDKs compute, a hash already sent is kept, and
// the raw address is dropped either way. Shared vectors:
// test-vectors/redaction.json (`clientIpHash`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
import {
	CLIENT_IP_HASH_ATTRIBUTE,
	CLIENT_IP_HASH_LENGTH,
	CLIENT_IP_SOURCE_KEYS,
	IDENTIFYING_ATTRIBUTE_KEYS,
	IdentifyingAttributeFilter,
	clientIpHasher,
	clientIpOfList,
	hashClientIp,
	identifyingKeysToDrop,
	normalizeClientIp,
} from "./identifying.js";
import { createIngesterApp } from "./server.js";

const ALL = JSON.parse(readFileSync(new URL("../../../test-vectors/redaction.json", import.meta.url), "utf8"));
const vectors = ALL.clientIpHash as {
	attribute: string; salt: string; length: number;
	normalize: Array<{ input: string; expect: string | null }>;
	hash: Array<{ input: string; expect: string }>;
	source: Array<{ attributes: Record<string, string>; server: boolean; expect: string | null }>;
};
const SALT = "project-secret-salt-7f3a9c2e41";
const kv = (attributes: Record<string, string>) =>
	Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } }));
const asMap = (list: unknown) =>
	Object.fromEntries((list as Array<{ key: string; value: { stringValue?: string } }>).map((e) => [e.key, e.value.stringValue]));

test("the shared vectors: constants, normalisation, source order and hash", () => {
	assert.equal(CLIENT_IP_HASH_ATTRIBUTE, vectors.attribute);
	assert.equal(CLIENT_IP_HASH_LENGTH, vectors.length);
	assert.ok(!IDENTIFYING_ATTRIBUTE_KEYS.includes(CLIENT_IP_HASH_ATTRIBUTE));
	for (const key of CLIENT_IP_SOURCE_KEYS) assert.ok(IDENTIFYING_ATTRIBUTE_KEYS.includes(key), key);
	for (const { input, expect } of vectors.normalize) assert.equal(normalizeClientIp(input), expect, input);
	for (const { attributes, server, expect } of vectors.source) assert.equal(clientIpOfList(kv(attributes), server), expect);
	for (const { input, expect } of vectors.hash) assert.equal(hashClientIp(vectors.salt, normalizeClientIp(input)!), expect, input);
});

test("no hasher without a salt of 16 characters, or when off", () => {
	assert.equal(clientIpHasher(true, undefined), null);
	assert.equal(clientIpHasher(true, "short"), null);
	assert.equal(clientIpHasher(false, SALT), null);
	assert.equal(clientIpHasher(true, SALT)!("203.0.113.9"), hashClientIp(SALT, "203.0.113.9"));
});

test("traces and logs: hash added from the raw address, kept when already sent, peer only on server spans", () => {
	const filter = new IdentifyingAttributeFilter(identifyingKeysToDrop(), clientIpHasher(true, SALT));
	const traces = filter.traces({
		resourceSpans: [{ scopeSpans: [{ spans: [
			{ name: "server", kind: "SPAN_KIND_SERVER", attributes: kv({ "net.peer.ip": "10.0.0.2", "http.client_ip": "203.0.113.9", "http.route": "/x" }) },
			{ name: "server-peer", kind: 2, attributes: kv({ "network.peer.address": "[2001:DB8::1]:443" }) },
			{ name: "client", kind: 3, attributes: kv({ "net.peer.ip": "10.0.0.9" }) },
			{ name: "hashed", kind: 2, attributes: kv({ "client.address": "198.51.100.8", [CLIENT_IP_HASH_ATTRIBUTE]: "abc123" }) },
		] }] }],
	});
	const spans = traces.resourceSpans[0]!.scopeSpans[0]!.spans.map((span) => asMap(span.attributes));
	assert.deepEqual(spans[0], { "http.route": "/x", [CLIENT_IP_HASH_ATTRIBUTE]: hashClientIp(SALT, "203.0.113.9") });
	assert.deepEqual(spans[1], { [CLIENT_IP_HASH_ATTRIBUTE]: hashClientIp(SALT, "2001:db8::1") });
	assert.deepEqual(spans[2], {});
	assert.deepEqual(spans[3], { [CLIENT_IP_HASH_ATTRIBUTE]: "abc123" }, "an existing hash is never hashed again");

	const logs = filter.logs({ resourceLogs: [{ scopeLogs: [{ logRecords: [
		{ attributes: kv({ "client.address": "::ffff:203.0.113.9", message: "m" }) },
		{ attributes: kv({ "net.peer.ip": "203.0.113.9" }) },
	] }] }] });
	const records = logs.resourceLogs[0]!.scopeLogs[0]!.logRecords.map((record) => asMap(record.attributes));
	assert.deepEqual(records[0], { message: "m", [CLIENT_IP_HASH_ATTRIBUTE]: hashClientIp(SALT, "203.0.113.9") });
	assert.deepEqual(records[1], {});
});

// Through the ingester, against a fake ClickHouse: a real Python Flask
// export (protobuf; its server span's address is net.peer.ip 127.0.0.1).

const listen = async (server: Server) => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) =>
	new Promise<void>((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});

async function storedSpans(extra: Partial<IngesterConfig>): Promise<Array<Record<string, unknown>>> {
	const rows: Array<Record<string, unknown>> = [];
	const ch = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const query = new URL(req.url!, "http://localhost").searchParams.get("query") ?? "";
			if (query.includes("INSERT INTO") && query.includes("runtime_spans"))
				rows.push(...body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
			res.end();
		});
	});
	const chUrl = await listen(ch);
	const app = createIngesterApp({
		port: 0, clickhouseUrl: chUrl, clickhouseUser: "default", clickhousePassword: "", clickhouseDatabase: "autter_runtime",
		ingestKeys: [{ key: "server", orgId: "org", repositoryId: "repo" }],
		keyValidatorUrl: null, keyValidatorToken: null, sinkUrl: null, sinkToken: null, sinkMaxAttempts: 1,
		sinkMaxBufferedBatches: 10, sinkMaxBufferedMb: 2, maxBodyBytes: 1024 * 1024, rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120, occurrenceTtlDays: 14, spanTtlDays: 7, metricsTtlDays: 90, llmCallTtlDays: 90,
		logTtlDays: 14, ...extra,
	}).app.listen();
	const url = await new Promise<string>((resolve) =>
		app.once("listening", () => resolve(`http://127.0.0.1:${(app.address() as AddressInfo).port}`)),
	);
	try {
		const response = await fetch(`${url}/v1/traces`, {
			method: "POST",
			headers: { "content-type": "application/x-protobuf", authorization: "Bearer server" },
			body: readFileSync(new URL("../test-fixtures/python/flask-unhandled.otlp.pb", import.meta.url)),
		});
		assert.equal(response.status, 200);
	} finally {
		await close(app);
		await close(ch);
	}
	return rows.map((row) => JSON.parse(String(row.attributes)));
}

test("a plain OpenTelemetry sender gets client.address_hash when the ingester hashes, and none otherwise", async () => {
	const hashed = await storedSpans({ hashClientIp: true, clientIpSalt: SALT });
	const server = hashed.find((attributes) => attributes["http.route"]);
	assert.ok(server, "server span stored");
	assert.equal(server[CLIENT_IP_HASH_ATTRIBUTE], hashClientIp(SALT, "127.0.0.1"));
	assert.equal(server["net.peer.ip"], undefined);
	assert.ok(!JSON.stringify(hashed).includes(SALT), "salt stored");

	for (const config of [{}, { hashClientIp: true }, { hashClientIp: true, clientIpSalt: "short" }]) {
		const plain = await storedSpans(config);
		assert.ok(plain.length);
		for (const attributes of plain) {
			assert.equal(attributes[CLIENT_IP_HASH_ATTRIBUTE], undefined, JSON.stringify(config));
			assert.equal(attributes["net.peer.ip"], undefined);
		}
	}
});
