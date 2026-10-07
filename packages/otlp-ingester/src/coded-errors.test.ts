import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ClickHouseStore } from "./clickhouse.js";
import type { IngesterConfig } from "./config.js";
import { liftErrorFields } from "./error-fields.js";
import {
	codeFingerprint,
	fingerprintOccurrence,
	normalizeMessage,
	normalizeRoute,
	normalizeStackFrames,
	occurrenceFingerprint,
	validErrorCode,
} from "./fingerprint.js";
import { logPromotionCandidates } from "./log-promotion.js";
import { logTableDDL, normalizeLogs, requestRollupViewDDL } from "./logs.js";
import { MIGRATIONS } from "./migrations.js";
import { normalizeBrowserPayload } from "./normalize-browser.js";
import { normalizeTraces } from "./normalize-otlp.js";
import { createIngesterApp } from "./server.js";
import { sinkOccurrence } from "./sink.js";
import type { RuntimeOccurrence, RuntimeOccurrenceInput } from "./types.js";

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const int = (key: string, value: number) => ({ key, value: { intValue: value } });
const bool = (key: string, value: boolean) => ({ key, value: { boolValue: value } });

// ── code-v1 fingerprint (shared vectors with the backend) ─────────────────

const CODE_VECTORS = [
	{ service: "payments-api", code: "billing.declined", fingerprint: "1692d304df5e4edbd3a0bbac5d7658bb" },
	{ service: "payments-api", code: "billing.limit", fingerprint: "be8302686d461915fb67bd28cdba26ba" },
	{ service: "web-app", code: "auth.session_expired", fingerprint: "b997fe46c7a61540917324f78b710d83" },
	{ service: "autter-api", code: "github.app_permission_missing", fingerprint: "ce80dc4c785f51a0851e99cd5dd1316f" },
];

