import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
	ProtobufLogsSerializer,
	ProtobufMetricsSerializer,
	ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import protobuf from "protobufjs";
import { loadConfig, type IngesterConfig } from "./config.js";
import type { IngestDropRow } from "./ingest-drops.js";
import { createIngesterApp } from "./server.js";

/**
 * EI-27 over the wire: every way the ingester refuses a request, and every
 * record an accepted request does not store, lands in runtime_ingest_drops
 * under its reason; OTLP answers carry the drops in `partial_success`
 * (JSON and protobuf, the latter decoded with OpenTelemetry's own response
 * types). ClickHouse calls are stubbed; the drop rows are captured.
 */

const SERVER = `autter_rt_${"5".repeat(48)}`;
const LIMITED = `autter_rt_${"6".repeat(48)}`;
const CLIENT = `autter_rtc_${"7".repeat(48)}`;
const UPLOAD = `autter_rtu_${"8".repeat(48)}`;
const REVOKED = `autter_rt_${"9".repeat(48)}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const nanos = () => String(BigInt(Date.now()) * 1_000_000n);

function config(overrides: Partial<IngesterConfig> = {}): IngesterConfig {
	return {
		...loadConfig(),
		clickhouseUrl: "http://127.0.0.1:1",
		maxBodyBytes: 256 * 1024,
		rateLimitPerMinute: 1000,
		ingestKeys: [
			{ key: SERVER, orgId: "org-a", repositoryId: "repo-a" },
			{ key: LIMITED, orgId: "org-a", repositoryId: "repo-limited" },
			{ key: CLIENT, orgId: "org-a", repositoryId: "repo-a", scope: "client", allowedOrigins: ["https://app.test"] },
			{ key: UPLOAD, orgId: "org-a", repositoryId: "repo-a", scope: "upload" },
		],
		...overrides,
	};
}

/** The real app, ClickHouse stubbed, drop rows captured. */
async function start(overrides: Partial<IngesterConfig> = {}) {
	const ingester = createIngesterApp(config(overrides));
	const { app, store, drops } = ingester;
	const stub = store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) stub[name] = async () => {};
	}
	stub.ensureSchema = async () => {};
	stub.recentOccurrenceTraceIds = async () => new Set();
	stub.lookupSourceMap = async () => null;
	stub.sourceMapsPresent = async () => [];
	const written: IngestDropRow[] = [];
	store.insertIngestDrops = async (rows) => void written.push(...rows);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		ingester,
		store,
		post: (path: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
			fetch(`${base}${path}`, { method: "POST", headers, body }),
		json: (path: string, key: string | null, body: unknown, headers: Record<string, string> = {}) =>
			fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
				body: JSON.stringify(body),
			}),
		/** Everything counted so far (after the background tenant lookups settle). */
		async counted(): Promise<IngestDropRow[]> {
			await new Promise((r) => setTimeout(r, 20));
			await drops.flush();
			return written;
		},
		close: () =>
			new Promise<void>((resolve) => {
				void drops.stop();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

type App = Awaited<ReturnType<typeof start>>;

/** The one row counted for this route and reason (summed across minutes and writes). */
function only(rows: IngestDropRow[], route: string, reason: string) {
	const matching = rows.filter((row) => row.route === route && row.reason === reason);
	assert.ok(matching.length > 0, `nothing counted for ${route} ${reason}: ${JSON.stringify(rows.map((r) => [r.route, r.reason]))}`);
	const [first] = matching;
	return {
		tenant: [first!.orgId, first!.repositoryId],
		kind: first!.kind,
		status: first!.status,
		keyHash: first!.keyHash,
		requests: matching.reduce((sum, row) => sum + row.requests, 0),
		records: matching.reduce((sum, row) => sum + row.records, 0),
	};
}

const traces = (spans: number, attributes: Array<{ key: string; value: { stringValue: string } }> = []) => ({
	resourceSpans: [{
		resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
		scopeSpans: [{ spans: Array.from({ length: spans }, (_, i) => ({
			traceId: "a".repeat(32), spanId: i.toString(16).padStart(16, "0"), name: "work", kind: 1,
			startTimeUnixNano: nanos(), endTimeUnixNano: nanos(), attributes,
		})) }],
	}],
});

test("every rejection is counted under its reason, tenant and status", async (t) => {
	const app = await start();
	t.after(app.close);
	const at = new Date().toISOString();
	const expect = async (res: Response, status: number) => {
		assert.equal(res.status, status, `${res.url}: ${await res.clone().text()}`);
	};

	// 401: no key, a revoked Autter key (hashed), a foreign token (never hashed).
	await expect(await app.json("/v1/traces", null, traces(2)), 401);
	await expect(await app.json("/v1/traces", REVOKED, traces(3)), 401);
	await expect(await app.json("/v1/logs", "dd-0123456789abcdef0123456789abcdef", { resourceLogs: [] }), 401);
	// 403: the wrong key type, or a client key from an origin not on its list.
	await expect(await app.json("/v1/traces", UPLOAD, traces(4)), 403);
	await expect(await app.json("/v1/metrics", CLIENT, { resourceMetrics: [] }, { origin: "https://app.test" }), 403);
	await expect(await app.json("/v1/sourcemaps", CLIENT, { release: "r", filename: "/a.js", map: {} }, { origin: "https://app.test" }), 403);
	const beacon = JSON.stringify({ version: 1, service: "web", environment: "production", events: [
		{ type: "exception", timestamp: at, message: "x" }, { type: "session_start", timestamp: at },
	] });
	await expect(await app.post(`/v1/browser?key=${CLIENT}`, beacon, { "content-type": "text/plain", origin: "https://evil.test" }), 403);
	// 429: past the key's window.
	const limited = await start({ rateLimitPerMinute: 2 });
	t.after(limited.close);
	for (let i = 0; i < 2; i++) await expect(await limited.json("/v1/traces", LIMITED, traces(1)), 200);
	await expect(await limited.json("/v1/traces", LIMITED, traces(5)), 429);
	// 400: malformed JSON (refused before any route ran), unreadable values,
	// a bad protobuf body, an invalid browser envelope, a bad platform event
	// and source map check.
	await expect(await app.post("/v1/traces", "{nope", { "content-type": "application/json", authorization: `Bearer ${SERVER}` }), 400);
	const badTimestamp = traces(1);
	badTimestamp.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano = "soon";
	await expect(await app.json("/v1/traces", SERVER, badTimestamp), 400);
	await expect(await app.json("/v1/traces", SERVER, { resourceSpans: 5 }), 400);
	await expect(await app.json("/v1/metrics", SERVER, { resourceMetrics: [{ scopeMetrics: 7 }] }), 400);
	await expect(await app.post("/v1/traces", new Uint8Array([0x0a, 0xff, 0xff, 0xff]), { "content-type": "application/x-protobuf", authorization: `Bearer ${SERVER}` }), 400);
	await expect(await app.json("/v1/browser", SERVER, { version: 9, service: "web", environment: "p", events: [{}, {}, {}] }), 400);
	await expect(await app.json("/v1/platform-events", SERVER, { kind: "nope" }), 400);
	await expect(await app.json("/v1/sourcemaps/check", SERVER, { release: 5 }), 400);
	// The process is still up after the values that used to throw out of the handler.
	await expect(await app.json("/v1/traces", SERVER, traces(1)), 200);
	// 413 and 415, including an encoding body-parser can't inflate.
	await expect(await app.json("/v1/traces", SERVER, { pad: "x".repeat(300 * 1024) }), 413);
	await expect(await app.post("/v1/traces", "spans", { "content-type": "text/plain", authorization: `Bearer ${SERVER}` }), 415);
	await expect(await app.post("/v1/logs", new Uint8Array([1, 2, 3]), { "content-type": "application/json", "content-encoding": "br", authorization: `Bearer ${SERVER}` }), 415);
	await expect(await app.post("/v1/profiles", "{}", { "content-type": "application/json", authorization: `Bearer ${SERVER}` }), 415);
	// 404: an exporter whose endpoint already ends in /v1/traces.
	await expect(await app.json("/v1/traces/v1/traces", SERVER, traces(2)), 404);
	// 503: ClickHouse refused the write.
	const insertSpans = app.store.insertSpans;
	app.store.insertSpans = async () => {
		throw new Error("clickhouse down");
	};
	await expect(await app.json("/v1/traces", SERVER, traces(6)), 503);
	app.store.insertSpans = insertSpans;

	const rows = await app.counted();
	const tenant = ["org-a", "repo-a"];
	const none = ["", ""];
	assert.deepEqual(only(rows, "/v1/traces", "missing_key"), { tenant: none, kind: "rejected", status: 401, keyHash: "", requests: 1, records: 2 });
	assert.deepEqual(only(rows, "/v1/traces", "unknown_key"), { tenant: none, kind: "rejected", status: 401, keyHash: sha256(REVOKED), requests: 1, records: 3 });
	assert.deepEqual(only(rows, "/v1/logs", "unknown_key"), { tenant: none, kind: "rejected", status: 401, keyHash: "", requests: 1, records: 0 });
	assert.deepEqual(only(rows, "/v1/traces", "upload_key_not_allowed"), { tenant, kind: "rejected", status: 403, keyHash: "", requests: 1, records: 4 });
	assert.deepEqual(only(rows, "/v1/metrics", "client_key_not_allowed"), { tenant, kind: "rejected", status: 403, keyHash: "", requests: 1, records: 0 });
	assert.deepEqual(only(rows, "/v1/sourcemaps", "client_key_not_allowed"), { tenant, kind: "rejected", status: 403, keyHash: "", requests: 1, records: 1 });
	assert.deepEqual(only(rows, "/v1/browser", "origin_not_allowed"), { tenant, kind: "rejected", status: 403, keyHash: "", requests: 1, records: 2 });
	assert.deepEqual(only(rows, "/v1/traces", "invalid_payload"), { tenant, kind: "rejected", status: 400, keyHash: "", requests: 4, records: 1 });
	assert.deepEqual(only(rows, "/v1/metrics", "invalid_payload").requests, 1);
	assert.deepEqual(only(rows, "/v1/browser", "invalid_payload"), { tenant, kind: "rejected", status: 400, keyHash: "", requests: 1, records: 3 });
	assert.deepEqual(only(rows, "/v1/platform-events", "invalid_payload"), { tenant, kind: "rejected", status: 400, keyHash: "", requests: 1, records: 1 });
	assert.deepEqual(only(rows, "/v1/sourcemaps/check", "invalid_payload"), { tenant, kind: "rejected", status: 400, keyHash: "", requests: 1, records: 0 });
	assert.deepEqual(only(rows, "/v1/traces", "payload_too_large"), { tenant, kind: "rejected", status: 413, keyHash: "", requests: 1, records: 0 });
	assert.deepEqual(only(rows, "/v1/traces", "unsupported_media_type"), { tenant, kind: "rejected", status: 415, keyHash: "", requests: 1, records: 0 });
	assert.deepEqual(only(rows, "/v1/logs", "unsupported_media_type"), { tenant, kind: "rejected", status: 415, keyHash: "", requests: 1, records: 0 });
	assert.deepEqual(only(rows, "/v1/profiles", "unsupported_media_type").status, 415);
	assert.deepEqual(only(rows, "other", "unknown_route"), { tenant, kind: "rejected", status: 404, keyHash: "", requests: 1, records: 0 });
	assert.deepEqual(only(rows, "/v1/traces", "storage_unavailable"), { tenant, kind: "rejected", status: 503, keyHash: "", requests: 1, records: 6 });
	assert.deepEqual(only(await limited.counted(), "/v1/traces", "rate_limited"), {
		tenant: ["org-a", "repo-limited"], kind: "rejected", status: 429, keyHash: "", requests: 1, records: 5,
	});
	// Accepted requests are not rejections.
	assert.equal(rows.filter((row) => row.kind === "rejected").reduce((sum, row) => sum + row.requests, 0), 21);
});

test("a key the validator can't check is key_unverified; one it refuses is unknown_key", async (t) => {
	let status = 500;
	const validator = createServer((req, res) => {
		req.resume();
		req.on("end", () => res.writeHead(status).end(status === 200 ? "{}" : ""));
	});
	await new Promise<void>((resolve) => validator.listen(0, "127.0.0.1", resolve));
	t.after(() => validator.close());
	const url = `http://127.0.0.1:${(validator.address() as AddressInfo).port}/validate`;
	const app = await start({ ingestKeys: [], keyValidatorUrl: url });
	t.after(app.close);
	const key = (n: number) => `autter_rt_${String(n).repeat(48)}`;
	assert.equal((await app.json("/v1/traces", key(1), traces(1))).status, 401);
	// Cached: the same answer, and the same reason, inside the cache window.
	assert.equal((await app.json("/v1/traces", key(1), traces(1))).status, 401);
	status = 403;
	assert.equal((await app.json("/v1/traces", key(2), traces(1))).status, 401);
	// Unreachable validator.
	const down = await start({ ingestKeys: [], keyValidatorUrl: "http://127.0.0.1:1/validate" });
	t.after(down.close);
	assert.equal((await down.json("/v1/logs", key(3), { resourceLogs: [] })).status, 401);

	const rows = await app.counted();
	assert.deepEqual(only(rows, "/v1/traces", "key_unverified"), { tenant: ["", ""], kind: "rejected", status: 401, keyHash: sha256(key(1)), requests: 2, records: 2 });
	assert.deepEqual(only(rows, "/v1/traces", "unknown_key").keyHash, sha256(key(2)));
	assert.deepEqual(only(await down.counted(), "/v1/logs", "key_unverified").keyHash, sha256(key(3)));
});

