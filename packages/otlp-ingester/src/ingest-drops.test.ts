import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import protobuf from "protobufjs";
import { ClickHouseStore } from "./clickhouse.js";
import { loadConfig } from "./config.js";
import { countTruncations, decodeOtlpAttributes, sanitizeRuntimeContext } from "./context.js";
import {
	autterKeyHash,
	countProtoPath,
	cumulativeHttpHistogramPoints,
	DROP_REASONS,
	dropRoute,
	dropStatus,
	IngestDropCounter,
	ingestDropsTableDDL,
	partialSuccess,
	recordsInBody,
	type IngestDropRow,
} from "./ingest-drops.js";
import { normalizeMemoryMetrics } from "./memory.js";
import { MIGRATIONS } from "./migrations.js";
import { MAX_BROWSER_EVENTS, parseBrowserPayload } from "./normalize-browser.js";
import { decodeTraceRequest } from "./otlp-proto.js";
import { decodeProfile } from "./profiles.js";
import { SinkForwarder, type SinkDrop } from "./sink.js";
import { inAppFrameResolution } from "./symbolicate.js";
import type { StackFrame } from "./types.js";

const tenant = { orgId: "org-1", repositoryId: "repo-1" };
const noLog = () => {};

// ── the counter ───────────────────────────────────────────────────────────

test("the counter aggregates per tenant, minute, route and reason, then writes in one batch", async () => {
	let now = Date.parse("2026-10-21T10:00:30Z");
	const writes: IngestDropRow[][] = [];
	const counter = new IngestDropCounter(async (rows) => void writes.push(rows), { now: () => now, log: noLog });
	counter.record({ tenant, route: "/v1/traces", reason: "rate_limited", records: 10 });
	counter.record({ tenant, route: "/v1/traces", reason: "rate_limited", records: 5 });
	counter.record({ tenant, route: "/v1/traces", reason: "spans_over_limit", records: 3 });
	counter.record({ tenant: null, route: "/v1/logs", reason: "unknown_key", keyHash: "ab".repeat(32) });
	now += 60_000; // next minute: its own row
	counter.record({ tenant, route: "/v1/traces", reason: "rate_limited", records: 1 });
	// Nothing to count: skipped.
	counter.record({ tenant, route: "/v1/traces", reason: "attributes_truncated", requests: 0, records: 0 });
	assert.equal(counter.stats().buffered, 4);
	await counter.flush();
	assert.equal(writes.length, 1);
	const rows = writes[0]!.map((row) => ({ ...row, minute: row.minute.toISOString() }));
	assert.deepEqual(rows, [
		{ ...tenant, minute: "2026-10-21T10:00:00.000Z", route: "/v1/traces", reason: "rate_limited", kind: "rejected", status: 429, keyHash: "", requests: 2, records: 15 },
		{ ...tenant, minute: "2026-10-21T10:00:00.000Z", route: "/v1/traces", reason: "spans_over_limit", kind: "dropped", status: 200, keyHash: "", requests: 1, records: 3 },
		{ orgId: "", repositoryId: "", minute: "2026-10-21T10:00:00.000Z", route: "/v1/logs", reason: "unknown_key", kind: "rejected", status: 401, keyHash: "ab".repeat(32), requests: 1, records: 0 },
		{ ...tenant, minute: "2026-10-21T10:01:00.000Z", route: "/v1/traces", reason: "rate_limited", kind: "rejected", status: 429, keyHash: "", requests: 1, records: 1 },
	]);
	assert.equal(counter.stats().buffered, 0);
	assert.equal(counter.stats().written, 4);
	// Nothing buffered: no write at all.
	await counter.flush();
	assert.equal(writes.length, 1);
});

