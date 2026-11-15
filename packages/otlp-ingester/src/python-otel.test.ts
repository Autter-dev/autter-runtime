import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { IngesterConfig } from "./config.js";
import { frameToken, occurrenceIdentity } from "./fingerprint-v3.js";
import { normalizeMetrics, normalizeTraces, type OtlpMetricsRequest, type OtlpTraceRequest } from "./normalize-otlp.js";
import { decodeTraceRequest } from "./otlp-proto.js";
import { createIngesterApp } from "./server.js";
import { parseStackFrames } from "./stack-frames.js";
import type { RuntimeMetricPoint, RuntimeOccurrenceInput, StackFrame } from "./types.js";

/**
 * EI-25: what Python services on plain OpenTelemetry really send. The
 * fixtures in test-fixtures/python are the OTLP/HTTP protobuf bodies the
 * recipes in examples/python exported (Django, FastAPI, Flask, Celery, with
 * adapters/python/autter_tracing.py), each trace's spans in one request,
 * local paths replaced; `<name>.otlp.json` is the same request as OTLP/JSON.
 * The `<framework>.expect.json` files were written by the recipes' tests:
 * the expected in-app frames come from `# frame:` markers in the recipes'
 * source, not from the parser under test.
 * Regenerate: AUTTER_CAPTURE_FIXTURES=<this dir> python -m unittest in each
 * examples/python/<framework> directory.
 *
 * `fastapi-testclient*.otlp.*`: the FastAPI recipe app exercised in-process
 * through `fastapi.testclient.TestClient`, as a test suite does, with no
 * environment and with `deployment.environment=staging`; recorded by
 * test-fixtures/python/record_fastapi_testclient.py (no expectations file).
 */

const FIXTURES = new URL("../test-fixtures/python/", import.meta.url);

interface ExpectedFrame {
	function: string;
	filename: string;
	lineno: number;
}

interface Scenario {
	fixture: string;
	description: string;
	tailRetained: boolean;
	occurrences: number;
	mergedRecordings?: number;
	errorType: string;
	message?: string;
	route?: string;
	statusCode?: number;
	severity: string;
	handled?: boolean;
	requestCount?: number;
	errorCount?: number;
	inAppFrames?: ExpectedFrame[];
	groups?: Record<string, { occurrences: number; inAppFrames: ExpectedFrame[] }>;
}

interface Expectations {
	framework: string;
	captured: { python: string; packages: Record<string, string> };
	scenarios: Record<string, Scenario>;
}