test("silent drops inside accepted requests are counted and answered in partialSuccess (JSON)", async (t) => {
	const app = await start({ maxBodyBytes: 4 * 1024 * 1024 });
	t.after(app.close);
	const at = new Date().toISOString();

	const spans = await app.json("/v1/traces", SERVER, traces(5003));
	assert.equal(spans.status, 200);
	const spanAnswer = (await spans.json()) as { partialSuccess: { rejectedSpans: string; errorMessage: string } };
	assert.equal(spanAnswer.partialSuccess.rejectedSpans, "3");
	assert.match(spanAnswer.partialSuccess.errorMessage, /^3 spans rejected: one request takes at most 5000 spans/);
	// Fully accepted: the empty partial success, as before, even with values cut.
	const statement = [{ key: "db.statement", value: { stringValue: "s".repeat(3000) } }];
	assert.deepEqual(await (await app.json("/v1/traces", SERVER, traces(2, statement))).json(), { partialSuccess: {} });

	const logs = await app.json("/v1/logs", SERVER, { resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: 2003 }, () => ({ body: { stringValue: "x" } })) }] }] });
	assert.equal(logs.status, 200);
	const logAnswer = (await logs.json()) as { partialSuccess: { rejectedLogRecords: string; errorMessage: string } };
	assert.equal(logAnswer.partialSuccess.rejectedLogRecords, "3");
	assert.match(logAnswer.partialSuccess.errorMessage, /at most 2000 log records/);

	const histogram = (temporality: number) => ({
		name: "http.server.duration",
		histogram: { aggregationTemporality: temporality, dataPoints: [{ count: "3", sum: 30, timeUnixNano: nanos(), startTimeUnixNano: nanos() }, { count: "1", sum: 5, timeUnixNano: nanos() }] },
	});
	const metrics = await app.json("/v1/metrics", SERVER, { resourceMetrics: [{
		resource: { attributes: [
			{ key: "service.name", value: { stringValue: "api" } },
			{ key: "service.instance.id", value: { stringValue: "i-1" } },
		] },
		scopeMetrics: [{ metrics: [
			histogram(2),
			histogram(1),
			{ name: "process.runtime.nodejs.memory.heap.used", unit: "By", gauge: { dataPoints: [{ asDouble: -5, timeUnixNano: nanos() }] } },
			{ name: "my.business.metric", gauge: { dataPoints: [{ asDouble: 1, timeUnixNano: nanos() }] } },
		] }],
	}] });
	assert.equal(metrics.status, 200);
	const metricAnswer = (await metrics.json()) as { partialSuccess: { rejectedDataPoints: string; errorMessage: string } };
	// 2 cumulative points + 1 invalid memory point; the business metric is ignored, not rejected.
	assert.equal(metricAnswer.partialSuccess.rejectedDataPoints, "3");
	assert.match(metricAnswer.partialSuccess.errorMessage, /2 data points of cumulative .* delta temporality/);
	assert.match(metricAnswer.partialSuccess.errorMessage, /1 memory data point rejected/);

	const browser = await app.json("/v1/browser", SERVER, {
		version: 1, service: "web", environment: "production",
		events: [
			{ type: "exception", timestamp: at, message: "boom", context: { blob: "b".repeat(5000) } },
			{ type: "from_a_newer_sdk", timestamp: at },
			...Array.from({ length: 52 }, () => ({ type: "session_start", timestamp: at })),
		],
	});
	assert.equal(browser.status, 202);
	const browserAnswer = (await browser.json()) as { accepted: number; rejected: number; issues: Array<{ path: unknown[] }> };
	assert.equal(browserAnswer.accepted, 1);
	// 1 unknown type + 4 past the 50-event cap.
	assert.equal(browserAnswer.rejected, 5);
	assert.deepEqual(browserAnswer.issues[0]!.path.slice(0, 2), ["events", 1]);

	const rows = await app.counted();
	const tenant = ["org-a", "repo-a"];
	assert.deepEqual(only(rows, "/v1/traces", "spans_over_limit"), { tenant, kind: "dropped", status: 200, keyHash: "", requests: 1, records: 3 });
	// The 3000-character statement on each of the two spans.
	assert.deepEqual(only(rows, "/v1/traces", "attributes_truncated"), { tenant, kind: "truncated", status: 200, keyHash: "", requests: 1, records: 2 });
	assert.deepEqual(only(rows, "/v1/logs", "log_records_over_limit"), { tenant, kind: "dropped", status: 200, keyHash: "", requests: 1, records: 3 });
	assert.deepEqual(only(rows, "/v1/metrics", "cumulative_histogram"), { tenant, kind: "dropped", status: 200, keyHash: "", requests: 1, records: 2 });
	assert.deepEqual(only(rows, "/v1/metrics", "memory_point_invalid").records, 1);
	assert.deepEqual(only(rows, "/v1/browser", "invalid_event"), { tenant, kind: "dropped", status: 202, keyHash: "", requests: 1, records: 1 });
	assert.deepEqual(only(rows, "/v1/browser", "events_over_limit"), { tenant, kind: "dropped", status: 202, keyHash: "", requests: 1, records: 4 });
	assert.deepEqual(only(rows, "/v1/browser", "attributes_truncated").records, 1);
	// Nothing was refused.
	assert.deepEqual(rows.filter((row) => row.kind === "rejected"), []);
});