test("the counter is bounded: past maxRows new rows are not counted, existing ones still are", async () => {
	const logs: string[] = [];
	const writes: IngestDropRow[][] = [];
	const counter = new IngestDropCounter(async (rows) => void writes.push(rows), {
		maxRows: 3,
		maxKeyHashes: 2,
		log: (message) => logs.push(message),
	});
	for (const repositoryId of ["a", "b", "c", "d", "e"]) {
		counter.record({ tenant: { orgId: "o", repositoryId }, route: "/v1/traces", reason: "rate_limited" });
	}
	// An existing row keeps counting when the buffer is full.
	counter.record({ tenant: { orgId: "o", repositoryId: "a" }, route: "/v1/traces", reason: "rate_limited", records: 7 });
	assert.equal(counter.stats().buffered, 3);
	assert.equal(counter.stats().overflowRequests, 2);
	await counter.flush();
	assert.match(logs.join("\n"), /ingest drop counter full: 2 request\(s\) not counted/);
	assert.deepEqual(writes[0]!.find((row) => row.repositoryId === "a")!.requests, 2);

	// Distinct key hashes are capped too; past the cap the count lands without a hash.
	for (const hash of ["h1", "h2", "h3"]) counter.record({ tenant: null, route: "/v1/traces", reason: "unknown_key", keyHash: hash });
	await counter.flush();
	assert.deepEqual(writes[1]!.map((row) => row.keyHash).sort(), ["", "h1", "h2"]);
	// The buffer empties on every write: the bound is per interval.
	assert.equal(counter.stats().buffered, 0);
});

test("a failed write is logged once and dropped, never retried, and flush never rejects", async () => {
	const logs: string[] = [];
	let fail = true;
	const writes: IngestDropRow[][] = [];
	const counter = new IngestDropCounter(
		async (rows) => {
			if (fail) throw new Error("clickhouse down");
			writes.push(rows);
		},
		{ log: (message) => logs.push(message) },
	);
	counter.record({ tenant, route: "/v1/traces", reason: "rate_limited" });
	await counter.flush();
	counter.record({ tenant, route: "/v1/logs", reason: "rate_limited" });
	await counter.flush();
	assert.equal(counter.stats().failedWrites, 2);
	assert.equal(counter.stats().discardedRows, 2);
	// Rate-limited logging: one line a minute.
	assert.equal(logs.filter((line) => /not written/.test(line)).length, 1);
	assert.match(logs[0]!, /clickhouse down/);
	fail = false;
	counter.record({ tenant, route: "/v1/metrics", reason: "rate_limited" });
	await counter.flush();
	// Only the new row: the failed ones were not retried.
	assert.deepEqual(writes.map((rows) => rows.map((row) => row.route)), [["/v1/metrics"]]);

	// A writer that throws synchronously is a failed write too.
	const sync = new IngestDropCounter(() => {
		throw new Error("boom");
	}, { log: noLog });
	sync.record({ tenant, route: "/v1/traces", reason: "rate_limited" });
	await sync.flush();
	assert.equal(sync.stats().failedWrites, 1);
});

test("a stalled write counts as failed, so counting goes on; one write at a time", async () => {
	let release: (() => void) | null = null;
	const writes: number[] = [];
	const counter = new IngestDropCounter(
		(rows) =>
			new Promise<void>((resolve) => {
				writes.push(rows.length);
				release = resolve;
			}),
		{ writeTimeoutMs: 30, log: noLog },
	);
	counter.record({ tenant, route: "/v1/traces", reason: "rate_limited" });
	const first = counter.flush();
	// While a write is in flight, flush returns it and rows keep accumulating.
	counter.record({ tenant, route: "/v1/logs", reason: "rate_limited" });
	assert.equal(counter.flush(), first);
	assert.equal(counter.stats().buffered, 1);
	// The stall guard's timer is unref'd (it never keeps the ingester alive), so
	// hold the event loop open while it runs; Node 22 ends the test otherwise.
	const hold = setTimeout(() => {}, 1000);
	await first; // the stall guard settles it
	assert.equal(counter.stats().failedWrites, 1);
	await counter.flush();
	assert.deepEqual(writes, [1, 1]);
	(release as unknown as () => void)();
	clearTimeout(hold);
});

