// Opt-in hashed client IP: with hashClientIp the client's address leaves
// the process only as `client.address_hash`, HMAC-SHA256 under the
// project's secret salt, the same value the Python adapter and the ingester
// compute (test-vectors/redaction.json, `clientIpHash`). Off by default;
// on without a salt it hashes nothing and warns once.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashClientIp } from "../dist/index.js";
import { normalizeClientIp } from "../../runtime-core/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(here, "../../../test-vectors/redaction.json"), "utf8"));
const vectors = VECTORS.clientIpHash;
const DROP = VECTORS.identifying.drop;
const SALT = "project-secret-salt-7f3a9c2e41";

test("hashClientIp matches the shared vectors (normalised first)", () => {
	for (const { input, expect } of vectors.hash) assert.equal(hashClientIp(vectors.salt, normalizeClientIp(input)), expect, input);
	assert.equal(hashClientIp(vectors.salt, "203.0.113.9").length, vectors.length);
	assert.notEqual(hashClientIp(`${vectors.salt}x`, "203.0.113.9"), hashClientIp(vectors.salt, "203.0.113.9"));
});

const received = [];
let collector;
let endpoint;

before(async () => {
	collector = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			try {
				received.push({ path: req.url, text, body: JSON.parse(text) });
			} catch {
				/* not JSON */
			}
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	endpoint = `http://127.0.0.1:${collector.address().port}`;
});

after(async () => {
	await new Promise((resolve) => {
		collector.close(resolve);
		collector.closeAllConnections();
	});
});

const until = async (check, ms = 5000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
	return check();
};
const value = (v) => v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue;
const attrs = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, value(a.value)]));

function spansOf(service) {
	const out = [];
	for (const { body } of received)
		for (const rs of body.resourceSpans ?? []) {
			if (attrs(rs.resource?.attributes)["service.name"] !== service) continue;
			for (const ss of rs.scopeSpans ?? [])
				for (const span of ss.spans ?? []) out.push({ name: span.name, kind: span.kind, attributes: attrs(span.attributes) });
		}
	return out;
}

/** One request through HttpInstrumentation (X-Forwarded-For: 203.0.113.9,
 * socket peer 127.0.0.1) and its client span; a manual span with
 * client.address; a manual span already carrying a hash. */
async function run(service, options = {}, env = {}) {
	const script = `
		import { createRequire } from "node:module";
		import { trace } from "@opentelemetry/api";
		import { initAutterServer } from "./dist/index.js";
		const sdk = initAutterServer({
			apiKey: "k", service: process.env.SERVICE, endpoint: process.env.ENDPOINT, traceSampleRate: 1,
			captureGlobalErrors: false, autoFlush: false, memoryMetrics: false, compatCheck: false,
			metricIntervalMs: 3_600_000, logging: { console: false },
			...JSON.parse(process.env.OPTIONS),
		});
		const http = createRequire(import.meta.url)("http");
		const server = http.createServer((req, res) => res.end("ok"));
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		await new Promise((resolve, reject) => {
			http.get({ host: "127.0.0.1", port: server.address().port, path: "/hello",
				headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
		});
		await new Promise((resolve) => server.close(resolve));
		const tracer = trace.getTracer("t");
		tracer.startSpan("manual", { attributes: { "client.address": "::ffff:198.51.100.7" } }).end();
		tracer.startSpan("prehashed", { attributes: { "client.address": "198.51.100.8", "client.address_hash": "set-upstream" } }).end();
		await sdk.shutdown();
	`;
	const childEnv = { ...process.env, ENDPOINT: endpoint, SERVICE: service, OPTIONS: JSON.stringify(options), ...env };
	for (const name of ["AUTTER_HASH_CLIENT_IP", "AUTTER_CLIENT_IP_SALT", "AUTTER_KEEP_IDENTIFYING_ATTRIBUTES", "AUTTER_DROP_ATTRIBUTES"])
		if (!(name in env)) delete childEnv[name];
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: join(here, ".."),
		env: childEnv,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 0, stderr);
	await until(() => spansOf(service).some((span) => span.name === "prehashed"));
	const spans = spansOf(service);
	const server = spans.find((span) => span.kind === 2);
	assert.ok(server, "HTTP server span exported");
	return {
		spans,
		server,
		client: spans.find((span) => span.kind === 3),
		manual: spans.find((span) => span.name === "manual"),
		prehashed: spans.find((span) => span.name === "prehashed"),
		stderr,
	};
}

function assertNoRawAddress(out) {
	for (const span of out.spans) for (const key of DROP) assert.ok(!(key in span.attributes), `${key} on ${span.name}`);
}

test("off by default: the address is dropped and no hash is added", async () => {
	const out = await run("ip-hash-off");
	assertNoRawAddress(out);
	assert.equal(out.server.attributes["client.address_hash"], undefined);
	assert.equal(out.manual.attributes["client.address_hash"], undefined);
	assert.equal(out.prehashed.attributes["client.address_hash"], "set-upstream");
});

test("hashClientIp: { salt } adds client.address_hash from the forwarded client address", async () => {
	const out = await run("ip-hash-option", { hashClientIp: { salt: SALT } });
	assertNoRawAddress(out);
	// X-Forwarded-For's first entry (http.client_ip) wins over the socket peer.
	assert.equal(out.server.attributes["client.address_hash"], hashClientIp(SALT, "203.0.113.9"));
	// IPv4-mapped IPv6 is hashed as the IPv4 address.
	assert.equal(out.manual.attributes["client.address_hash"], hashClientIp(SALT, "198.51.100.7"));
	// An existing hash is left alone, never hashed again.
	assert.equal(out.prehashed.attributes["client.address_hash"], "set-upstream");
	// On a client span the peer is the server being called: no hash.
	assert.ok(out.client, "HTTP client span exported");
	assert.equal(out.client.attributes["client.address_hash"], undefined);
	// The salt is never exported or printed.
	for (const { text } of received) assert.ok(!text.includes(SALT), "salt on the wire");
	assert.ok(!out.stderr.includes(SALT), "salt printed");
});

test("AUTTER_HASH_CLIENT_IP + AUTTER_CLIENT_IP_SALT, also with redactAttributes: false", async () => {
	const out = await run("ip-hash-env", { redactAttributes: false }, { AUTTER_HASH_CLIENT_IP: "true", AUTTER_CLIENT_IP_SALT: SALT });
	assertNoRawAddress(out);
	assert.equal(out.server.attributes["client.address_hash"], hashClientIp(SALT, "203.0.113.9"));
	assert.equal(out.manual.attributes["client.address_hash"], hashClientIp(SALT, "198.51.100.7"));
});

test("on without a usable salt: nothing is hashed (never unsalted) and one warning is printed", async () => {
	const out = await run("ip-hash-no-salt", { hashClientIp: true }, { AUTTER_CLIENT_IP_SALT: "short" });
	assertNoRawAddress(out);
	for (const span of out.spans) if (span.name !== "prehashed") assert.equal(span.attributes["client.address_hash"], undefined, span.name);
	assert.equal(out.stderr.match(/hashClientIp is on but no salt/g)?.length, 1, out.stderr);
	assert.ok(!out.stderr.includes("short"), "salt printed");
});
