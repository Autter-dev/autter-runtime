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

// A bundled Node server (RF-05): generated line 1 col 10 → src/checkout.ts:12:4,
// with the source's content (kept at upload for in-app sources).
const SERVER_SOURCE = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
const SERVER_MAP = JSON.stringify({
	version: 3,
	sources: ["src/checkout.ts"],
	names: [],
	mappings: [10, 0, 11, 4].map(vlq).join(""),
	sourcesContent: [SERVER_SOURCE],
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
				const release = url.searchParams.get("param_release");
				const filename = url.searchParams.get("param_filename") ?? "";
				mapLookups.push(`${release} ${filename}`);
				// Server frames look the map up by path suffix (stored as "/server.js").
				const found = /endsWith/.test(query)
					? release === "rel-1" && filename.endsWith("/server.js") ? SERVER_MAP : null
					: release === "rel-1" && filename === "/assets/index-5f3a9c1e.js" ? MAP : null;
				res.writeHead(200, { "content-type": "application/x-ndjson" })
					.end(found ? `${JSON.stringify({ map: found })}\n` : "");
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
	// Both in-app frames were resolved by the map (migration 0020); the
	// counts are stored, not forwarded (the sink has the frames themselves).
	assert.equal(stored.in_app_frames_resolved, 2);
	assert.equal(stored.in_app_frames_unresolved, 0);
	assert.equal("inAppFramesResolved" in occurrence!, false);
});

test("browser frames no map resolves are counted unresolved per occurrence", async () => {
	const seen = sinkBatches.length;
	const res = await fetch(`${ingestUrl}/v1/browser`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer test-key" },
		body: JSON.stringify({ version: 1, service: "web-app", environment: "production", release: "rel-without-maps", events: [{
			type: "exception",
			timestamp: new Date().toISOString(),
			message: "Cannot read properties of undefined (reading 'total')",
			errorType: "TypeError",
			stack: STACK,
		}] }),
	});
	assert.equal(res.status, 202);
	const batch = await nextBatch(seen);
	const [occurrence] = batch.occurrences as Array<Record<string, any>>;
	assert.deepEqual(occurrence!.frames.map((f: { resolved: boolean }) => f.resolved), [false, false]);
	const stored = inserts.filter((i) => /runtime_error_occurrences/.test(i.query)).at(-1)!.rows[0]!;
	assert.equal(stored.in_app_frames_resolved, 0);
	assert.equal(stored.in_app_frames_unresolved, 2);
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
	// Server occurrences carry no resolution counts (clickhouse.ts).
	assert.equal(stored.in_app_frames_resolved, 0);
	assert.equal(stored.in_app_frames_unresolved, 0);
});

test("bundled Node frames are symbolicated at ingest by path suffix, with 5 context lines (RF-05)", async () => {
	const seen = sinkBatches.length;
	const lookupsBefore = mapLookups.length;
	const now = String(Date.now() * 1_000_000);
	const stack = [
		"TypeError: Cannot read properties of undefined (reading 'total')",
		"    at checkout (/app/dist/server.js:1:11)",
		"    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)",
	].join("\n");
	const res = await fetch(`${ingestUrl}/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer test-key" },
		body: JSON.stringify({
			resourceSpans: [{
				resource: { attributes: [
					{ key: "service.name", value: { stringValue: "api" } },
					{ key: "service.version", value: { stringValue: "rel-1" } },
				] },
				scopeSpans: [{ spans: [{
					traceId: "c".repeat(32), spanId: "d".repeat(16), name: "POST /checkout", kind: 2,
					startTimeUnixNano: now, endTimeUnixNano: now,
					status: { code: 2, message: "boom" },
					events: [{ name: "exception", timeUnixNano: now, attributes: [
						{ key: "exception.type", value: { stringValue: "TypeError" } },
						{ key: "exception.message", value: { stringValue: "Cannot read properties of undefined (reading 'total')" } },
						{ key: "exception.stacktrace", value: { stringValue: stack } },
					] }],
				}] }],
			}],
		}),
	});
	assert.equal(res.status, 200);
	const batch = await nextBatch(seen);
	const [occurrence] = batch.occurrences as Array<Record<string, any>>;
	// One lookup: the app bundle's path; express (node_modules) is never looked up.
	assert.deepEqual(mapLookups.slice(lookupsBefore), ["rel-1 /app/dist/server.js"]);
	assert.deepEqual(occurrence!.frames, [
		{
			function: "checkout", module: null, filename: "src/checkout.ts", lineno: 12, colno: 5, inApp: true, resolved: true,
			contextLine: "line 12",
			preContext: ["line 7", "line 8", "line 9", "line 10", "line 11"],
			postContext: ["line 13", "line 14", "line 15", "line 16", "line 17"],
		},
		{
			function: "Layer.handle", module: null, filename: "/app/node_modules/express/lib/router/layer.js",
			lineno: 95, colno: 5, inApp: false, resolved: false,
		},
	]);
	// frames-v3 hashes the original file, not the bundle.
	assert.deepEqual(occurrence!.fingerprintRecord.parts, ["TypeError", "checkout@checkout.ts"]);
});