test("the timer writes on its own and stop() writes what is left; a disabled counter keeps nothing", async () => {
	const writes: IngestDropRow[][] = [];
	const counter = new IngestDropCounter(async (rows) => void writes.push(rows), { flushIntervalMs: 10, log: noLog });
	counter.start();
	counter.record({ tenant, route: "/v1/traces", reason: "rate_limited" });
	for (let i = 0; i < 100 && writes.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(writes.length, 1);
	counter.record({ tenant, route: "/v1/logs", reason: "rate_limited" });
	await counter.stop();
	assert.equal(writes.length, 2);

	const disabled = new IngestDropCounter(async () => assert.fail("no writes"), { enabled: false });
	disabled.start();
	disabled.record({ tenant, route: "/v1/traces", reason: "rate_limited" });
	assert.equal(disabled.stats().buffered, 0);
	await disabled.stop();
});

test("every reason has a kind; rejections carry their status, drops their route's success status", () => {
	for (const [reason, info] of Object.entries(DROP_REASONS)) {
		assert.ok(["rejected", "dropped", "truncated", "unforwarded"].includes(info.kind), reason);
		assert.equal("status" in info, info.kind === "rejected", `${reason}: only rejections name a status`);
	}
	assert.equal(dropStatus("payload_too_large", "/v1/traces"), 413);
	assert.equal(dropStatus("unsupported_media_type", "/v1/logs"), 415);
	assert.equal(dropStatus("storage_unavailable", "/v1/browser"), 503);
	assert.equal(dropStatus("spans_over_limit", "/v1/traces"), 200);
	assert.equal(dropStatus("invalid_event", "/v1/browser"), 202);
	assert.equal(dropStatus("sink_overflow", "sink"), 0);
	assert.equal(dropRoute("/v1/traces"), "/v1/traces");
	assert.equal(dropRoute("/V1/Traces/"), "/v1/traces");
	assert.equal(dropRoute("/v1/traces/v1/traces"), "other");
	assert.equal(dropRoute("/v1/sourcemaps/check"), "/v1/sourcemaps/check");
});

test("only Autter-format keys are hashed (sha256, as the platform stores them)", () => {
	const key = `autter_rt_${"0123456789abcdef".repeat(3)}`;
	assert.equal(autterKeyHash(key), createHash("sha256").update(key).digest("hex"));
	assert.notEqual(autterKeyHash(`autter_rtc_${"a".repeat(48)}`), "");
	assert.notEqual(autterKeyHash(`autter_rtu_${"a".repeat(48)}`), "");
	for (const other of ["dd-api-key-0123456789abcdef", "hunter2", "autter_rt_short", "", `autter_rt_${"a".repeat(20)} spaces`]) {
		assert.equal(autterKeyHash(other), "", other);
	}
});

// ── records in a body ────────────────────────────────────────────────────

const PB = protobuf.parse(`syntax = "proto3";
	message KeyValue { string key = 1; }
	message Resource { repeated KeyValue attributes = 1; }
	message TracesData { repeated ResourceSpans resource_spans = 1; }
	message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
	message ScopeSpans { repeated Span spans = 2; }
	message Span { bytes trace_id = 1; string name = 5; fixed64 start_time_unix_nano = 7; repeated KeyValue attributes = 9; }
	message LogsData { repeated ResourceLogs resource_logs = 1; }
	message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
	message ScopeLogs { repeated LogRecord log_records = 2; }
	message LogRecord { int32 severity_number = 2; }
	message MetricsData { repeated ResourceMetrics resource_metrics = 1; }
	message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
	message ScopeMetrics { repeated Metric metrics = 2; }
	message Metric { string name = 1; Gauge gauge = 5; Sum sum = 7; Histogram histogram = 9; }
	message Gauge { repeated Point data_points = 1; }
	message Sum { repeated Point data_points = 1; }
	message Histogram { repeated Point data_points = 1; }
	message Point { fixed64 time_unix_nano = 3; double as_double = 4; }`).root;
const encode = (type: string, value: object) => {
	const message = PB.lookupType(type);
	return Buffer.from(message.encode(message.create(value)).finish());
};

test("records in a refused body: JSON walked, protobuf counted from the wire format", () => {
	const spans = { resourceSpans: [
		{ scopeSpans: [{ spans: [{ name: "a" }, { name: "b" }] }, { spans: [{ name: "c" }] }] },
		{ scopeSpans: [{ spans: [{ name: "d" }] }] },
	] };
	assert.equal(recordsInBody("/v1/traces", spans, false), 4);
	assert.equal(recordsInBody("/v1/traces", encode("TracesData", spans), true), 4);
	const logs = { resourceLogs: [{ scopeLogs: [{ logRecords: [{}, {}, {}] }] }] };
	assert.equal(recordsInBody("/v1/logs", logs, false), 3);
	assert.equal(recordsInBody("/v1/logs", encode("LogsData", { resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityNumber: 9 }, { severityNumber: 17 }] }] }] }), true), 2);
	const metrics = { resourceMetrics: [{ scopeMetrics: [{ metrics: [
		{ name: "g", gauge: { dataPoints: [{ asDouble: 1 }, { asDouble: 2 }] } },
		{ name: "s", sum: { dataPoints: [{ asDouble: 1 }] } },
		{ name: "h", histogram: { dataPoints: [{ asDouble: 1 }, { asDouble: 1 }, { asDouble: 1 }] } },
	] }] }] };
	assert.equal(recordsInBody("/v1/metrics", metrics, false), 6);
	assert.equal(recordsInBody("/v1/metrics", encode("MetricsData", metrics), true), 6);
	// Browser beacons arrive as text/plain.
	const beacon = { version: 1, events: [{ type: "exception" }, { type: "message" }] };
	assert.equal(recordsInBody("/v1/browser", beacon, false), 2);
	assert.equal(recordsInBody("/v1/browser", JSON.stringify(beacon), false), 2);
	assert.equal(recordsInBody("/v1/browser", "{not json", false), 0);
	// One record per upload / event; checks and unknown routes carry none.
	assert.equal(recordsInBody("/v1/sourcemaps", undefined, false), 1);
	assert.equal(recordsInBody("/v1/platform-events", {}, false), 1);
	assert.equal(recordsInBody("/v1/sourcemaps/check", { files: [{}] }, false), 0);
	assert.equal(recordsInBody("other", spans, false), 0);
	// Garbage is 0, never a throw.
	assert.equal(recordsInBody("/v1/traces", { resourceSpans: "x" }, false), 0);
	assert.equal(recordsInBody("/v1/traces", null, false), 0);
	assert.equal(recordsInBody("/v1/traces", Buffer.from([0x0a, 0xff, 0xff]), true), 0);
});