// The request side of OTLP protobuf, enough to build big exports.
const REQUESTS = protobuf.parse(`syntax = "proto3";
	message KeyValue { string key = 1; AnyValue value = 2; }
	message AnyValue { string string_value = 1; }
	message Resource { repeated KeyValue attributes = 1; }
	message TracesData { repeated ResourceSpans resource_spans = 1; }
	message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
	message ScopeSpans { repeated Span spans = 2; }
	message Span { string name = 5; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8; }
	message LogsData { repeated ResourceLogs resource_logs = 1; }
	message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
	message ScopeLogs { repeated LogRecord log_records = 2; }
	message LogRecord { int32 severity_number = 2; AnyValue body = 5; }
	message MetricsData { repeated ResourceMetrics resource_metrics = 1; }
	message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
	message ScopeMetrics { repeated Metric metrics = 2; }
	message Metric { string name = 1; Histogram histogram = 9; }
	message Histogram { repeated HistogramDataPoint data_points = 1; int32 aggregation_temporality = 2; }
	message HistogramDataPoint { fixed64 time_unix_nano = 3; fixed64 count = 4; }`).root;
const pb = (type: string, value: object) => {
	const message = REQUESTS.lookupType(type);
	return message.encode(message.create(value)).finish();
};
const service = { attributes: [{ key: "service.name", value: { stringValue: "api" } }] };

