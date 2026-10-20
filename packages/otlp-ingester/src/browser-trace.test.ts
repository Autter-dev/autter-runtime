import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { browserPayloadSchema, normalizeBrowserPayload } from "./normalize-browser.js";
import { createIngesterApp } from "./server.js";

// EI-11: runtime-browser sends the W3C trace id of the request behind an
// event; the ingester keeps it on the occurrence so the platform can join the
// browser error to the server trace.

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const at = "2026-10-20T10:00:00.000Z";

function normalize(events: unknown[]) {
	const parsed = browserPayloadSchema.safeParse({ version: 1, service: "web", environment: "prod", events });
	assert.ok(parsed.success, "the batch is accepted");
	return normalizeBrowserPayload(parsed.data).occurrences;
}

test("a valid browser trace id is kept on the occurrence", () => {
	const [failure, exception] = normalize([
		{ type: "request_failure", timestamp: at, name: "/api/checkout", message: "Request returned 502", traceId: TRACE },
		{ type: "exception", timestamp: at, message: "boom", traceId: TRACE },
	]);
	assert.equal(failure!.traceId, TRACE);
	assert.equal(exception!.traceId, TRACE);
});

test("a malformed trace id is dropped on its own, never the batch", () => {
	const occurrences = normalize([
		{ type: "exception", timestamp: at, message: "upper", traceId: TRACE.toUpperCase() },
		{ type: "exception", timestamp: at, message: "short", traceId: TRACE.slice(1) },
		{ type: "exception", timestamp: at, message: "zero", traceId: "0".repeat(32) },
		{ type: "exception", timestamp: at, message: "number", traceId: 42 },
		{ type: "exception", timestamp: at, message: "absent" },
	]);
	assert.deepEqual(occurrences.map((o) => [o.message, o.traceId]), [
		["upper", null],
		["short", null],
		["zero", null],
		["number", null],
		["absent", null],
	]);
});

// ── through the HTTP app, against a ClickHouse stub and a sink ─────────────

interface StubCall { sql: string; params: URLSearchParams; body: string }

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

test("/v1/browser stores and forwards the trace id; log-promotion dedupe ignores browser rows", async () => {
	const calls: StubCall[] = [];
	const inserted: Record<string, Array<Record<string, any>>> = {};
	const ch = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const params = new URL(req.url!, "http://localhost").searchParams;
			calls.push({ sql: `${params.get("query") ?? ""}\n${body}`, params, body });
			const insert = /INSERT INTO autter_runtime\.(\w+)/.exec(params.get("query") ?? "");
			if (insert) {
				(inserted[insert[1]!] ??= []).push(...body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
			}
			res.writeHead(200).end("");
		});
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
	const chUrl = await listen(ch);
	const sinkUrl = `${await listen(sink)}/sink`;
	const app = createIngesterApp(config({ clickhouseUrl: chUrl, sinkUrl })).app.listen(0, "127.0.0.1");
	await new Promise((resolve) => app.once("listening", resolve));
	const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
	try {
		const now = new Date().toISOString();
		const res = await fetch(`${url}/v1/browser`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer server" },
			body: JSON.stringify({
				version: 1,
				service: "web",
				environment: "production",
				events: [
					{ type: "request_failure", timestamp: now, name: "/api/checkout", message: "Request returned 502", traceId: TRACE },
					{ type: "exception", timestamp: now, message: "Checkout failed", traceId: "not-a-trace" },
				],
			}),
		});
		assert.equal(res.status, 202);
		const rows = inserted.runtime_error_occurrences!;
		assert.deepEqual(rows.map((row) => [row.source, row.trace_id]), [["browser", TRACE], ["browser", ""]]);
		for (let i = 0; i < 100 && batches.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
		const sent = batches[0]!.occurrences as Array<Record<string, unknown>>;
		assert.equal(sent[0]!.traceId, TRACE);
		assert.equal("traceId" in sent[1]!, false);

		// A logger-only server error on the same trace must not be deduped
		// against the browser occurrence that shares its trace id.
		const logs = await fetch(`${url}/v1/logs`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer server" },
			body: JSON.stringify({
				resourceLogs: [{
					resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
					scopeLogs: [{ logRecords: [{
						timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
						severityNumber: 17,
						traceId: TRACE,
						body: { stringValue: "upstream failed" },
						attributes: [
							{ key: "autter.capture.mode", value: { stringValue: "log" } },
							{ key: "exception.type", value: { stringValue: "Error" } },
							{ key: "exception.message", value: { stringValue: "upstream failed" } },
						],
					}] }],
				}],
			}),
		});
		assert.equal(logs.status, 200);
		const lookup = calls.find((call) => call.sql.includes("SELECT DISTINCT trace_id"));
		assert.ok(lookup, "the promotion dedupe lookup ran");
		assert.match(lookup!.sql, /source != 'browser'/);
	} finally {
		await close(app);
		await close(ch);
		await close(sink);
	}
});
