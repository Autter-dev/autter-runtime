// Identifying attributes are dropped on arrival, whoever sent them: plain
// OpenTelemetry SDKs in any language and older Autter SDKs. The list must
// match runtime-core's and the Python adapter's (test-vectors/redaction.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
import {
	dropAttributesEnv,
	IDENTIFYING_ATTRIBUTE_KEYS,
	IdentifyingAttributeFilter,
	identifyingKeysToDrop,
	keepIdentifyingEnv,
	clientIpHasher,
} from "./identifying.js";
import { createIngesterApp } from "./server.js";

const vectors = JSON.parse(
	readFileSync(new URL("../../../test-vectors/redaction.json", import.meta.url), "utf8"),
).identifying as { drop: string[]; keep: string[] };

const kv = (attributes: Record<string, string | number>) =>
	Object.entries(attributes).map(([key, value]) => ({
		key,
		value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
	}));
const keysOf = (list: unknown) => (list as Array<{ key: string }>).map((entry) => entry.key);
const everything = () => Object.fromEntries([...vectors.drop, ...vectors.keep].map((key) => [key, `v:${key}`]));

test("the list is exactly the shared vectors' drop list; host.name is kept", () => {
	assert.deepEqual([...IDENTIFYING_ATTRIBUTE_KEYS].sort(), [...vectors.drop].sort());
	for (const key of vectors.keep) assert.ok(!IDENTIFYING_ATTRIBUTE_KEYS.includes(key), key);
	assert.ok(!IDENTIFYING_ATTRIBUTE_KEYS.includes("host.name"));
	assert.ok(!IDENTIFYING_ATTRIBUTE_KEYS.includes("service.instance.id"));
});

test("traces: resource, span, event and link attributes lose the identifying keys", () => {
	const filter = new IdentifyingAttributeFilter();
	const request = {
		resourceSpans: [{
			resource: { attributes: kv(everything()) },
			scopeSpans: [{
				spans: [{
					name: "GET /",
					attributes: kv(everything()),
					events: [{ name: "e", attributes: kv({ "net.peer.ip": "1.2.3.4", note: "kept" }) }],
					links: [{ traceId: "a", spanId: "b", attributes: kv({ "client.address": "1.2.3.4", note: "kept" }) }],
				}],
			}],
		}],
	};
	const before = JSON.stringify(request);
	const out = filter.traces(request);
	assert.equal(JSON.stringify(request), before, "input not mutated");
	const rs = out.resourceSpans[0]!;
	assert.deepEqual(keysOf(rs.resource.attributes).sort(), [...vectors.keep].sort());
	const span = rs.scopeSpans[0]!.spans[0]!;
	assert.deepEqual(keysOf(span.attributes).sort(), [...vectors.keep].sort());
	assert.deepEqual(keysOf(span.events[0]!.attributes), ["note"]);
	assert.deepEqual(keysOf(span.links[0]!.attributes), ["note"]);
	assert.equal(span.name, "GET /");
});

test("logs: resource, record attributes and structured body keys; metrics: resource", () => {
	const filter = new IdentifyingAttributeFilter();
	const logs = filter.logs({
		resourceLogs: [{
			resource: { attributes: kv({ "service.instance.id": "i", "host.id": "m", "process.owner": "jane" }) },
			scopeLogs: [{
				logRecords: [{
					attributes: kv({ "user_agent.original": "curl/8", "http.route": "/x" }),
					body: { kvlistValue: { values: kv({ "client.address": "1.2.3.4", message: "hi" }) } },
				}],
			}],
		}],
	});
	assert.deepEqual(keysOf(logs.resourceLogs[0]!.resource.attributes), ["service.instance.id"]);
	const record = logs.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
	assert.deepEqual(keysOf(record.attributes), ["http.route"]);
	assert.deepEqual(keysOf(record.body.kvlistValue.values), ["message"]);

	const metrics = filter.metrics({
		resourceMetrics: [{ resource: { attributes: kv({ "service.instance.id": "i", "host.ip": "10.0.0.1", "host.name": "web-1" }) }, scopeMetrics: [] }],
	});
	assert.deepEqual(keysOf(metrics.resourceMetrics[0]!.resource.attributes), ["service.instance.id", "host.name"]);
});

test("requests without identifying keys, and malformed ones, come back untouched", () => {
	const filter = new IdentifyingAttributeFilter();
	const clean = { resourceSpans: [{ resource: { attributes: kv({ "service.name": "s" }) }, scopeSpans: [{ spans: [{ attributes: kv({ "http.route": "/" }) }] }] }] };
	assert.equal(filter.traces(clean), clean);
	for (const bad of [null, "x", { resourceSpans: "bad" }, { resourceSpans: [null, { scopeSpans: "bad" }] }, { resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: "x" }] }] }] }])
		assert.deepEqual(filter.traces(bad), bad);
	assert.deepEqual(filter.logs({ resourceLogs: "bad" }), { resourceLogs: "bad" });
	assert.deepEqual(filter.metrics({}), {});
});

