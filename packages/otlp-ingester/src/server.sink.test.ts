import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { createIngesterApp } from "./server.js";

/**
 * End-to-end over the wire (Nirzari's repro): a page that only reports
 * errors → /v1/browser → sink webhook. Asserts the sink batch carries every
 * grouped error event with nonzero counts — both the occurrences that feed
 * issue grouping and the metric rollups that feed the events/error-events
 * counters. ClickHouse is a 200-everything HTTP stub (ingest requires
 * configured storage); the sink contract is what's under test.
 */

let chStub: Server;
let sinkServer: Server;
let sinkBatches: Array<Record<string, any>>;
let nextSinkBatch: () => Promise<Record<string, any>>;
let appServer: Server;
let ingestUrl: string;

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

test("browser errors reach the sink grouped with nonzero event counts", async () => {
	const T = new Date().toISOString();
	const res = await fetch(`${ingestUrl}/v1/browser`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer test-key",
		},
		body: JSON.stringify({
			version: 1,
			service: "test-html-page",
			environment: "development",
			events: [
				...Array.from({ length: 4 }, () => ({
					type: "exception",
					timestamp: T,
					message: "Deliberate test error for Autter Runtime",
					errorType: "Error",
					stack: "Error: Deliberate test error\n    at test.html:1:1",
				})),
				{
					type: "unhandled_rejection",
					timestamp: T,
					message: "Deliberate test unhandled rejection",
					errorType: "Error",
					stack: "Error: Deliberate test unhandled rejection\n    at test.html:2:1",
				},
			],
		}),
	});
	assert.equal(res.status, 202);

	const batch = await nextSinkBatch();
	assert.equal(batch.orgId, "org-e2e");
	assert.equal(batch.repositoryId, "repo-e2e");

	// Occurrences group by fingerprint the way the sink's issue upsert will:
	// two groups, event counts 4 and 1 — never 0.
	const byFingerprint = new Map<string, number>();
	for (const occurrence of batch.occurrences) {
		assert.ok(occurrence.fingerprint, "occurrence is fingerprinted");
		byFingerprint.set(
			occurrence.fingerprint,
			(byFingerprint.get(occurrence.fingerprint) ?? 0) + 1,
		);
	}
	assert.equal(byFingerprint.size, 2);
	assert.deepEqual(
		[...byFingerprint.values()].sort((a, b) => b - a),
		[4, 1],
	);
	for (const count of byFingerprint.values()) {
		assert.ok(count > 0, "every grouped error has a nonzero event count");
	}

	// The same events also arrive as metric rollups, so the overview /
	// services event counters agree with the grouped issues instead of 0.
	const totals = batch.metrics.reduce(
		(acc: { events: number; errors: number }, p: any) => ({
			events: acc.events + p.requestCount,
			errors: acc.errors + p.errorCount,
		}),
		{ events: 0, errors: 0 },
	);
	assert.equal(totals.events, 5);
	assert.equal(totals.errors, 5);
});

test("captureException-style internal error spans reach the sink with metrics", async () => {
	const nanos = `${Date.now()}000000`;
	const res = await fetch(`${ingestUrl}/v1/traces`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer test-key",
		},
		body: JSON.stringify({
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "repro-service" } },
							{
								key: "deployment.environment",
								value: { stringValue: "development" },
							},
						],
					},
					scopeSpans: [
						{
							spans: [
								{
									traceId: "a".repeat(32),
									spanId: "b".repeat(16),
									name: "TypeError",
									kind: 1,
									startTimeUnixNano: nanos,
									endTimeUnixNano: nanos,
									status: { code: 2, message: "boom" },
									events: [
										{
											name: "exception",
											timeUnixNano: nanos,
											attributes: [
												{
													key: "exception.type",
													value: { stringValue: "TypeError" },
												},
												{
													key: "exception.message",
													value: { stringValue: "boom" },
												},
											],
										},
									],
								},
							],
						},
					],
				},
			],
		}),
	});
	assert.equal(res.status, 200);

	const batch = await nextSinkBatch();
	assert.equal(batch.occurrences.length, 1);
	assert.ok(batch.occurrences[0].fingerprint);
	const totals = batch.metrics.reduce(
		(acc: { events: number; errors: number }, p: any) => ({
			events: acc.events + p.requestCount,
			errors: acc.errors + p.errorCount,
		}),
		{ events: 0, errors: 0 },
	);
	assert.equal(totals.events, 1);
	assert.equal(totals.errors, 1);
});