function input(overrides: Partial<RuntimeOccurrenceInput> = {}): RuntimeOccurrenceInput {
	return {
		source: "server",
		severity: "error",
		service: "payments-api",
		environment: "prod",
		release: null,
		errorType: "RuntimeError",
		message: "Payment declined for order 42",
		stack: "Error: x\n    at charge (/app/billing.ts:10:3)",
		route: "/orders/42/pay",
		method: "POST",
		statusCode: 402,
		traceId: "a".repeat(32),
		sessionId: null,
		attributes: null,
		occurredAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

test("code-v1 fingerprints match the shared test vectors", () => {
	for (const vector of CODE_VECTORS) {
		assert.equal(codeFingerprint(vector.service, vector.code), vector.fingerprint);
	}
});

test("a valid code groups source-independently; uncoded errors keep message-v1 byte-for-byte", () => {
	const server = occurrenceFingerprint(input({ errorCode: "billing.declined" }));
	assert.deepEqual(server, { fingerprint: "1692d304df5e4edbd3a0bbac5d7658bb", scheme: "code-v1" });
	// Different source, message, stack and route: still the same issue.
	const browser = occurrenceFingerprint(
		input({ errorCode: "billing.declined", source: "browser", message: "other", stack: null, route: "/x" }),
	);
	assert.equal(browser.fingerprint, server.fingerprint);

	const legacy = input();
	const expected = createHash("sha256")
		.update(
			[
				legacy.source,
				legacy.service,
				legacy.errorType,
				normalizeMessage(legacy.message),
				...normalizeStackFrames(legacy.stack),
				normalizeRoute(legacy.route),
			].join(" "),
		)
		.digest("hex")
		.slice(0, 32);
	assert.deepEqual(occurrenceFingerprint(legacy), { fingerprint: expected, scheme: "message-v1" });
	// An invalid code falls back to the message fingerprint.
	assert.equal(fingerprintOccurrence(input({ errorCode: "ECONNRESET" })), expected);
});

test("validErrorCode enforces CODE_PATTERN and the 80-char cap", () => {
	for (const ok of ["billing.declined", "a", "a.b.c.d", "inventory.reservation_timeout", "x1.y_2"]) {
		assert.equal(validErrorCode(ok), ok);
	}
	for (const bad of ["ECONNRESET", "Billing.declined", "1abc", "a.b.c.d.e", "a..b", "a.", "a-b", "user.42@x", "", 42, null, "a" + "b".repeat(80)]) {
		assert.equal(validErrorCode(bad), undefined, String(bad));
	}
});

// ── declared error fields ─────────────────────────────────────────────────

test("declared fields are validated, scrubbed and capped independently", () => {
	const fields = liftErrorFields(
		new Map([
			["autter.error.code", "billing.declined"],
			["autter.error.why", "x".repeat(1500)],
			["autter.error.fix", "Email jane@example.com for help"],
			["autter.error.link", "https://user:pw@docs.example.com/payments?token=1#declined"],
			["autter.error.expected", "true"],
			["autter.request.id", "req_0123456789"],
		]),
	);
	assert.equal(fields.errorCode, "billing.declined");
	assert.equal(fields.why!.length, 1000);
	assert.equal(fields.fix, "Email [redacted] for help");
	assert.equal(fields.link, "https://docs.example.com/payments#declined");
	assert.equal(fields.expected, true);
	assert.equal(fields.requestId, "req_0123456789");

	const rejected = liftErrorFields({
		"autter.error.code": "Not A Code",
		"autter.error.link": "javascript:alert(1)",
		"autter.error.expected": "yes",
		"autter.request.id": "short",
	});
	assert.deepEqual(rejected, {});
	assert.equal(liftErrorFields({ "autter.error.link": `https://x.dev/${"a".repeat(600)}` }).link, undefined);
	// First source wins (exception event before its span).
	assert.equal(
		liftErrorFields({ "autter.error.code": "a.event" }, { "autter.error.code": "a.span" }).errorCode,
		"a.event",
	);
});

test("OTLP exception events lift codes, and child error spans inherit the request id", () => {
	const traceId = "c".repeat(32);
	const { occurrences } = normalizeTraces({
		resourceSpans: [
			{
				resource: { attributes: [str("service.name", "payments-api")] },
				scopeSpans: [
					{
						spans: [
							{
								traceId,
								spanId: "1".repeat(16),
								name: "POST /pay",
								kind: 2,
								startTimeUnixNano: "1760000000000000000",
								endTimeUnixNano: "1760000000100000000",
								attributes: [
									str("http.route", "/pay"),
									str("http.request.method", "POST"),
									int("http.response.status_code", 402),
									str("autter.request.id", "req_abcdefgh12"),
								],
							},
							{
								traceId,
								spanId: "2".repeat(16),
								parentSpanId: "1".repeat(16),
								name: "Error",
								startTimeUnixNano: "1760000000010000000",
								endTimeUnixNano: "1760000000020000000",
								attributes: [str("autter.error.code", "billing.span_level")],
								events: [
									{
										name: "exception",
										timeUnixNano: "1760000000015000000",
										attributes: [
											str("exception.type", "RuntimeError"),
											str("exception.message", "Payment declined"),
											str("autter.error.code", "billing.declined"),
											str("autter.error.why", "The issuer rejected the charge"),
											str("autter.error.fix", "Ask for another card"),
											str("autter.error.link", "https://docs.example.com/payments#declined"),
											bool("autter.error.expected", true),
										],
									},
								],
							},
						],
					},
				],
			},
		],
	});
	assert.equal(occurrences.length, 1);
	const [occ] = occurrences;
	assert.equal(occ!.errorCode, "billing.declined");
	assert.equal(occ!.why, "The issuer rejected the charge");
	assert.equal(occ!.fix, "Ask for another card");
	assert.equal(occ!.link, "https://docs.example.com/payments#declined");
	assert.equal(occ!.expected, true);
	assert.equal(occ!.requestId, "req_abcdefgh12");
	assert.equal(occ!.route, "/pay");
});

test("browser context keys become occurrence fields; context sanitiser keeps them", () => {
	const { occurrences } = normalizeBrowserPayload({
		version: 1,
		service: "web-app",
		environment: "prod",
		events: [
			{
				type: "exception",
				timestamp: "2026-01-01T00:00:00.000Z",
				message: "Session expired",
				context: {
					"autter.error.code": "auth.session_expired",
					"autter.error.why": "Token older than 24h",
					"autter.error.fix": "Sign in again",
					"autter.error.link": "https://docs.example.com/auth#expired",
					"autter.error.expected": true,
				},
			},
			{
				type: "request_failure",
				timestamp: "2026-01-01T00:00:01.000Z",
				name: "/api/checkout",
				message: "Request returned 503",
				errorType: "HttpRequestError",
				context: { "autter.request.id": "0f6c1d2e-aaaa-bbbb-cccc-000000000001", "autter.error.code": "BAD CODE" },
			},
		],
	});
	const [coded, failure] = occurrences;
	assert.equal(coded!.errorCode, "auth.session_expired");
	assert.equal(coded!.why, "Token older than 24h");
	assert.equal(coded!.fix, "Sign in again");
	assert.equal(coded!.link, "https://docs.example.com/auth#expired");
	assert.equal(coded!.expected, true);
	const context = coded!.attributes!.context as Record<string, unknown>;
	assert.equal(context["autter.error.code"], "auth.session_expired");
	assert.equal(context["autter.error.why"], "Token older than 24h");
	assert.equal(failure!.requestId, "0f6c1d2e-aaaa-bbbb-cccc-000000000001");
	assert.equal(failure!.errorCode, undefined);
	assert.equal(occurrenceFingerprint(coded!).fingerprint, "b997fe46c7a61540917324f78b710d83");
});

// ── runtime_logs lifting ──────────────────────────────────────────────────

test("request summaries lift kind, request id, route, status, code and AI rollup", () => {
	const [summary, legacyOp, plain] = normalizeLogs({
		resourceLogs: [
			{
				resource: { attributes: [str("service.name", "api")] },
				scopeLogs: [
					{
						logRecords: [
							{
								timeUnixNano: "1760000000000000000",
								body: { stringValue: "POST /orders/:id/pay" },
								attributes: [
									str("autter.event.type", "operation"),
									str("autter.operation.kind", "request"),
									str("autter.request.id", "req_abcdefgh12"),
									str("http.route", "/orders/123/pay?coupon=x"),
									str("http.request.method", "POST"),
									int("http.response.status_code", 402),
									str("autter.error.code", "billing.declined"),
									str("autter.operation.ai", JSON.stringify({ calls: 3, cost_usd: 0.0125, cache_read_tokens: 10 })),
								],
							},
							{
								timeUnixNano: "1760000000000000001",
								body: { stringValue: "sync" },
								attributes: [
									str("autter.event.type", "operation"),
									str("autter.error.code", "NOT_VALID"),
									str("autter.operation.ai.cost_usd", "0.5"),
									int("autter.operation.ai.calls", 2),
								],
							},
							{ timeUnixNano: "1760000000000000002", body: { stringValue: "hello" } },
						],
					},
				],
			},
		],
	});
	assert.equal(summary!.kind, "request");
	assert.equal(summary!.requestId, "req_abcdefgh12");
	assert.equal(summary!.route, "/orders/:id/pay");
	assert.equal(summary!.statusCode, 402);
	assert.equal(summary!.errorCode, "billing.declined");
	assert.equal(summary!.aiCalls, 3);
	assert.equal(summary!.aiCostUsd, 0.0125);
	assert.equal(
		(summary!.attributes["autter.operation.ai"] as Record<string, unknown>).cache_read_tokens,
		10,
	);
	assert.equal(summary!.occurrence, undefined);
	// 1.4.0 operation summaries (no kind) are "operation"; invalid codes drop.
	assert.equal(legacyOp!.kind, "operation");
	assert.equal(legacyOp!.errorCode, "");
	assert.equal(legacyOp!.aiCostUsd, 0.5);
	assert.equal(legacyOp!.aiCalls, 2);
	assert.equal(plain!.kind, "");
	assert.equal(plain!.route, "");
	assert.equal(plain!.statusCode, 0);
});

test("only logger-only error records with exception.* become promotion candidates", () => {
	const record = (attrs: ReturnType<typeof str>[], severityNumber = 17, traceId?: string) => ({
		timeUnixNano: "1760000000000000000",
		severityNumber,
		...(traceId ? { traceId } : {}),
		body: { stringValue: "failed" },
		attributes: attrs,
	});
	const mode = str("autter.capture.mode", "log");
	const exc = str("exception.message", "Payment declined");
	const rows = normalizeLogs({
		resourceLogs: [
			{
				resource: { attributes: [str("service.name", "edge-api")] },
				scopeLogs: [
					{
						logRecords: [
							record([mode, exc, str("exception.type", "RuntimeError"), str("autter.error.code", "billing.declined"),
								str("autter.error.link", "https://docs.example.com/p#declined"), str("http.route", "/pay")], 17, "d".repeat(32)),
							record([mode, exc], 17, "d".repeat(32)), // same trace, same batch
							record([mode, exc], 13), // warning
							record([exc]), // no capture mode
							record([mode]), // no exception
							record([mode, exc], 21), // fatal, no trace
						],
					},
				],
			},
		],
	});
	assert.deepEqual(rows.map((r) => Boolean(r.occurrence)), [true, true, false, false, false, true]);
	const first = rows[0]!.occurrence!;
	assert.equal(first.errorCode, "billing.declined");
	assert.equal(first.link, "https://docs.example.com/p#declined");
	assert.equal(first.errorType, "RuntimeError");
	assert.equal(first.route, "/pay");
	assert.equal(rows[0]!.errorCode, "billing.declined");
	const candidates = logPromotionCandidates(rows);
	assert.equal(candidates.length, 2);
	assert.equal(candidates[1]!.severity, "fatal");
});

// ── sink payload ──────────────────────────────────────────────────────────

test("sink occurrences carry the 1.5.0 optional fields and omit absent ones", () => {
	const base = {
		...input({ errorCode: "billing.declined", why: "w", fix: "f", link: "https://d.dev/#x", expected: true, requestId: "req_abcdefgh12" }),
		occurrenceId: "occ-1",
		fingerprint: "fp",
		fingerprintScheme: "code-v1",
		routeNormalized: "/orders/:id/pay",
		messageNormalized: "m",
		topFrames: [],
		firstFrame: "",
	} satisfies RuntimeOccurrence;
	const wire = JSON.parse(JSON.stringify(sinkOccurrence(base)));
	assert.equal(wire.errorCode, "billing.declined");
	assert.equal(wire.why, "w");
	assert.equal(wire.fix, "f");
	assert.equal(wire.link, "https://d.dev/#x");
	assert.equal(wire.expected, true);
	assert.equal(wire.requestId, "req_abcdefgh12");
	assert.equal(wire.traceId, "a".repeat(32));
	assert.equal(wire.route, "/orders/42/pay");
	assert.equal(wire.method, "POST");
	assert.equal(wire.statusCode, 402);
	assert.equal(wire.fingerprintScheme, "code-v1");
	assert.equal(wire.occurredAt, "2026-01-01T00:00:00.000Z");

	const bare = JSON.parse(
		JSON.stringify(
			sinkOccurrence({ ...base, errorCode: undefined, why: undefined, fix: undefined, link: undefined,
				expected: undefined, requestId: undefined, traceId: null, route: null, method: null, statusCode: null,
				fingerprintScheme: "message-v1" }),
		),
	);
	for (const key of ["errorCode", "why", "fix", "link", "expected", "requestId", "traceId", "route", "method", "statusCode"]) {
		assert.equal(key in bare, false, key);
	}
	assert.equal(bare.fingerprintScheme, "message-v1");
});

// ── migrations ────────────────────────────────────────────────────────────

test("migrations are uniquely ordered and 0012–0014 are additive and idempotent", () => {
	const ids = MIGRATIONS.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length);
	const serials = ids.map((id) => Number(id.slice(0, 4)));
	assert.deepEqual(serials, serials.map((_, i) => i + 1));
	assert.deepEqual(ids.slice(-3), ["0012-runtime-logs-requests", "0013-occurrence-codes", "0014-runtime-request-1m"]);
	for (const migration of MIGRATIONS.slice(-3)) {
		for (const statement of migration.statements) {
			assert.match(statement, /IF NOT EXISTS/, statement);
			assert.doesNotMatch(statement, /DROP|MODIFY/, statement);
		}
	}
	const [logs, occ, rollup] = MIGRATIONS.slice(-3).map((m) => m.statements.join("\n"));
	for (const column of ["kind LowCardinality(String) DEFAULT ''", "request_id String DEFAULT ''", "route String DEFAULT ''",
		"status_code UInt16 DEFAULT 0", "error_code String DEFAULT ''", "ai_cost_usd Float64 DEFAULT 0", "ai_calls UInt32 DEFAULT 0",
		"INDEX IF NOT EXISTS idx_logs_request_id request_id TYPE bloom_filter GRANULARITY 4"]) {
		assert.ok(logs!.includes(column), column);
	}
	for (const column of ["error_code String DEFAULT ''", "error_why String DEFAULT ''", "error_fix String DEFAULT ''",
		"error_link String DEFAULT ''", "expected UInt8 DEFAULT 0", "request_id String DEFAULT ''",
		"fingerprint_scheme LowCardinality(String) DEFAULT 'message-v1'",
		"INDEX IF NOT EXISTS idx_occ_request_id request_id TYPE bloom_filter GRANULARITY 4"]) {
		assert.ok(occ!.includes(column), column);
	}
	assert.match(rollup!, /CREATE TABLE IF NOT EXISTS \{db\}\.runtime_request_1m \(/);
	assert.match(rollup!, /AggregatingMergeTree/);
	assert.match(rollup!, /ORDER BY \(org_id, repository_id, service, environment, route, method, bucket_at\)/);
	assert.match(rollup!, /TTL bucket_at \+ INTERVAL 90 DAY/);
	assert.match(rollup!, /duration_quantiles AggregateFunction\(quantiles\(0\.5, 0\.95\), Float64\)/);
	assert.match(rollup!, /CREATE MATERIALIZED VIEW IF NOT EXISTS \{db\}\.runtime_request_1m_mv\s+TO \{db\}\.runtime_request_1m/);
	assert.match(requestRollupViewDDL("db"), /WHERE kind = 'request'/);
	assert.match(requestRollupViewDDL("db"), /countIf\(outcome = 'failed'\) AS failed_count/);
	// Fresh databases get the same runtime_logs shape and the configured TTL.
	const baseline = logTableDDL("db", 30);
	assert.match(baseline, /ai_calls UInt32 DEFAULT 0/);
	assert.match(baseline, /INDEX idx_logs_request_id request_id TYPE bloom_filter GRANULARITY 4/);
	assert.match(baseline, /INTERVAL 30 DAY/);
	assert.match(logTableDDL("db"), /INTERVAL 14 DAY/);
});

// ── ClickHouse-backed behaviour (HTTP stub) ───────────────────────────────

interface StubCall { sql: string; params: URLSearchParams; body: string }

async function startStub(
	respond: (call: StubCall) => { status?: number; body?: string } | void,
): Promise<{ server: Server; url: string; calls: StubCall[] }> {
	const calls: StubCall[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const params = new URL(req.url!, "http://localhost").searchParams;
			const call = { sql: `${params.get("query") ?? ""}\n${body}`, params, body };
			calls.push(call);
			const out = respond(call) ?? {};
			res.writeHead(out.status ?? 200).end(out.body ?? "");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const close = (server: Server) =>
	new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});

function config(overrides: Partial<IngesterConfig>): IngesterConfig {
	return {
		port: 0,
		clickhouseUrl: null,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [{ key: "server", orgId: "org-1", repositoryId: "repo-1" }],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: null,
		sinkToken: null,
		sinkMaxAttempts: 1,
		sinkMaxBufferedBatches: 10,
		sinkMaxBufferedMb: 2,
		maxBodyBytes: 1024 * 1024,
		rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
		logTtlDays: 14,
		...overrides,
	};
}

test("LOG_TTL_DAYS is applied only when it differs, and a failure never blocks the schema", async () => {
	let engine = "ReplacingMergeTree PARTITION BY toDate(occurred_at) ORDER BY (org_id) TTL toDateTime(occurred_at) + toIntervalDay(14) SETTINGS index_granularity = 8192";
	let failTtl = false;
	const stub = await startStub((call) => {
		if (call.sql.includes("system.tables")) {
			return failTtl ? { status: 500, body: "boom" } : { body: JSON.stringify({ engine_full: engine }) + "\n" };
		}
	});
	const modifies = () => stub.calls.filter((c) => c.sql.includes("MODIFY TTL"));
	try {
		await new ClickHouseStore(config({ clickhouseUrl: stub.url, logTtlDays: 14 })).ensureSchema();
		assert.equal(modifies().length, 0);
		await new ClickHouseStore(config({ clickhouseUrl: stub.url, logTtlDays: 30 })).ensureSchema();
		assert.equal(modifies().length, 1);
		assert.match(modifies()[0]!.sql, /ALTER TABLE autter_runtime\.runtime_logs MODIFY TTL toDateTime\(occurred_at\) \+ INTERVAL 30 DAY/);
		engine = engine.replace("toIntervalDay(14)", "toIntervalDay(30)");
		await new ClickHouseStore(config({ clickhouseUrl: stub.url, logTtlDays: 30 })).ensureSchema();
		assert.equal(modifies().length, 1);
		failTtl = true;
		await new ClickHouseStore(config({ clickhouseUrl: stub.url, logTtlDays: 7 })).ensureSchema();
		assert.equal(modifies().length, 1);
		// Fresh databases: the baseline CREATE carries the configured TTL.
		assert.ok(stub.calls.some((c) => /runtime_logs[\s\S]*INTERVAL 7 DAY/.test(c.sql)));
	} finally {
		await close(stub.server);
	}
});

test("/v1/logs promotes logger-only errors with in-batch and ClickHouse dedupe", async () => {
	const traceA = "a".repeat(32);
	const traceB = "b".repeat(32);
	let lookup: "ok" | "fail" = "ok";
	const inserted: Record<string, Array<Record<string, any>>> = {};
	const ch = await startStub((call) => {
		if (call.sql.includes("SELECT DISTINCT trace_id")) {
			if (lookup === "fail") return { status: 500, body: "lookup down" };
			return { body: JSON.stringify({ trace_id: traceB }) + "\n" };
		}
		const insert = /INSERT INTO autter_runtime\.(\w+)/.exec(call.params.get("query") ?? "");
		if (insert) {
			(inserted[insert[1]!] ??= []).push(
				...call.body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
			);
		}
	});
	const batches: Array<Record<string, any>> = [];
	const sink = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			batches.push(JSON.parse(body));
			res.writeHead(202).end();
		});
	});
	await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
	const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/sink`;
	const app = createIngesterApp(config({ clickhouseUrl: ch.url, sinkUrl })).app.listen(0, "127.0.0.1");
	await new Promise((resolve) => app.once("listening", resolve));
	const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

	const now = BigInt(Date.now()) * 1_000_000n;
	const errorRecord = (traceId: string | undefined, message: string, extra: ReturnType<typeof str>[] = []) => ({
		timeUnixNano: String(now),
		severityNumber: 17,
		...(traceId ? { traceId } : {}),
		body: { stringValue: message },
		attributes: [
			str("autter.capture.mode", "log"),
			str("exception.type", "RuntimeError"),
			str("exception.message", message),
			...extra,
		],
	});
	const post = (records: unknown[]) =>
		fetch(`${url}/v1/logs`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer server" },
			body: JSON.stringify({
				resourceLogs: [{ resource: { attributes: [str("service.name", "edge-api")] }, scopeLogs: [{ logRecords: records }] }],
			}),
		});
	const waitForBatches = async (n: number) => {
		for (let i = 0; i < 100 && batches.length < n; i++) await new Promise((r) => setTimeout(r, 20));
		assert.equal(batches.length, n);
	};

	try {
		const res = await post([
			errorRecord(traceA, "Payment declined", [
				str("autter.error.code", "billing.declined"),
				str("autter.error.why", "Issuer rejected"),
				str("autter.request.id", "req_abcdefgh12"),
				str("http.route", "/pay"),
			]),
			errorRecord(traceA, "Second error in the same trace"), // in-batch duplicate
			errorRecord(traceB, "Already captured on the trace path"), // ClickHouse says seen
			errorRecord(undefined, "No trace at all"),
			{ timeUnixNano: String(now), body: { stringValue: "plain info log" } },
		]);
		assert.equal(res.status, 200);
		assert.equal(inserted.runtime_logs!.length, 5);
		const occurrences = inserted.runtime_error_occurrences!;
		assert.deepEqual(occurrences.map((o) => o.message), ["Payment declined", "No trace at all"]);
		assert.equal(occurrences[0]!.error_code, "billing.declined");
		assert.equal(occurrences[0]!.fingerprint, codeFingerprint("edge-api", "billing.declined"));
		assert.equal(occurrences[0]!.fingerprint_scheme, "code-v1");
		assert.equal(occurrences[0]!.error_why, "Issuer rejected");
		assert.equal(occurrences[0]!.request_id, "req_abcdefgh12");
		assert.equal(occurrences[0]!.source, "server");
		assert.equal(occurrences[1]!.fingerprint_scheme, "message-v1");
		const promotedLog = inserted.runtime_logs!.find((row) => row.message === "Payment declined")!;
		assert.equal(promotedLog.error_code, "billing.declined");
		assert.equal(promotedLog.request_id, "req_abcdefgh12");
		// The lookup was scoped to the tenant and the candidate traces.
		const query = ch.calls.find((c) => c.sql.includes("SELECT DISTINCT trace_id"))!;
		assert.equal(query.params.get("param_org"), "org-1");
		assert.equal(query.params.get("param_repo"), "repo-1");
		assert.match(query.params.get("param_traces") ?? "", new RegExp(traceA));
		assert.ok(inserted.runtime_metrics_1m!.length > 0);

		await waitForBatches(1);
		assert.deepEqual(batches[0]!.occurrences.map((o: any) => o.message), ["Payment declined", "No trace at all"]);
		assert.equal(batches[0]!.occurrences[0].errorCode, "billing.declined");
		assert.equal(batches[0]!.occurrences[0].requestId, "req_abcdefgh12");
		assert.equal(batches[0]!.occurrences[0].traceId, traceA);
		assert.equal(batches[0]!.occurrences[0].route, "/pay");
		assert.equal(batches[0]!.occurrences[0].fingerprintScheme, "code-v1");

		// Lookup failure: promote anyway.
		lookup = "fail";
		inserted.runtime_error_occurrences = [];
		assert.equal((await post([errorRecord(traceB, "Lookup down but still promoted")])).status, 200);
		assert.deepEqual(inserted.runtime_error_occurrences.map((o) => o.message), ["Lookup down but still promoted"]);
		await waitForBatches(2);
	} finally {
		await close(app);
		await close(ch.server);
		await close(sink);
	}
});