test("keep (true or a list) and extra drops; env parsing", () => {
	assert.equal(identifyingKeysToDrop(true).size, 0);
	const some = new IdentifyingAttributeFilter(identifyingKeysToDrop(["http.user_agent"], ["host.name"]));
	const out = some.traces({ resourceSpans: [{ resource: { attributes: kv({ "host.name": "laptop", "service.instance.id": "i" }) }, scopeSpans: [{ spans: [{ attributes: kv({ "http.user_agent": "ua", "net.peer.ip": "1.2.3.4" }) }] }] }] });
	assert.deepEqual(keysOf(out.resourceSpans[0]!.resource.attributes), ["service.instance.id"]);
	assert.deepEqual(keysOf(out.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes), ["http.user_agent"]);
	const all = new IdentifyingAttributeFilter(identifyingKeysToDrop(true));
	const request = { resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: kv({ "net.peer.ip": "1.2.3.4" }) }] }] }] };
	assert.equal(all.traces(request), request);

	assert.equal(keepIdentifyingEnv(undefined), undefined);
	assert.equal(keepIdentifyingEnv("TRUE"), true);
	assert.equal(keepIdentifyingEnv("off"), false);
	assert.deepEqual(keepIdentifyingEnv("host.id, http.user_agent"), ["host.id", "http.user_agent"]);
	assert.deepEqual(dropAttributesEnv("host.name,"), ["host.name"]);
	assert.equal(dropAttributesEnv(""), undefined);
});

// ---------------------------------------------------------------------------
// Through the ingester: a real Python OpenTelemetry export (protobuf, Flask
// instrumentation: net.peer.ip, net.peer.port, http.user_agent) and a plain
test("test client: a SERVER span whose raw user agent is exactly `testclient` gets autter.test_client; the user agent is still dropped", () => {
	const filter = new IdentifyingAttributeFilter();
	const span = (kind: number | string, attributes: Record<string, string>) => ({ kind, name: "GET /", attributes: kv(attributes) });
	const request = {
		resourceSpans: [{
			scopeSpans: [{
				spans: [
					span(2, { "http.user_agent": "testclient", "http.host": "testserver" }),
					span("SPAN_KIND_SERVER", { "user_agent.original": "testclient" }),
					span(1, { "http.user_agent": "testclient" }),
					span(3, { "user_agent.original": "testclient" }),
					span(2, { "user_agent.original": "Mozilla/5.0 testclient" }),
					span(2, { "http.user_agent": "TestClient" }),
				],
			}],
		}],
	};
	const before = JSON.stringify(request);
	const spans = filter.traces(request).resourceSpans[0]!.scopeSpans[0]!.spans;
	assert.equal(JSON.stringify(request), before, "input not mutated");
	assert.deepEqual(spans.map((s) => keysOf(s.attributes)), [
		["http.host", "autter.test_client"],
		["autter.test_client"],
		[], [], [], [],
	]);
	assert.deepEqual((spans[0]!.attributes as Array<{ value: unknown }>)[1]!.value, { boolValue: true });

	// Already marked (an SDK did it): not added twice. With the client IP hash too.
	const hashing = new IdentifyingAttributeFilter(identifyingKeysToDrop(), clientIpHasher(true, "s".repeat(16)));
	const marked = hashing.traces({ resourceSpans: [{ scopeSpans: [{ spans: [
		{ kind: 2, attributes: [...kv({ "http.user_agent": "testclient", "client.address": "203.0.113.9" }), { key: "autter.test_client", value: { boolValue: true } }] },
		{ kind: 2, attributes: kv({ "http.user_agent": "testclient", "client.address": "203.0.113.9" }) },
	] }] }] }).resourceSpans[0]!.scopeSpans[0]!.spans;
	assert.deepEqual(marked.map((s) => keysOf(s.attributes)), [
		["autter.test_client", "client.address_hash"],
		["client.address_hash", "autter.test_client"],
	]);

	// Log records are never marked.
	const logs = filter.logs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: kv({ "user_agent.original": "testclient" }) }] }] }] });
	assert.deepEqual(keysOf(logs.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes), []);
});

// OTLP/JSON logs export, against a fake ClickHouse.

const listen = async (server: Server) => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) =>
	new Promise<void>((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});