const expectations: Expectations[] = readdirSync(FIXTURES)
	.filter((name) => name.endsWith(".expect.json"))
	.sort()
	.map((name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Expectations);

function loadJson(fixture: string): OtlpTraceRequest {
	return JSON.parse(readFileSync(new URL(`${fixture}.otlp.json`, FIXTURES), "utf8")) as OtlpTraceRequest;
}

function loadProto(fixture: string): Buffer {
	return readFileSync(new URL(`${fixture}.otlp.pb`, FIXTURES));
}

function inApp(frames: StackFrame[]): ExpectedFrame[] {
	return frames
		.filter((frame) => frame.inApp)
		.map((frame) => ({ function: frame.function!, filename: frame.filename!, lineno: frame.lineno! }));
}

function sums(points: RuntimeMetricPoint[]) {
	return points.reduce(
		(acc, p) => ({ requestCount: acc.requestCount + p.requestCount, errorCount: acc.errorCount + p.errorCount }),
		{ requestCount: 0, errorCount: 0 },
	);
}

function v3Parts(occurrence: RuntimeOccurrenceInput) {
	const frames = parseStackFrames(occurrence.stack);
	return occurrenceIdentity(occurrence, frames);
}

/** Every fixture's frames: in-app = the app's files, never site-packages or the stdlib. */
function assertDependencyFramesExcluded(frames: StackFrame[], handled: boolean) {
	for (const frame of frames) {
		if (/\/site-packages\/|^\/usr\/local\/lib\/python3\.\d+\//.test(frame.filename ?? "")) {
			assert.equal(frame.inApp, false, frame.filename!);
		} else {
			assert.match(frame.filename ?? "", /^\/srv\/app\//);
			assert.equal(frame.inApp, true, frame.filename!);
		}
	}
	// An unhandled error crossed the framework on its way out; a handled one
	// was caught in the app, so its traceback starts there.
	if (!handled) assert.ok(frames.some((frame) => !frame.inApp), "no dependency frames to exclude");
}

test("python fixtures: every recipe captured its scenarios", () => {
	assert.deepEqual(expectations.map((e) => e.framework), ["celery", "django", "fastapi", "flask"]);
	for (const e of expectations) {
		assert.match(e.captured.packages["opentelemetry-sdk"]!, /^1\.\d+\.\d+$/);
		assert.ok(Object.keys(e.scenarios).length >= 2, e.framework);
	}
});

for (const { framework, scenarios } of expectations) {
	describe(`python ${framework} (real OTel export)`, () => {
		for (const [name, scenario] of Object.entries(scenarios)) {
			test(`${name}: ${scenario.description}`, () => {
				const request = loadJson(scenario.fixture);
				const result = normalizeTraces(request);
				const { occurrences } = result;
				assert.equal(occurrences.length, scenario.occurrences);

				// The wire format the Python exporter used decodes to the same thing.
				const fromProto = normalizeTraces(decodeTraceRequest(loadProto(scenario.fixture)));
				assert.deepEqual(
					fromProto.occurrences.map((o) => [o.errorType, o.message, o.stack, o.route, o.statusCode, o.traceId]),
					occurrences.map((o) => [o.errorType, o.message, o.stack, o.route, o.statusCode, o.traceId]),
				);
				assert.deepEqual(fromProto.metricPoints, result.metricPoints);

				for (const span of result.spans) {
					assert.equal(span.attributes?.["autter.tail_retained"] === true, scenario.tailRetained, span.name);
				}

				for (const occurrence of occurrences) {
					assert.equal(occurrence.source, "server");
					assert.equal(occurrence.errorType, scenario.errorType);
					assert.equal(occurrence.severity, scenario.severity);
					assert.equal(occurrence.release, "9c1e4f2a7b3d");
					assert.equal(occurrence.environment, "test");
					if (scenario.message !== undefined) assert.equal(occurrence.message, scenario.message);
					if (scenario.route !== undefined) assert.equal(occurrence.route, scenario.route);
					if (scenario.statusCode !== undefined) assert.equal(occurrence.statusCode, scenario.statusCode);
					assert.equal(occurrence.attributes?.["autter.handled"] === true, scenario.handled === true);
					if (scenario.mergedRecordings !== undefined) {
						assert.equal(occurrence.attributes?.["autter.merged_recordings"], scenario.mergedRecordings);
					}
					// The full traceback is kept as sent (scrubbed).
					assert.match(occurrence.stack ?? "", /Traceback \(most recent call last\):/);
					assert.doesNotMatch(occurrence.stack ?? "", /hunter2/);

					const frames = parseStackFrames(occurrence.stack);
					assertDependencyFramesExcluded(frames, scenario.handled === true);
				}

				if (scenario.inAppFrames) {
					const [occurrence] = occurrences;
					const frames = parseStackFrames(occurrence!.stack);
					// Innermost first, at the lines the source markers name.
					assert.deepEqual(inApp(frames), scenario.inAppFrames);
					// frames-v3 hashes exactly those frames (function@file).
					const identity = v3Parts(occurrence!);
					assert.deepEqual(identity.record?.parts, [
						scenario.errorType,
						...scenario.inAppFrames.map((f) => `${f.function}@${f.filename.split("/").pop()}`),
					]);
					// In-app frames exist, so the root-cause candidate follows (RF-06).
					assert.deepEqual(identity.candidates.map((c) => c.scheme), ["frames-v3", "message-v1", "cause-v1"]);
				}

				if (scenario.requestCount !== undefined) {
					assert.deepEqual(sums(result.metricPoints), {
						requestCount: scenario.requestCount,
						errorCount: scenario.errorCount,
					});
				}
			});
		}
	});
}

describe("python request counting and dedupe on real spans", () => {
	const django = expectations.find((e) => e.framework === "django")!.scenarios;

	test("a Django 500 recorded on the request span and on the app's own span is one occurrence, one error", () => {
		for (const name of ["unhandled", "unhandled-sampled"]) {
			const request = loadJson(django[name]!.fixture);
			const spans = request.resourceSpans!.flatMap((r) => r.scopeSpans!.flatMap((s) => s.spans!));
			const recordings = spans.flatMap((s) => (s.events ?? []).filter((e) => e.name === "exception"));
			assert.equal(recordings.length, 2, name);
			const result = normalizeTraces(request);
			assert.equal(result.occurrences.length, 1, name);
			// The kept recording is the request span's, with its route and status.
			assert.equal(result.occurrences[0]!.statusCode, 500, name);
			assert.deepEqual(sums(result.metricPoints), { requestCount: name.includes("sampled") ? 1 : 0, errorCount: 1 }, name);
		}
	});

	test("head-sampled vs tail-retained: the request span feeds the request rollup only when sampled", () => {
		const sampled = normalizeTraces(loadJson(django["unhandled-sampled"]!.fixture));
		const retained = normalizeTraces(loadJson(django.unhandled!.fixture));
		// Same totals either way: a sampled request counts once with its error
		// riding it; a retained one is not a traffic sample, its error counts
		// once as an event on the same route.
		assert.deepEqual(sums(sampled.metricPoints), { requestCount: 1, errorCount: 1 });
		assert.deepEqual(sums(retained.metricPoints), { requestCount: 0, errorCount: 1 });
		assert.deepEqual(sampled.metricPoints.map((p) => p.route), ["orders/<int:order_id>/charge"]);
		assert.deepEqual(retained.metricPoints.map((p) => p.route), ["orders/<int:order_id>/charge"]);
		assert.ok(sampled.metricPoints[0]!.durationSumMs > 0, "a sampled request carries its latency");
		assert.equal(retained.metricPoints[0]!.durationSumMs, 0, "a retained one does not");
	});

	test("FastAPI: the errored 'http send' span without an exception is dropped as part of the request's error", () => {
		const fastapi = expectations.find((e) => e.framework === "fastapi")!.scenarios;
		const request = loadJson(fastapi.unhandled!.fixture);
		const spans = request.resourceSpans!.flatMap((r) => r.scopeSpans!.flatMap((s) => s.spans!));
		const statusOnly = spans.filter((s) => s.status?.code === "STATUS_CODE_ERROR" && !(s.events ?? []).some((e) => e.name === "exception"));
		assert.equal(statusOnly.length, 1);
		assert.match(statusOnly[0]!.name!, / http send$/);
		const { occurrences } = normalizeTraces(request);
		assert.deepEqual(occurrences.map((o) => o.errorType), ["inventory.OutOfStock"]);
	});

	test("Celery: task errors group per task by frames-v3; one task failing twice is one group", () => {
		const celery = expectations.find((e) => e.framework === "celery")!.scenarios["task-failures"]!;
		const { occurrences, metricPoints } = normalizeTraces(loadJson(celery.fixture));
		const byFingerprint = new Map<string, RuntimeOccurrenceInput[]>();
		for (const occurrence of occurrences) {
			const fingerprint = v3Parts(occurrence).candidates[0]!.fingerprint;
			byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) ?? []), occurrence]);
		}
		assert.equal(byFingerprint.size, Object.keys(celery.groups!).length);
		for (const [task, group] of Object.entries(celery.groups!)) {
			const members = [...byFingerprint.values()].find((list) =>
				list.every((o) => o.attributes?.["celery.task_name"] === task));
			assert.ok(members, task);
			assert.equal(members.length, group.occurrences, task);
			for (const occurrence of members) {
				assert.deepEqual(inApp(parseStackFrames(occurrence.stack)), group.inAppFrames, task);
				assert.equal(occurrence.route, null, "a task has no HTTP route");
			}
		}
		// The messages differ by order id; the group does not.
		const ship = [...byFingerprint.values()].find((list) => list.length === 2)!;
		assert.notEqual(ship[0]!.message, ship[1]!.message);
		// Consumer spans are not requests: each failure is one error event.
		assert.deepEqual(sums(metricPoints), { requestCount: 0, errorCount: 3 });
	});

	test("an exception group is parsed to its own frames, not its sub-exceptions'", () => {
		const fastapi = expectations.find((e) => e.framework === "fastapi")!.scenarios;
		const scenario = fastapi["exception-group"];
		if (!scenario) return; // captured on Python 3.11+ only
		const [occurrence] = normalizeTraces(loadJson(scenario.fixture)).occurrences;
		assert.match(occurrence!.stack!, /\+ Exception Group Traceback/);
		assert.match(occurrence!.stack!, /ConnectionError: warehouse north unreachable/);
		const frames = parseStackFrames(occurrence!.stack);
		assert.equal(frames[0]!.function, "_aexit");
		assert.match(frames[0]!.filename!, /asyncio\/taskgroups\.py$/);
		assert.equal(frames[0]!.inApp, false);
		assert.ok(!frames.some((f) => f.function === "check_warehouse"), "sub-exception frames are not the group's");
		assert.deepEqual(frames.filter((f) => f.inApp).map(frameToken), ["availability@app.py"]);
	});
});