test("the wire-format count agrees with the decoder on real exporter bodies", () => {
	for (const fixture of ["django-unhandled", "fastapi-exception-group", "celery-task-failures"]) {
		const body = readFileSync(new URL(`../test-fixtures/python/${fixture}.otlp.pb`, import.meta.url));
		const decoded = decodeTraceRequest(body);
		const spans = (decoded.resourceSpans ?? []).flatMap((r) => (r.scopeSpans ?? []).flatMap((s) => s.spans ?? []));
		assert.ok(spans.length > 0, fixture);
		assert.equal(countProtoPath(body, [[1], [2], [2]]), spans.length, fixture);
	}
	// Truncated or malformed: null, not a guess.
	assert.equal(countProtoPath(Buffer.from([0x0a, 0x05, 0x12]), [[1], [2]]), null);
	assert.equal(countProtoPath(Buffer.from([0x0b]), [[1]]), null); // group wire type
	assert.equal(countProtoPath(Buffer.alloc(0), [[1]]), 0);
});

test("cumulative HTTP duration histograms are counted as the rollups skip them", () => {
	const metric = (name: string, aggregationTemporality: number | string, points: number) => ({
		name, histogram: { aggregationTemporality, dataPoints: Array.from({ length: points }, () => ({ count: "1" })) },
	});
	const request = { resourceMetrics: [{ scopeMetrics: [{ metrics: [
		metric("http.server.duration", 2, 2),
		metric("http.server.request.duration", "AGGREGATION_TEMPORALITY_CUMULATIVE", 1),
		metric("http.server.duration", 1, 5), // delta: stored
		metric("db.client.duration", 2, 4), // not an instrument the ingester reads: ignored, not rejected
	] }] }] };
	assert.equal(cumulativeHttpHistogramPoints(request), 3);
	assert.equal(cumulativeHttpHistogramPoints({}), 0);
});

test("partial success sums the rejections and joins their reasons; nothing rejected is null", () => {
	assert.equal(partialSuccess([{ rejected: 0, message: "x" }]), null);
	assert.deepEqual(partialSuccess([
		{ rejected: 2, message: "two." },
		{ rejected: 0, message: "none." },
		{ rejected: 3, message: "three." },
	]), { rejected: 5, errorMessage: "two. three." });
});

// ── what the normalisers report ───────────────────────────────────────────