async function withIngester(
	extra: Partial<IngesterConfig>,
	fn: (post: (path: string, body: Buffer | string, type: string) => Promise<number>, rows: Record<string, Array<Record<string, unknown>>>) => Promise<void>,
) {
	const rows: Record<string, Array<Record<string, unknown>>> = {};
	const ch = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const query = new URL(req.url!, "http://localhost").searchParams.get("query") ?? "";
			const table = /INSERT INTO\s+\S*?(runtime_[a-z0-9_]+)/.exec(query)?.[1];
			if (table) (rows[table] ??= []).push(...body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
			res.end();
		});
	});
	const chUrl = await listen(ch);
	const config: IngesterConfig = {
		port: 0, clickhouseUrl: chUrl, clickhouseUser: "default", clickhousePassword: "", clickhouseDatabase: "autter_runtime",
		ingestKeys: [{ key: "server", orgId: "org", repositoryId: "repo" }],
		keyValidatorUrl: null, keyValidatorToken: null, sinkUrl: null, sinkToken: null, sinkMaxAttempts: 1,
		sinkMaxBufferedBatches: 10, sinkMaxBufferedMb: 2, maxBodyBytes: 1024 * 1024, rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120, occurrenceTtlDays: 14, spanTtlDays: 7, metricsTtlDays: 90, llmCallTtlDays: 90,
		logTtlDays: 14, ...extra,
	};
	const app = createIngesterApp(config).app.listen();
	const url = await new Promise<string>((resolve) =>
		app.once("listening", () => resolve(`http://127.0.0.1:${(app.address() as AddressInfo).port}`)),
	);
	const post = async (path: string, body: Buffer | string, type: string) =>
		(await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": type, authorization: "Bearer server" }, body })).status;
	try {
		await fn(post, rows);
	} finally {
		await close(app);
		await close(ch);
	}
}

const PYTHON_TRACES = readFileSync(new URL("../test-fixtures/python/flask-unhandled.otlp.pb", import.meta.url));
const LOGS = JSON.stringify({
	resourceLogs: [{
		resource: { attributes: kv({ "service.name": "shop", "service.instance.id": "inst-1", "host.name": "web-1", "process.command_line": "node app.js --db=x" }) },
		scopeLogs: [{ logRecords: [{ timeUnixNano: String(Date.now() * 1e6), severityText: "info", body: { stringValue: "hello" },
			attributes: kv({ "client.address": "203.0.113.9", "user_agent.original": "Mozilla/5.0", "http.route": "/x" }) }] }],
	}],
});

/** Every key stored in a JSON `attributes` column of `table`. */
const storedKeys = (rows: Record<string, Array<Record<string, unknown>>>, table: string) =>
	new Set((rows[table] ?? []).flatMap((row) => Object.keys(JSON.parse(String(row.attributes ?? "{}")))));

test("the ingester stores no identifying attribute from a plain OpenTelemetry sender", async () => {
	await withIngester({}, async (post, rows) => {
		assert.equal(await post("/v1/traces", PYTHON_TRACES, "application/x-protobuf"), 200);
		assert.equal(await post("/v1/logs", LOGS, "application/json"), 200);
		assert.ok(rows.runtime_spans?.length, "spans stored");
		assert.ok(rows.runtime_logs?.length, "logs stored");
		for (const table of ["runtime_spans", "runtime_logs", "runtime_error_occurrences"])
			for (const key of vectors.drop) assert.ok(!storedKeys(rows, table).has(key), `${key} stored in ${table}`);
		assert.ok(storedKeys(rows, "runtime_spans").has("http.route"), "other attributes are stored");
		assert.ok(storedKeys(rows, "runtime_logs").has("http.route"));
	});
});

test("keepIdentifyingAttributes (AUTTER_KEEP_IDENTIFYING_ATTRIBUTES) stores them; a list stores those keys", async () => {
	await withIngester({ keepIdentifyingAttributes: true }, async (post, rows) => {
		assert.equal(await post("/v1/traces", PYTHON_TRACES, "application/x-protobuf"), 200);
		assert.equal(await post("/v1/logs", LOGS, "application/json"), 200);
		for (const key of ["net.peer.ip", "net.peer.port", "http.user_agent"]) assert.ok(storedKeys(rows, "runtime_spans").has(key), key);
		assert.ok(storedKeys(rows, "runtime_logs").has("client.address"));
	});
	await withIngester({ keepIdentifyingAttributes: ["http.user_agent"] }, async (post, rows) => {
		assert.equal(await post("/v1/traces", PYTHON_TRACES, "application/x-protobuf"), 200);
		assert.ok(storedKeys(rows, "runtime_spans").has("http.user_agent"));
		assert.ok(!storedKeys(rows, "runtime_spans").has("net.peer.ip"));
	});
});

