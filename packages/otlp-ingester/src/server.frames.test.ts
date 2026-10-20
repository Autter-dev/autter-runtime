import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { fingerprintOccurrence } from "./fingerprint.js";
import { createIngesterApp } from "./server.js";

/**
 * EI-14/15 over the wire: a minified browser error → /v1/browser →
 * symbolicated at ingest against the release's uploaded map → stored with
 * `frames` + `fingerprints` → sink occurrence with frames, every identity
 * candidate and the frames-v3 record, while `fingerprint` stays legacy.
 * ClickHouse is an HTTP stub that serves one source map and records inserts.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n: number): string {
	let v = n < 0 ? (-n << 1) | 1 : n << 1;
	let out = "";
	do {
		let digit = v & 31;
		v >>>= 5;
		if (v > 0) digit |= 32;
		out += B64[digit];
	} while (v > 0);
	return out;
}
// Generated line 1: col 10 → total.ts:12:4 ("total"), col 50 → Checkout.tsx:88:6 ("computeTotal").
const MAP = JSON.stringify({
	version: 3,
	sources: ["src/checkout/total.ts", "src/checkout/Checkout.tsx"],
	names: ["total", "computeTotal"],
	// Second segment is relative to the first: [40-10, 1-0, 76-11, 2-4, 1-0].
	mappings: [[10, 0, 11, 4, 0], [30, 1, 65, -2, 1]].map((s) => s.map(vlq).join("")).join(","),
});

let chStub: Server;
let sinkServer: Server;
let appServer: Server;
let ingestUrl: string;
const sinkBatches: Array<Record<string, any>> = [];
const inserts: Array<{ query: string; rows: Array<Record<string, unknown>> }> = [];
const mapLookups: string[] = [];

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
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const url = new URL(req.url ?? "/", "http://stub");
			const query = url.searchParams.get("query") ?? body;
			if (/runtime_source_maps/.test(query) && /SELECT map/.test(query)) {
				mapLookups.push(`${url.searchParams.get("param_release")} ${url.searchParams.get("param_filename")}`);
				const found = url.searchParams.get("param_release") === "rel-1" &&
					url.searchParams.get("param_filename") === "/assets/index-5f3a9c1e.js";
				res.writeHead(200, { "content-type": "application/x-ndjson" })
					.end(found ? `${JSON.stringify({ map: MAP })}\n` : "");
				return;
			}
			if (/^INSERT INTO/i.test(query)) {
				inserts.push({
					query,
					rows: body.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
				});
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
		ingestKeys: [{ key: "test-key", orgId: "org-1", repositoryId: "repo-1" }],
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

async function nextBatch(seen: number): Promise<Record<string, any>> {
	const deadline = Date.now() + 5000;
	while (sinkBatches.length <= seen) {
		if (Date.now() > deadline) throw new Error("sink batch never arrived");
		await new Promise((r) => setTimeout(r, 10));
	}
	return sinkBatches[seen]!;
}

const STACK = [
	"TypeError: Cannot read properties of undefined (reading 'total')",
	"    at Xe (https://app.example.com/assets/index-5f3a9c1e.js?v=2:1:11)",
	"    at HTMLButtonElement.Qa (https://app.example.com/assets/index-5f3a9c1e.js:1:41)",
].join("\n");

test("browser frames are symbolicated at ingest, stored and forwarded with every candidate", async () => {
	const seen = sinkBatches.length;
	const event = {
		type: "exception",
		timestamp: new Date().toISOString(),
		message: "Cannot read properties of undefined (reading 'total')",
		errorType: "TypeError",
		stack: STACK,
		route: "/checkout",
	};
	const res = await fetch(`${ingestUrl}/v1/browser`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer test-key" },
		body: JSON.stringify({ version: 1, service: "web-app", environment: "production", release: "rel-1", events: [event] }),
	});
	assert.equal(res.status, 202);
	const batch = await nextBatch(seen);
	const [occurrence] = batch.occurrences as Array<Record<string, any>>;

	// Legacy identity, byte-for-byte as before.
	const legacy = fingerprintOccurrence({
		source: "browser", severity: "error", service: "web-app", environment: "production", release: "rel-1",
		errorType: "TypeError", message: event.message, stack: STACK, route: "/checkout", method: null,
		statusCode: null, traceId: null, sessionId: null, attributes: null, occurredAt: new Date(),
	});
	assert.equal(occurrence!.fingerprint, legacy);
	assert.equal(occurrence!.fingerprintScheme, "message-v1");

	// Resolved through the uploaded map (the lookup used the path, not the URL).
	assert.deepEqual(mapLookups, ["rel-1 /assets/index-5f3a9c1e.js"]);
	assert.deepEqual(occurrence!.frames, [
		{ function: "computeTotal", module: null, filename: "src/checkout/total.ts", lineno: 12, colno: 5, inApp: true, resolved: true },
		// The outermost frame has no caller to name it and "Qa" is mangled.
		{ function: null, module: null, filename: "src/checkout/Checkout.tsx", lineno: 77, colno: 3, inApp: true, resolved: true },
	]);
	assert.deepEqual(
		occurrence!.fingerprints.map((c: { scheme: string }) => c.scheme),
		["frames-v3", "message-v1"],
	);
	assert.equal(occurrence!.fingerprints[1].fingerprint, legacy);
	assert.deepEqual(occurrence!.fingerprintRecord, {
		scheme: "frames-v3",
		parts: ["TypeError", "computeTotal@total.ts", "@checkout.tsx"],
	});
	assert.equal("debugIds" in occurrence!, false);

	// Stored: frames JSON + every candidate fingerprint.
	const stored = inserts.find((i) => /runtime_error_occurrences/.test(i.query))!.rows[0]!;
	assert.deepEqual(JSON.parse(String(stored.frames)), occurrence!.frames);
	assert.deepEqual(stored.fingerprints, occurrence!.fingerprints.map((c: { fingerprint: string }) => c.fingerprint));
	assert.equal(stored.fingerprint, legacy);
});

test("a server error without a stack carries [frames-v3, message-v1] and no frames", async () => {
	const seen = sinkBatches.length;
	const res = await fetch(`${ingestUrl}/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer test-key" },
		body: JSON.stringify({
			resourceSpans: [{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
				scopeSpans: [{ spans: [{
					traceId: "a".repeat(32), spanId: "b".repeat(16), name: "GET /x", kind: 2,
					startTimeUnixNano: String(Date.now() * 1_000_000), endTimeUnixNano: String(Date.now() * 1_000_000 + 5_000_000),
					status: { code: 2, message: "boom" },
					events: [{ name: "exception", timeUnixNano: String(Date.now() * 1_000_000), attributes: [
						{ key: "exception.type", value: { stringValue: "Error" } },
						{ key: "exception.message", value: { stringValue: "boom" } },
					] }],
				}] }],
			}],
		}),
	});
	assert.equal(res.status, 200);
	const batch = await nextBatch(seen);
	const [occurrence] = batch.occurrences as Array<Record<string, any>>;
	assert.equal("frames" in occurrence!, false);
	assert.deepEqual(
		occurrence!.fingerprints.map((c: { scheme: string }) => c.scheme),
		["frames-v3", "message-v1"],
	);
	assert.deepEqual(occurrence!.fingerprintRecord.parts, ["Error", "boom"]);
	const stored = inserts.filter((i) => /runtime_error_occurrences/.test(i.query)).at(-1)!.rows[0]!;
	assert.equal(stored.frames, "");
});