test("attribute truncation is counted per call; redaction is not truncation", () => {
	const { truncated: none } = countTruncations(() =>
		sanitizeRuntimeContext({ password: "secret", url: "https://x.test/a?token=1", note: "short" }),
	);
	assert.equal(none, 0);
	const { result, truncated } = countTruncations(() =>
		decodeOtlpAttributes([
			{ key: "long", value: { stringValue: "x".repeat(3000) } },
			{ key: "list", value: { arrayValue: { values: Array.from({ length: 70 }, () => ({ intValue: 1 })) } } },
			...Array.from({ length: 130 }, (_, i) => ({ key: `k${i}`, value: { stringValue: "v" } })),
		]),
	);
	assert.equal(String(result.long).length, 2048);
	// 1 string cut + 6 list items + 4 attributes past 128 (132 in all, 128 kept).
	assert.equal(truncated, 1 + 6 + 4);
	// Nesting past 6 levels.
	const deep: Record<string, unknown> = {};
	let node = deep;
	for (let i = 0; i < 9; i++) node = (node.child = {}) as Record<string, unknown>;
	assert.ok(countTruncations(() => sanitizeRuntimeContext(deep)).truncated >= 1);
});

test("memory points out of range, without an instance, or past the limit are reported", () => {
	const now = String(BigInt(Date.now()) * 1_000_000n);
	const resource = (instance: boolean) => ({ attributes: [
		{ key: "service.name", value: { stringValue: "api" } },
		...(instance ? [{ key: "service.instance.id", value: { stringValue: "i-1" } }] : []),
	] });
	const gauge = (points: Array<{ asDouble: number; timeUnixNano: string }>, unit = "By") =>
		({ name: "process.runtime.nodejs.memory.heap.used", unit, gauge: { dataPoints: points } });
	const stats = { invalid: 0, overLimit: 0 };
	const samples = normalizeMemoryMetrics({ resourceMetrics: [
		{ resource: resource(true), scopeMetrics: [{ metrics: [
			gauge([{ asDouble: 10, timeUnixNano: now }, { asDouble: -1, timeUnixNano: now }, { asDouble: 5, timeUnixNano: "1" }]),
			gauge([{ asDouble: 10, timeUnixNano: now }], "s"),
		] }] },
		{ resource: resource(false), scopeMetrics: [{ metrics: [gauge([{ asDouble: 10, timeUnixNano: now }])] }] },
	] } as Parameters<typeof normalizeMemoryMetrics>[0], stats);
	assert.equal(samples.length, 1);
	// Negative value, 1970 timestamp, wrong unit, and the resource without an instance id.
	assert.equal(stats.invalid, 4);
	const many = normalizeMemoryMetrics({ resourceMetrics: [{ resource: resource(true), scopeMetrics: [{ metrics: [
		gauge(Array.from({ length: 5003 }, () => ({ asDouble: 1, timeUnixNano: now }))),
	] }] }] } as Parameters<typeof normalizeMemoryMetrics>[0], stats);
	assert.equal(many.length, 5000);
	assert.equal(stats.overLimit, 3);
});

test("profile samples past the first 1000 are reported", () => {
	const type = protobuf.parse(`syntax = "proto3";
		message Profile { repeated ValueType sample_type = 1; repeated Sample sample = 2;
			repeated Location location = 4; repeated Function function = 5; repeated string string_table = 6; }
		message ValueType { int64 type = 1; int64 unit = 2; }
		message Sample { repeated uint64 location_id = 1 [packed=true]; repeated int64 value = 2 [packed=true]; }
		message Location { uint64 id = 1; repeated Line line = 4; }
		message Line { uint64 function_id = 1; }
		message Function { uint64 id = 1; int64 name = 2; }`).root.lookupType("Profile");
	const body = Buffer.from(type.encode(type.create({ sampleType: [{ type: 1, unit: 2 }],
		sample: Array.from({ length: 1004 }, () => ({ locationId: [1], value: [5] })), location: [{ id: 1, line: [{ functionId: 1 }] }],
		function: [{ id: 1, name: 3 }], stringTable: ["", "cpu", "samples", "checkout"] })).finish());
	const stats = { overLimit: 0 };
	const samples = decodeProfile(body, { service: "api", environment: "prod", release: "", traceId: "", instanceId: "" }, stats);
	assert.equal(samples.length, 1000);
	assert.equal(stats.overLimit, 4);
});