// ── FastAPI's TestClient: test traffic stored as environment `test` ───────

type OtlpAttributeList = NonNullable<NonNullable<OtlpTraceRequest["resourceSpans"]>[number]["resource"]>["attributes"];

/** `request` with `keys` removed from every span's attributes and the resource's. */
function withoutAttributes(request: OtlpTraceRequest, keys: string[]): OtlpTraceRequest {
	const strip = (list: OtlpAttributeList) => list?.filter((kv) => !keys.includes(kv.key ?? ""));
	return {
		resourceSpans: request.resourceSpans?.map((rs) => ({
			resource: { attributes: strip(rs.resource?.attributes) },
			scopeSpans: rs.scopeSpans?.map((ss) => ({
				spans: ss.spans?.map((span) => ({ ...span, attributes: strip(span.attributes) })),
			})),
		})),
	};
}

describe("python fastapi TestClient (real OTel export)", () => {
	const environments = (result: ReturnType<typeof normalizeTraces>) => ({
		spans: [...new Set(result.spans.map((s) => s.environment))],
		occurrences: result.occurrences.map((o) => o.environment),
		rollups: [...new Set(result.metricPoints.map((p) => p.environment))],
	});

	test("what TestClient sends: user agent `testclient`, host `testserver`, no environment", () => {
		const request = loadJson("fastapi-testclient");
		const resource = request.resourceSpans!.flatMap((rs) => rs.resource?.attributes ?? []).map((kv) => kv.key);
		assert.ok(!resource.includes("deployment.environment") && !resource.includes("deployment.environment.name"));
		const servers = request.resourceSpans!.flatMap((rs) => rs.scopeSpans!.flatMap((ss) => ss.spans!)).filter((s) => s.kind === "SPAN_KIND_SERVER");
		assert.equal(servers.length, 2);
		for (const span of servers) {
			const attrs = Object.fromEntries((span.attributes ?? []).map((kv) => [kv.key, kv.value?.stringValue]));
			assert.equal(attrs["http.user_agent"], "testclient");
			assert.equal(attrs["http.host"], "testserver");
			assert.equal(attrs["http.server_name"], "testserver");
		}
	});

	test("no environment: occurrences, spans and rollups are stored as `test`, from JSON and protobuf", () => {
		for (const result of [normalizeTraces(loadJson("fastapi-testclient")), normalizeTraces(decodeTraceRequest(loadProto("fastapi-testclient")))]) {
			assert.deepEqual(environments(result), { spans: ["test"], occurrences: ["test", "test"], rollups: ["test"] });
			assert.deepEqual(result.occurrences.map((o) => o.errorType).sort(), ["inventory.OutOfStock", "inventory.PricingTimeout"]);
			for (const occurrence of result.occurrences) assert.equal(occurrence.attributes?.["autter.test_client"], true);
		}
	});

	test("without the user agent (adapters/python 1.19.0 drops it before export) the host alone still classifies", () => {
		const result = normalizeTraces(withoutAttributes(loadJson("fastapi-testclient"), ["http.user_agent", "user_agent.original"]));
		assert.deepEqual(environments(result), { spans: ["test"], occurrences: ["test", "test"], rollups: ["test"] });
		// Neither user agent nor host: nothing says test, so production as before.
		const neither = normalizeTraces(withoutAttributes(loadJson("fastapi-testclient"), ["http.user_agent", "http.host", "http.server_name"]));
		assert.deepEqual(environments(neither), { spans: ["production"], occurrences: ["production", "production"], rollups: ["production"] });
	});

	test("deployment.environment=staging: unchanged, `staging`", () => {
		for (const result of [normalizeTraces(loadJson("fastapi-testclient-staging")), normalizeTraces(decodeTraceRequest(loadProto("fastapi-testclient-staging")))]) {
			assert.deepEqual(environments(result), { spans: ["staging"], occurrences: ["staging", "staging"], rollups: ["staging"] });
		}
	});

	test("a normal request (uvicorn, a real client) with no environment stays `production`", () => {
		const fastapi = expectations.find((e) => e.framework === "fastapi")!.scenarios;
		const request = withoutAttributes(loadJson(fastapi.unhandled!.fixture), ["deployment.environment"]);
		const result = normalizeTraces(request);
		assert.deepEqual(environments(result), { spans: ["production"], occurrences: ["production"], rollups: ["production"] });
		assert.equal(result.occurrences[0]!.attributes?.["autter.test_client"], undefined);
	});
});

