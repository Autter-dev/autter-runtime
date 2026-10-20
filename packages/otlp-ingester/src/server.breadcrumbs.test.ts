import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { createIngesterApp } from "./server.js";

/**
 * Breadcrumbs end to end: browser events and OTLP exception events →
 * ClickHouse (attributes JSON, `autter.breadcrumbs`) and the sink webhook
 * (`breadcrumbs`). ClickHouse is a 200-everything HTTP stub that records
 * the occurrence inserts.
 */

let chStub: Server;
let sinkServer: Server;
let sinkBatches: Array<Record<string, any>>;
let nextSinkBatch: () => Promise<Record<string, any>>;
let appServer: Server;
let ingestUrl: string;
const occurrenceRows: Array<Record<string, any>> = [];

before(async () => {
	sinkBatches = [];
	let notify: (() => void) | null = null;
	sinkServer = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			sinkBatches.push(JSON.parse(body));
			res.writeHead(202).end();
			notify?.();
		});
	});
	await new Promise<void>((resolve) => sinkServer.listen(0, resolve));
	const sinkPort = (sinkServer.address() as AddressInfo).port;
	nextSinkBatch = () => {
		const seen = sinkBatches.length;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("sink batch never arrived")),
				5000,
			);
			notify = () => {
				clearTimeout(timer);
				resolve(sinkBatches[seen]!);
			};
			if (sinkBatches.length > seen) {
				clearTimeout(timer);
				resolve(sinkBatches[seen]!);
			}
		});
	};

	// Empty 200s satisfy every client call: command() ignores the body, the
	// schema_migrations SELECT parses an empty JSONEachRow body as zero rows,
	// and insert() only checks the status.
	chStub = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const query = new URL(req.url ?? "/", "http://clickhouse").searchParams.get("query") ?? "";
			if (/INSERT INTO \S*runtime_error_occurrences/.test(query)) {
				for (const line of body.split("\n").filter(Boolean)) occurrenceRows.push(JSON.parse(line));
			}
			res.writeHead(200).end();
		});
	});
	await new Promise<void>((resolve) => chStub.listen(0, resolve));

	const config: IngesterConfig = {
		port: 0,
		clickhouseUrl: `http://127.0.0.1:${(chStub.address() as AddressInfo).port}`,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [
			{ key: "test-key", orgId: "org-e2e", repositoryId: "repo-e2e" },
		],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: `http://127.0.0.1:${sinkPort}/runtime/sink`,
		sinkToken: null,
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

const AT = new Date().toISOString();

async function post(path: string, body: unknown): Promise<number> {
	const res = await fetch(`${ingestUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer test-key" },
		body: JSON.stringify(body),
	});
	await res.text();
	return res.status;
}

test("browser breadcrumbs are bounded, scrubbed, stored in attributes and passed to the sink", async () => {
	const breadcrumbs = [
		...Array.from({ length: 34 }, (_, i) => ({ type: "request", at: AT, level: "info", message: `GET /api/items/${i} 200`, data: { status: 200 } })),
		{ type: "console", at: AT, level: "error", message: "failed for jane@example.com", data: { token: "abc" } },
	];
	const status = await post("/v1/browser", {
		version: 1,
		service: "web-breadcrumbs",
		environment: "production",
		events: [
			{ type: "exception", timestamp: AT, message: "checkout failed", errorType: "Error", breadcrumbs },
			{ type: "exception", timestamp: AT, message: "no steps", errorType: "Error" },
		],
	});
	assert.equal(status, 202);
	const batch = await nextSinkBatch();
	const withSteps = batch.occurrences.find((o: any) => o.message === "checkout failed");
	const without = batch.occurrences.find((o: any) => o.message === "no steps");
	assert.equal(withSteps.breadcrumbs.length, 30);
	assert.equal(withSteps.breadcrumbs[0].message, "GET /api/items/5 200");
	assert.deepEqual(withSteps.breadcrumbs.at(-1), {
		type: "console",
		at: AT,
		level: "error",
		message: "failed for [redacted]",
		data: { token: "[redacted]" },
	});
	assert.ok(!("breadcrumbs" in without), "absent, not empty");
	assert.ok(!("autter.breadcrumbs" in withSteps.attributes), "the sink gets the field once");

	const row = occurrenceRows.find((r) => r.occurrence_id === withSteps.occurrenceId);
	assert.ok(row, "occurrence row inserted");
	assert.deepEqual(JSON.parse(row.attributes)["autter.breadcrumbs"], withSteps.breadcrumbs);
	const plain = occurrenceRows.find((r) => r.occurrence_id === without.occurrenceId);
	assert.ok(!("autter.breadcrumbs" in JSON.parse(plain.attributes)));
});

test("server autter.breadcrumbs on the exception event reaches the sink and storage", async () => {
	const nanos = `${Date.now()}000000`;
	const crumbs = [
		{ type: "log", at: AT, level: "info", message: "loading cart 42" },
		{ type: "custom", at: AT, message: "applied coupon", data: { coupon: "SAVE10" } },
	];
	const status = await post("/v1/traces", {
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "api-breadcrumbs" } }] },
				scopeSpans: [
					{
						spans: [
							{
								traceId: "c".repeat(32),
								spanId: "d".repeat(16),
								name: "POST /checkout",
								kind: 2,
								startTimeUnixNano: nanos,
								endTimeUnixNano: nanos,
								status: { code: 2, message: "boom" },
								events: [
									{
										name: "exception",
										timeUnixNano: nanos,
										attributes: [
											{ key: "exception.type", value: { stringValue: "TypeError" } },
											{ key: "exception.message", value: { stringValue: "boom" } },
											{ key: "autter.breadcrumbs", value: { stringValue: JSON.stringify(crumbs) } },
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
	assert.equal(status, 200);
	const batch = await nextSinkBatch();
	assert.equal(batch.occurrences.length, 1);
	const [occurrence] = batch.occurrences;
	assert.deepEqual(occurrence.breadcrumbs, crumbs);
	assert.ok(!("autter.breadcrumbs" in occurrence.attributes));
	const row = occurrenceRows.find((r) => r.occurrence_id === occurrence.occurrenceId);
	assert.deepEqual(JSON.parse(row!.attributes)["autter.breadcrumbs"], crumbs);
});