async function protoAnswer(app: App, path: string, body: Uint8Array) {
	const res = await app.post(path, body, { "content-type": "application/x-protobuf", authorization: `Bearer ${SERVER}` });
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "application/x-protobuf");
	return new Uint8Array(await res.arrayBuffer());
}

test("partialSuccess in protobuf answers decodes with OpenTelemetry's own response types", async (t) => {
	const app = await start({ maxBodyBytes: 4 * 1024 * 1024 });
	t.after(app.close);
	const span = { name: "work", startTimeUnixNano: nanos(), endTimeUnixNano: nanos() };

	const spanBody = await protoAnswer(app, "/v1/traces", pb("TracesData", {
		resourceSpans: [{ resource: service, scopeSpans: [{ spans: Array.from({ length: 5002 }, () => span) }] }],
	}));
	const traceResponse = ProtobufTraceSerializer.deserializeResponse(spanBody);
	assert.equal(Number(traceResponse.partialSuccess?.rejectedSpans), 2);
	assert.match(String(traceResponse.partialSuccess?.errorMessage), /^2 spans rejected/);
	// Everything accepted: an empty message, as before.
	assert.equal((await protoAnswer(app, "/v1/traces", pb("TracesData", {
		resourceSpans: [{ resource: service, scopeSpans: [{ spans: [span] }] }],
	}))).length, 0);

	const logBody = await protoAnswer(app, "/v1/logs", pb("LogsData", {
		resourceLogs: [{ resource: service, scopeLogs: [{ logRecords: Array.from({ length: 2001 }, () => ({ severityNumber: 9, body: { stringValue: "x" } })) }] }],
	}));
	const logResponse = ProtobufLogsSerializer.deserializeResponse(logBody);
	assert.equal(Number(logResponse.partialSuccess?.rejectedLogRecords), 1);
	assert.match(String(logResponse.partialSuccess?.errorMessage), /^1 log record rejected/);

	const metricBody = await protoAnswer(app, "/v1/metrics", pb("MetricsData", {
		resourceMetrics: [{ resource: service, scopeMetrics: [{ metrics: [{
			name: "http.server.request.duration",
			histogram: { aggregationTemporality: 2, dataPoints: [{ timeUnixNano: nanos(), count: 4 }, { timeUnixNano: nanos(), count: 1 }] },
		}] }] }],
	}));
	const metricResponse = ProtobufMetricsSerializer.deserializeResponse(metricBody);
	assert.equal(Number(metricResponse.partialSuccess?.rejectedDataPoints), 2);
	assert.match(String(metricResponse.partialSuccess?.errorMessage), /cumulative/);

	const rows = await app.counted();
	assert.equal(only(rows, "/v1/traces", "spans_over_limit").records, 2);
	assert.equal(only(rows, "/v1/logs", "log_records_over_limit").records, 1);
	assert.equal(only(rows, "/v1/metrics", "cumulative_histogram").records, 2);

	// A refused protobuf export counts its records from the wire format.
	const refused = await app.post("/v1/traces", pb("TracesData", {
		resourceSpans: [{ resource: service, scopeSpans: [{ spans: [span, span, span] }] }],
	}), { "content-type": "application/x-protobuf", authorization: `Bearer ${UPLOAD}` });
	assert.equal(refused.status, 403);
	assert.equal(only(await app.counted(), "/v1/traces", "upload_key_not_allowed").records, 3);
});