// ── The recommended rate: 1% head sampling, 2% of requests failing ────────

/**
 * What `init_tracing()` sent for 5,000 requests through a WSGI app at
 * `parentbased_traceidratio` 0.01 with every 50th request failing (a 500),
 * captured by adapters/python/test_autter_tracing.py (RecommendedSamplingRate):
 * with request counting on (the default) and off (`AUTTER_COUNT_REQUESTS=false`).
 * Regenerate: AUTTER_CAPTURE_FIXTURES=<this dir> python -m unittest
 * test_autter_tracing.RecommendedSamplingRate in adapters/python.
 */
interface SamplingFixture {
	requests: number;
	failed: number;
	traces: OtlpTraceRequest;
	metrics: OtlpMetricsRequest;
}

function loadSampling(name: "counted" | "uncounted"): SamplingFixture {
	return JSON.parse(gunzipSync(readFileSync(new URL(`sampling-1pct-${name}.json.gz`, FIXTURES))).toString("utf8")) as SamplingFixture;
}

function storedRate(points: RuntimeMetricPoint[]) {
	const { requestCount, errorCount } = sums(points);
	return { requestCount, errorCount, errorRate: errorCount / requestCount };
}

describe("python at 1% sampling: the stored error rate", () => {
	test("with request counting (the default): every request counted, error rate 2%", () => {
		const fixture = loadSampling("counted");
		const traces = normalizeTraces(fixture.traces);
		// Every failure reached the ingester, sampled or not.
		assert.equal(traces.occurrences.length, fixture.failed);
		const stored = storedRate([...traces.metricPoints, ...normalizeMetrics(fixture.metrics)]);
		assert.deepEqual(stored, { requestCount: fixture.requests, errorCount: fixture.failed, errorRate: 0.02 });
	});

	test("without it: requests are the 1% sample, so the same errors read as a rate about 100 times too high", () => {
		const fixture = loadSampling("uncounted");
		assert.deepEqual(fixture.metrics.resourceMetrics, []);
		const traces = normalizeTraces(fixture.traces);
		assert.equal(traces.occurrences.length, fixture.failed);
		const stored = storedRate(traces.metricPoints);
		assert.equal(stored.errorCount, fixture.failed);
		// About 1% of 5,000 requests were head-sampled and counted.
		assert.ok(stored.requestCount > 25 && stored.requestCount < 75, String(stored.requestCount));
		assert.ok(stored.errorRate > 1, `error rate ${stored.errorRate}`);
	});
});

