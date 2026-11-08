import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { loadConfig } from "./config.js";
import { createIngesterApp } from "./server.js";

/**
 * A key validator outage seen by a real OTLP exporter (OpenTelemetry JS
 * 0.57, HTTP/protobuf). The ingester answers 503 with Retry-After while it
 * cannot check a key; the exporter retries inside its 10 s export timeout,
 * and the batch lands once the validator is back. A definite refusal is a
 * 401, which the exporter does not retry.
 */

const KEY = `autter_rt_${"3".repeat(48)}`;

async function setup(t: TestContext, answers: Array<{ status: number; body?: unknown }>) {
	t.mock.method(console, "warn", () => {});
	let calls = 0;
	const validator = createServer((req, res) => {
		const answer = answers[Math.min(calls, answers.length - 1)]!;
		calls += 1;
		req.resume();
		req.on("end", () =>
			res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body === undefined ? "" : JSON.stringify(answer.body)),
		);
	});
	await new Promise<void>((resolve) => validator.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => validator.close(() => resolve())));

	const ingester = createIngesterApp({
		...loadConfig(),
		clickhouseUrl: "http://127.0.0.1:1",
		ingestKeys: [],
		keyValidatorUrl: `http://127.0.0.1:${(validator.address() as AddressInfo).port}/runtime/validate-key`,
	});
	const { app, store, drops } = ingester;
	const stub = store as unknown as Record<string, unknown>;
	for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
		if (name.startsWith("insert")) stub[name] = async () => {};
	}
	stub.ensureSchema = async () => {};
	stub.recentOccurrenceTraceIds = async () => new Set();
	const stored: string[] = [];
	store.insertSpans = async (_ctx, rows) => void stored.push(...rows.map((row) => row.name));
	const statuses: number[] = [];
	const server = app.listen(0, "127.0.0.1");
	server.prependListener("request", (_req, res) => res.on("finish", () => statuses.push(res.statusCode)));
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(
		() =>
			new Promise<void>((resolve) => {
				void drops.stop();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	);
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, stored, statuses, validatorCalls: () => calls };
}

/** One span, exported once through the OTLP/protobuf exporter. */
async function exportSpan(base: string, name: string): Promise<ExportResult> {
	const memory = new InMemorySpanExporter();
	const provider = new BasicTracerProvider();
	provider.addSpanProcessor(new SimpleSpanProcessor(memory));
	provider.getTracer("outage-test").startSpan(name).end();
	await provider.forceFlush();
	const exporter = new OTLPTraceExporter({ url: `${base}/v1/traces`, headers: { authorization: `Bearer ${KEY}` } });
	const result = await new Promise<ExportResult>((resolve) => exporter.export(memory.getFinishedSpans(), resolve));
	await exporter.shutdown();
	return result;
}

test("validator down, then back: the exporter retries the 503 and the batch is stored", async (t) => {
	const app = await setup(t, [{ status: 503 }, { status: 200, body: { orgId: "o", repositoryId: "r", scope: "server" } }]);
	const result = await exportSpan(app.base, "during-outage");
	assert.equal(result.code, ExportResultCode.SUCCESS, String(result.error));
	assert.deepEqual(app.statuses.filter((s) => s !== 200), [503]);
	assert.deepEqual(app.stored, ["during-outage"]);
	assert.equal(app.validatorCalls(), 2);
});

test("a key the validator refuses gets one 401 and is not retried", async (t) => {
	const app = await setup(t, [{ status: 404, body: { error: "unknown or revoked key" } }]);
	const result = await exportSpan(app.base, "revoked");
	assert.equal(result.code, ExportResultCode.FAILED);
	assert.deepEqual(app.statuses, [401]);
	assert.deepEqual(app.stored, []);
});