test("a failing drop write never affects ingest", async (t) => {
	const app = await start({ maxBodyBytes: 4 * 1024 * 1024 });
	t.after(app.close);
	let writes = 0;
	app.store.insertIngestDrops = async () => {
		writes += 1;
		throw new Error("runtime_ingest_drops is missing");
	};
	assert.equal((await app.json("/v1/traces", null, traces(1))).status, 401);
	await app.ingester.drops.flush();
	assert.equal(writes, 1);
	assert.equal(app.ingester.drops.stats().failedWrites, 1);
	// Ingest carries on, refusals included, and the next write is attempted afresh.
	assert.equal((await app.json("/v1/traces", SERVER, traces(5003))).status, 200);
	assert.equal((await app.json("/v1/traces", null, traces(1))).status, 401);
	await app.ingester.drops.flush();
	assert.equal(writes, 2);
	assert.equal(app.ingester.drops.stats().discardedRows, 3);
});

test("without ClickHouse nothing is counted (the 503 has nowhere to go)", async (t) => {
	const app = await start({ clickhouseUrl: null });
	t.after(app.close);
	assert.equal((await app.json("/v1/traces", SERVER, traces(1))).status, 503);
	assert.equal((await app.json("/v1/traces/oops", SERVER, traces(1))).status, 404);
	assert.deepEqual(await app.counted(), []);
});