// ── Over the wire: the exact protobuf body the Python exporter posted ─────

const KEY = "autter_rt_recipe_test_key_0001";
let chStub: Server;
let sinkServer: Server;
let appServer: Server;
let ingestUrl: string;
const sinkBatches: Array<Record<string, any>> = [];

before(async () => {
	sinkServer = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			sinkBatches.push(JSON.parse(body));
			res.writeHead(202).end();
		});
	});
	await new Promise<void>((resolve) => sinkServer.listen(0, resolve));
	chStub = createServer((req, res) => {
		req.resume();
		req.on("end", () => res.writeHead(200).end());
	});
	await new Promise<void>((resolve) => chStub.listen(0, resolve));
	const config: IngesterConfig = {
		port: 0,
		clickhouseUrl: `http://127.0.0.1:${(chStub.address() as AddressInfo).port}`,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [{ key: KEY, orgId: "org-py", repositoryId: "repo-py" }],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: `http://127.0.0.1:${(sinkServer.address() as AddressInfo).port}/runtime/sink`,
		sinkToken: null,
		sinkMaxAttempts: 3,
		sinkMaxBufferedBatches: 100,
		sinkMaxBufferedMb: 16,
		maxBodyBytes: 1024 * 1024,
		rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
		logTtlDays: 14,
	};
	const { app } = createIngesterApp(config);
	appServer = app.listen(0);
	await new Promise((resolve) => appServer.once("listening", resolve));
	ingestUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