// FastAPI's TestClient, recorded (test-fixtures/python/record_fastapi_testclient.py).
const TESTCLIENT = readFileSync(new URL("../test-fixtures/python/fastapi-testclient.otlp.pb", import.meta.url));
const TESTCLIENT_STAGING = readFileSync(new URL("../test-fixtures/python/fastapi-testclient-staging.otlp.pb", import.meta.url));
/** Waits (up to 2 s) for the inserts the ingester makes after answering
 * (SDK sightings, ingester info), so closing the fake ClickHouse does not
 * reset them mid-request. Quiets the log only: nothing is asserted on them. */
async function backgroundInserts(rows: Record<string, unknown[]>) {
	const deadline = Date.now() + 2000;
	while (!(rows.runtime_sdk_versions && rows.runtime_ingester_info) && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 10));
}
const attributesOf = (row: Record<string, unknown>) => JSON.parse(String(row.attributes ?? "{}")) as Record<string, unknown>;

/** The recorded no-environment export, as OTLP/JSON, with `deployment.environment` set to `name`. */
function testClientWithEnvironment(name: string): string {
	const request = JSON.parse(readFileSync(new URL("../test-fixtures/python/fastapi-testclient.otlp.json", import.meta.url), "utf8"));
	for (const rs of request.resourceSpans) rs.resource.attributes.push({ key: "deployment.environment", value: { stringValue: name } });
	return JSON.stringify(request);
}

test("TestClient traffic with no environment is stored as `production`: the server spans carry the autter.test_client hint and no user agent", async () => {
	await withIngester({}, async (post, rows) => {
		assert.equal(await post("/v1/traces", TESTCLIENT, "application/x-protobuf"), 200);
		const spans = rows.runtime_spans ?? [];
		assert.equal(spans.length, 6);
		// The user agent and host are the caller's to send: they never change the environment.
		assert.deepEqual(new Set(spans.map((row) => row.environment)), new Set(["production"]));
		const servers = spans.filter((row) => row.kind === "server");
		assert.equal(servers.length, 2);
		for (const row of servers) {
			const attributes = attributesOf(row);
			assert.equal(attributes["autter.test_client"], true);
			assert.equal(attributes["http.user_agent"], undefined, "the user agent is still dropped");
			assert.equal(attributes["user_agent.original"], undefined);
		}
		for (const row of spans.filter((r) => r.kind !== "server")) assert.equal(attributesOf(row)["autter.test_client"], undefined);
		const occurrences = rows.runtime_error_occurrences ?? [];
		assert.deepEqual(occurrences.map((row) => row.environment), ["production", "production"]);
		for (const table of ["runtime_spans", "runtime_error_occurrences"])
			for (const key of vectors.drop) assert.ok(!storedKeys(rows, table).has(key), `${key} stored in ${table}`);
		await backgroundInserts(rows);
	});
});

test("the same TestClient export with deployment.environment=test set explicitly is stored as `test`", async () => {
	await withIngester({}, async (post, rows) => {
		assert.equal(await post("/v1/traces", testClientWithEnvironment("test"), "application/json"), 200);
		assert.deepEqual(new Set((rows.runtime_spans ?? []).map((row) => row.environment)), new Set(["test"]));
		assert.deepEqual((rows.runtime_error_occurrences ?? []).map((row) => row.environment), ["test", "test"]);
		await backgroundInserts(rows);
	});
});

test("the TestClient export with deployment.environment=staging stays `staging`", async () => {
	await withIngester({}, async (post, rows) => {
		assert.equal(await post("/v1/traces", TESTCLIENT_STAGING, "application/x-protobuf"), 200);
		assert.deepEqual(new Set((rows.runtime_spans ?? []).map((row) => row.environment)), new Set(["staging"]));
		assert.deepEqual((rows.runtime_error_occurrences ?? []).map((row) => row.environment), ["staging", "staging"]);
		for (const row of (rows.runtime_spans ?? []).filter((r) => r.kind === "server"))
			assert.equal(attributesOf(row)["autter.test_client"], true);
		await backgroundInserts(rows);
	});
});

test("with the user agent kept (AUTTER_KEEP_IDENTIFYING_ATTRIBUTES) it is stored, and the environment is still `production`", async () => {
	await withIngester({ keepIdentifyingAttributes: true }, async (post, rows) => {
		assert.equal(await post("/v1/traces", TESTCLIENT, "application/x-protobuf"), 200);
		assert.deepEqual(new Set((rows.runtime_spans ?? []).map((row) => row.environment)), new Set(["production"]));
		for (const row of (rows.runtime_spans ?? []).filter((r) => r.kind === "server")) {
			assert.equal(attributesOf(row)["http.user_agent"], "testclient");
			// Nothing is dropped, so the filter passes the request through:
			// the raw user agent is stored instead of the hint.
			assert.equal(attributesOf(row)["autter.test_client"], undefined);
		}
		await backgroundInserts(rows);
	});
});