test("browser events are validated one by one: a bad one is dropped, not the beacon", () => {
	const at = new Date().toISOString();
	const parsed = parseBrowserPayload({
		version: 1, service: "web", environment: "production",
		events: [
			{ type: "exception", timestamp: at, message: "boom" },
			{ type: "brand_new_event", timestamp: at },
			{ type: "message", timestamp: "yesterday" },
			{ type: "session_start", timestamp: at },
		],
	});
	assert.ok(parsed.success);
	assert.deepEqual(parsed.data.payload.events.map((e) => e.type), ["exception", "session_start"]);
	assert.equal(parsed.data.invalidEvents, 2);
	assert.equal(parsed.data.overLimitEvents, 0);
	assert.deepEqual(parsed.data.issues.map((issue) => issue.path.slice(0, 2)), [["events", 1], ["events", 2]]);

	const over = parseBrowserPayload({
		version: 1, service: "web", environment: "production",
		events: Array.from({ length: MAX_BROWSER_EVENTS + 7 }, () => ({ type: "session_start", timestamp: at })),
	});
	assert.ok(over.success);
	assert.equal(over.data.payload.events.length, MAX_BROWSER_EVENTS);
	assert.equal(over.data.overLimitEvents, 7);

	// The envelope is still all or nothing.
	const bad = parseBrowserPayload({ version: 2, service: "web", environment: "production", events: [] });
	assert.equal(bad.success, false);
	assert.equal(parseBrowserPayload({ version: 1, service: "", environment: "e", events: [] }).success, false);
	assert.equal(parseBrowserPayload({ version: 1, service: "web", environment: "e", events: "x" }).success, false);
});

test("in-app frame resolution: resolved, and JS frames a map would resolve", () => {
	const frame = (filename: string, inApp: boolean, resolved: boolean): StackFrame =>
		({ function: null, module: null, filename, lineno: 1, colno: 1, inApp, resolved });
	assert.deepEqual(inAppFrameResolution([
		frame("src/checkout/total.ts", true, true),
		frame("https://app.test/assets/index-5f3a.js", true, false),
		frame("https://app.test/assets/chunk.mjs", true, false),
		frame("node_modules/react-dom/cjs/react-dom.js", false, true), // a map moved it out of the app
		frame("https://cdn.test/vendor.js", false, false),
		frame("https://app.test/page.html", true, false), // inline script: no map would resolve it
	]), { resolved: 1, unresolved: 2 });
	assert.deepEqual(inAppFrameResolution(undefined), { resolved: 0, unresolved: 0 });
});

// ── the sink ──────────────────────────────────────────────────────────────

test("sink batches given up on are reported with their tenant and occurrence count", async () => {
	const config = { ...loadConfig(), sinkUrl: "http://sink.test/runtime", sinkMaxAttempts: 2, sinkMaxBufferedBatches: 1, sinkMaxBufferedMb: 1 };
	let status = 400;
	const sink = new SinkForwarder(config, (async () => new Response("", { status })) as typeof fetch, {
		retryBaseMs: 1, retryCapMs: 1, healthyConcurrency: 1,
	});
	const dropsSeen: SinkDrop[] = [];
	sink.onDrop = (drop) => dropsSeen.push(drop);
	const ctx = { orgId: "o", repositoryId: "r", scope: "server" as const, allowedOrigins: [] };
	const occurrence = (id: string) => ({
		source: "server" as const, severity: "error" as const, service: "api", environment: "prod", release: null,
		errorType: "Error", message: "x", stack: null, route: null, method: null, statusCode: null, traceId: null,
		sessionId: null, attributes: null, occurredAt: new Date(), occurrenceId: id, fingerprint: id,
		fingerprintScheme: "message-v1" as const, routeNormalized: "", messageNormalized: "", topFrames: [], firstFrame: "",
	});
	const waitFor = async (n: number) => {
		for (let i = 0; i < 200 && dropsSeen.length < n; i++) await new Promise((r) => setTimeout(r, 5));
	};
	sink.enqueue(ctx, [occurrence("a"), occurrence("b")]);
	await waitFor(1);
	assert.deepEqual(dropsSeen[0], { orgId: "o", repositoryId: "r", reason: "sink_rejected", occurrences: 2 });
	status = 503;
	sink.enqueue(ctx, [occurrence("c")]);
	await waitFor(2);
	assert.deepEqual(dropsSeen[1], { orgId: "o", repositoryId: "r", reason: "sink_gave_up", occurrences: 1 });
	// A hook that throws never affects delivery.
	sink.onDrop = () => {
		throw new Error("boom");
	};
	sink.enqueue(ctx, [occurrence("d")]);
	await new Promise((r) => setTimeout(r, 30));
	sink.stop();
});