after(() => {
	sinkServer.close();
	appServer.close();
	chStub.close();
});

test("a Django 500 posted as the Python exporter posts it reaches the sink with its full stack", async () => {
	const django = expectations.find((e) => e.framework === "django")!.scenarios.unhandled!;
	const seen = sinkBatches.length;
	const res = await fetch(`${ingestUrl}/v1/traces`, {
		method: "POST",
		// The OTLP/HTTP exporter's request: protobuf, key from OTEL_EXPORTER_OTLP_HEADERS.
		headers: { "content-type": "application/x-protobuf", "x-autter-key": KEY },
		body: new Uint8Array(loadProto(django.fixture)),
	});
	assert.equal(res.status, 200);
	const deadline = Date.now() + 5000;
	while (sinkBatches.length <= seen) {
		if (Date.now() > deadline) throw new Error("sink batch never arrived");
		await new Promise((r) => setTimeout(r, 10));
	}
	const batch = sinkBatches[seen]!;
	assert.equal(batch.orgId, "org-py");
	assert.equal(batch.occurrences.length, 1);
	const [occurrence] = batch.occurrences;
	assert.equal(occurrence.service, "shop-django");
	assert.equal(occurrence.release, "9c1e4f2a7b3d");
	assert.equal(occurrence.errorType, "shop.payments.PaymentDeclined");
	assert.equal(occurrence.route, "orders/<int:order_id>/charge");
	assert.equal(occurrence.statusCode, 500);
	assert.match(occurrence.stack, /The above exception was the direct cause of the following exception:/);
	assert.deepEqual(
		occurrence.frames.filter((f: StackFrame) => f.inApp).map((f: StackFrame) => [f.function, f.filename, f.lineno]),
		django.inAppFrames!.map((f) => [f.function, f.filename, f.lineno]),
	);
	assert.deepEqual(occurrence.fingerprints.map((c: { scheme: string }) => c.scheme), ["frames-v3", "message-v1", "cause-v1"]);
	assert.deepEqual(occurrence.fingerprintRecord, {
		scheme: "frames-v3",
		parts: ["shop.payments.PaymentDeclined", "charge_card@payments.py", "charge@views.py"],
	});
	assert.equal(occurrence.attributes["autter.merged_recordings"], 2);
	assert.deepEqual(
		batch.metrics.map((m: { requestCount: number; errorCount: number }) => [m.requestCount, m.errorCount]),
		[[0, 1]],
	);
});

async function postForSinkMetrics(path: string, body: unknown): Promise<RuntimeMetricPoint[]> {
	const seen = sinkBatches.length;
	const res = await fetch(`${ingestUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-autter-key": KEY },
		body: JSON.stringify(body),
	});
	assert.equal(res.status, 200, `${path}: ${await res.text()}`);
	const deadline = Date.now() + 5000;
	while (sinkBatches.length <= seen) {
		if (Date.now() > deadline) throw new Error(`no sink batch for ${path}`);
		await new Promise((r) => setTimeout(r, 10));
	}
	return sinkBatches[seen]!.metrics as RuntimeMetricPoint[];
}

test("1% sampling over the wire: the rollup the ingester stores reads 2% with counting, far more without", async () => {
	const counted = loadSampling("counted");
	const withCounting = storedRate([
		...(await postForSinkMetrics("/v1/traces", counted.traces)),
		...(await postForSinkMetrics("/v1/metrics", counted.metrics)),
	]);
	assert.deepEqual(withCounting, { requestCount: 5000, errorCount: 100, errorRate: 0.02 });

	const uncounted = loadSampling("uncounted");
	const without = storedRate(await postForSinkMetrics("/v1/traces", uncounted.traces));
	assert.equal(without.errorCount, 100);
	assert.ok(without.errorRate > 1, `error rate ${without.errorRate}`);
});
