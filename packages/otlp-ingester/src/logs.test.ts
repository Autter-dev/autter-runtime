import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLogs, logTableDDL } from "./logs.js";
import { normalizeTraces } from "./normalize-otlp.js";
import { decodeLogsRequest } from "./otlp-proto.js";

const attr = (key: string, value: string) => ({
	key,
	value: { stringValue: value },
});
test("OTLP context survives ingestion while sensitive fields are scrubbed", () => {
	const result = normalizeTraces({
		resourceSpans: [
			{
				resource: { attributes: [attr("service.name", "checkout")] },
				scopeSpans: [
					{
						spans: [
							{
								traceId: "a".repeat(32),
								spanId: "b".repeat(16),
								name: "checkout",
								startTimeUnixNano: "1760000000000000000",
								endTimeUnixNano: "1760000000001000000",
								attributes: [
									attr("autter.operation.id", "op-1"),
									attr("payment.provider", "stripe"),
									attr("token", "secret"),
								],
								events: [
									{
										name: "autter.outcome",
										attributes: [
											attr("autter.outcome.status", "error"),
											attr("autter.outcome.name", "checkout"),
											attr(
												"autter.outcome.stack",
												"Error\n at checkout (/app/checkout.ts:20:1)",
											),
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
	assert.equal(result.spans[0]!.attributes!["payment.provider"], "stripe");
	assert.equal(
		result.occurrences[0]!.attributes!["autter.operation.id"],
		"op-1",
	);
	assert.equal(result.occurrences[0]!.attributes!.token, "[redacted]");
	assert.match(result.occurrences[0]!.stack!, /checkout.ts/);
});
test("wide event logs preserve nested context, stable IDs and native trace IDs", () => {
	const payload = {
		resourceLogs: [
			{
				resource: { attributes: [attr("service.name", "api")] },
				scopeLogs: [
					{
						logRecords: [
							{
								timeUnixNano: "1760000000000000000",
								traceId: "a".repeat(32),
								body: {
									stringValue: JSON.stringify({
										payment: { attempts: 3, token: "private" },
										message: "person@example.com",
									}),
								},
								attributes: [
									attr("autter.event.type", "operation"),
									attr("autter.operation.outcome", "failed"),
								],
							},
						],
					},
				],
			},
		],
	};
	const [row] = normalizeLogs(payload);
	assert.deepEqual(row!.attributes.payment, {
		attempts: 3,
		token: "[redacted]",
	});
	assert.equal(row!.message, "[redacted]");
	assert.equal(row!.traceId, "a".repeat(32));
	assert.equal(row!.id, normalizeLogs(payload)[0]!.id);
	assert.match(logTableDDL("test"), /org_id String, repository_id String/);
	assert.throws(() => normalizeLogs({ resourceLogs: "bad" } as never));
});
test("OTLP protobuf logs are decoded with the standard field numbers", () => {
	// resourceLogs(1) -> scopeLogs(2) -> logRecords(2) -> body(5) -> stringValue(1)
	const decoded = decodeLogsRequest(
		Buffer.from([10, 10, 18, 8, 18, 6, 42, 4, 10, 2, 111, 107]),
	);
	assert.equal(normalizeLogs(decoded)[0]!.message, "ok");
});

test("serialized context and path queries are scrubbed and excess batches fail explicitly", () => {
	const payload = {
		resourceLogs: [
			{
				scopeLogs: [
					{
						logRecords: [
							{
								body: {
									kvlistValue: {
										values: [
											attr("message", "failed"),
											attr("details", '{"password":"unsafe","attempts":2}'),
											attr("path", "/checkout?token=unsafe"),
										],
									},
								},
							},
						],
					},
				],
			},
		],
	};
	const [row] = normalizeLogs(payload);
	assert.equal(row!.message, "failed");
	assert.deepEqual(row!.attributes.details, {
		password: "[redacted]",
		attempts: 2,
	});
	assert.equal(row!.attributes.path, "/checkout");
	// Past 2000 records the rest are skipped and counted (1.8.0: partial
	// success), not a 400 for the whole request.
	const stats = { overLimit: 0 };
	const rows = normalizeLogs(
		{
			resourceLogs: [
				{
					scopeLogs: [
						{
							logRecords: Array.from({ length: 2003 }, () => ({
								body: { stringValue: "x" },
							})),
						},
					],
				},
			],
		},
		stats,
	);
	assert.equal(rows.length, 2000);
	assert.equal(stats.overLimit, 3);
	assert.throws(
		() => normalizeLogs({ resourceLogs: Array.from({ length: 129 }, () => ({})) }),
		/too many log resources/,
	);
});

test("server exceptions' autter.debug_ids locate source maps and are not kept (RF-05)", () => {
	const id = "4f3c6a1e-9b2d-4e8f-a1b2-c3d4e5f60718";
	const debugIds = JSON.stringify({ "/app/dist/server.js": id });
	const stack = "TypeError: boom\n    at checkout (/app/dist/server.js:1:11)";
	// A span's exception event (runtime-node).
	const traces = normalizeTraces({
		resourceSpans: [
			{
				resource: { attributes: [attr("service.name", "api")] },
				scopeSpans: [
					{
						spans: [
							{
								traceId: "a".repeat(32),
								spanId: "b".repeat(16),
								name: "POST /checkout",
								startTimeUnixNano: "1760000000000000000",
								endTimeUnixNano: "1760000000001000000",
								status: { code: 2 },
								events: [
									{
										name: "exception",
										timeUnixNano: "1760000000000500000",
										attributes: [
											attr("exception.type", "TypeError"),
											attr("exception.message", "boom"),
											attr("exception.stacktrace", stack),
											attr("autter.debug_ids", debugIds),
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
	assert.deepEqual(traces.occurrences[0]!.debugIds, { "/app/dist/server.js": id });
	assert.equal("autter.debug_ids" in traces.occurrences[0]!.attributes!, false);
	// A promoted log record (runtime-edge, logger-only Node).
	const [row] = normalizeLogs({
		resourceLogs: [
			{
				resource: { attributes: [attr("service.name", "edge")] },
				scopeLogs: [
					{
						logRecords: [
							{
								timeUnixNano: "1760000000000000000",
								severityNumber: 17,
								body: { stringValue: "boom" },
								attributes: [
									attr("autter.capture.mode", "log"),
									attr("exception.type", "TypeError"),
									attr("exception.message", "boom"),
									attr("exception.stacktrace", stack),
									attr("autter.debug_ids", debugIds),
								],
							},
						],
					},
				],
			},
		],
	});
	assert.deepEqual(row!.occurrence!.debugIds, { "/app/dist/server.js": id });
	assert.equal("autter.debug_ids" in row!.attributes, false);
	assert.equal("autter.debug_ids" in row!.occurrence!.attributes!, false);
});

// ── Environment from the resource only, and the running commit ──────────────────────────

function oneRecord(resource: Record<string, string>, attributes: Record<string, string>) {
	return normalizeLogs({
		resourceLogs: [{
			resource: { attributes: Object.entries({ "service.name": "shop", ...resource }).map(([k, v]) => attr(k, v)) },
			scopeLogs: [{
				logRecords: [{
					timeUnixNano: "1760000000000000000",
					severityText: "error",
					body: { stringValue: "checkout failed" },
					attributes: Object.entries({
						"autter.capture.mode": "log",
						"exception.type": "OutOfStock",
						"exception.message": "none left",
						...attributes,
					}).map(([k, v]) => attr(k, v)),
				}],
			}],
		}],
	})[0]!;
}

test("a record's own attributes never change its environment", () => {
	for (const attributes of [{ "http.host": "testserver" }, { "server.address": "testserver" }, { "user_agent.original": "testclient" }]) {
		const row = oneRecord({}, attributes);
		assert.equal(row.environment, "production", JSON.stringify(attributes));
		assert.equal(row.occurrence?.environment, "production");
		assert.equal(oneRecord({ "deployment.environment": "test" }, attributes).environment, "test");
		assert.equal(oneRecord({ "deployment.environment": "staging" }, attributes).environment, "staging");
	}
	const marked = normalizeLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "x" }, attributes: [{ key: "autter.test_client", value: { boolValue: true } }] }] }] }] });
	assert.equal(marked[0]!.environment, "production");
});

test("a promoted error carries the running commit: the record's beats the resource's; invalid or none, no field", () => {
	const fromResource = oneRecord({ "deployment.commit": "ABCDEF1234567" }, {});
	assert.equal(fromResource.occurrence?.commit, "abcdef1234567");
	assert.equal(fromResource.occurrence?.attributes?.["deployment.commit"], "abcdef1234567");
	// The log row's own attributes are left as they were.
	assert.equal(fromResource.attributes["deployment.commit"], undefined);

	assert.equal(oneRecord({ "deployment.commit": "1111111" }, { "deployment.commit": "2222222" }).occurrence?.commit, "2222222");
	assert.equal(oneRecord({ "vcs.ref.head.revision": "3333333" }, {}).occurrence?.commit, "3333333");
	for (const bad of ["https://github.com/acme/shop", "main", "123456"]) {
		const row = oneRecord({ "deployment.commit": bad }, {});
		assert.equal("commit" in row.occurrence!, false, bad);
		assert.equal(row.occurrence?.attributes?.["deployment.commit"], undefined, bad);
	}
	assert.equal("commit" in oneRecord({}, {}).occurrence!, false);
});