// ── migrations ────────────────────────────────────────────────────────────

test("migrations 0018-0020 follow 0017, are idempotent, and the baseline matches them", async () => {
	const ids = MIGRATIONS.map((m) => m.id);
	assert.deepEqual(ids.slice(-4), [
		"0017-source-maps-debug-id",
		"0018-runtime-ingest-drops",
		"0019-sdk-versions-via",
		"0020-occurrence-frame-resolution",
	]);
	for (const migration of MIGRATIONS.slice(-3)) {
		assert.ok(migration.statements.length > 0, migration.id);
		for (const statement of migration.statements) assert.match(statement, /IF NOT EXISTS/, migration.id);
	}
	const byId = (id: string) => MIGRATIONS.find((m) => m.id === id)!.statements.join("\n");
	assert.equal(byId("0018-runtime-ingest-drops"), ingestDropsTableDDL("{db}"));
	assert.match(ingestDropsTableDDL("db"), /SummingMergeTree\(\(requests, records\)\)/);
	assert.match(ingestDropsTableDDL("db"), /ORDER BY \(org_id, repository_id, minute, route, reason, kind, status, key_hash\)/);
	assert.match(byId("0019-sdk-versions-via"), /ALTER TABLE \{db\}\.runtime_sdk_versions ADD COLUMN IF NOT EXISTS via LowCardinality\(String\) DEFAULT ''/);
	assert.match(byId("0020-occurrence-frame-resolution"), /in_app_frames_resolved UInt16 DEFAULT 0/);
	assert.match(byId("0020-occurrence-frame-resolution"), /in_app_frames_unresolved UInt16 DEFAULT 0/);

	// What ensureSchema sends to ClickHouse: the baseline (fresh databases)
	// has the same table and columns the migrations add (existing ones).
	const sent: string[] = [];
	const store = new ClickHouseStore({ ...loadConfig(), clickhouseUrl: "http://clickhouse.test" });
	(store as unknown as { getClient: () => unknown }).getClient = () => ({
		command: async ({ query }: { query: string }) => void sent.push(query),
		query: async () => ({ json: async () => MIGRATIONS.slice(0, -3).map((m) => ({ id: m.id })) }),
		insert: async ({ values }: { values: Array<{ id: string }> }) => void sent.push(`applied ${values[0]!.id}`),
	});
	await store.ensureSchema();
	const baselineDrops = sent.find((q) => /CREATE TABLE IF NOT EXISTS autter_runtime\.runtime_ingest_drops/.test(q));
	assert.ok(baselineDrops, "baseline creates runtime_ingest_drops");
	assert.match(sent.find((q) => /CREATE TABLE IF NOT EXISTS autter_runtime\.runtime_sdk_versions/.test(q))!, /via LowCardinality\(String\) DEFAULT ''/);
	const occurrences = sent.find((q) => /CREATE TABLE IF NOT EXISTS autter_runtime\.runtime_error_occurrences/.test(q))!;
	assert.match(occurrences, /in_app_frames_resolved UInt16 DEFAULT 0/);
	assert.match(occurrences, /in_app_frames_unresolved UInt16 DEFAULT 0/);
	// Only the three unapplied migrations run, in order, each recorded.
	assert.deepEqual(sent.filter((q) => q.startsWith("applied ")), [
		"applied 0018-runtime-ingest-drops",
		"applied 0019-sdk-versions-via",
		"applied 0020-occurrence-frame-resolution",
	]);
	assert.ok(sent.some((q) => q === ingestDropsTableDDL("autter_runtime")));
	assert.equal(store.schemaStatus().status, "ready");
});
