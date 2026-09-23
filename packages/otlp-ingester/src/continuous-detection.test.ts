import assert from "node:assert/strict";
import { test } from "node:test";
import protobuf from "protobufjs";
import { gzipSync } from "node:zlib";
import { normalizeTraces } from "./normalize-otlp.js";
import { normalizeBrowserPayload } from "./normalize-browser.js";
import { decodeProfile } from "./profiles.js";
import { validateSourceMap } from "./source-maps.js";
import { createIngesterApp } from "./server.js";
import { loadConfig } from "./config.js";
import { ClickHouseStore } from "./clickhouse.js";

const at = String(BigInt(Date.parse("2026-09-23T00:00:00Z")) * 1_000_000n);

test("HTTP 5xx without an exception becomes one issue; 4xx does not", () => {
	const request = (status: number) => normalizeTraces({ resourceSpans: [{
		resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] },
		scopeSpans: [{ spans: [{ name: "GET /checkout", traceId: "1".repeat(32), spanId: "2".repeat(16),
			startTimeUnixNano: at, endTimeUnixNano: String(BigInt(at) + 10_000_000n), status: { code: 2 },
			attributes: [
				{ key: "http.route", value: { stringValue: "/checkout" } },
				{ key: "http.request.method", value: { stringValue: "GET" } },
				{ key: "http.response.status_code", value: { intValue: status } },
			] }] }],
	}] });
	assert.equal(request(500).occurrences[0]?.errorType, "HttpServerError");
	assert.equal(request(404).occurrences.length, 0);
	assert.equal(request(404).spans[0]?.status, "ok");
});

test("failed outcome event becomes one issue without a thrown exception", () => {
	const result = normalizeTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{
		name: "checkout", startTimeUnixNano: at, endTimeUnixNano: String(BigInt(at) + 1_000_000n),
		events: [{ name: "autter.outcome", attributes: [
			{ key: "autter.outcome.status", value: { stringValue: "error" } },
			{ key: "autter.outcome.name", value: { stringValue: "payment" } },
			{ key: "autter.outcome.message", value: { stringValue: "declined for alice@example.com" } },
		] }], status: { code: 2 },
	}] }] }] });
	assert.equal(result.occurrences.length, 1);
	assert.equal(result.occurrences[0]?.message, "payment: declined for [redacted]");
});

test("sampled handled exception markers survive OTLP normalization", () => {
	const result = normalizeTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{
		name: "caught.exception", startTimeUnixNano: at, endTimeUnixNano: String(BigInt(at) + 1_000_000n),
		events: [{ name: "exception", attributes: [
			{ key: "exception.type", value: { stringValue: "ValueError" } },
			{ key: "autter.handled", value: { boolValue: true } },
			{ key: "autter.sampled", value: { boolValue: true } },
		] }],
	}] }] }] });
	assert.deepEqual(result.occurrences[0]?.attributes, { "autter.handled": true, "autter.sampled": true });
});

test("browser timing is aggregated; failed outcome becomes an issue", () => {
	const result = normalizeBrowserPayload({ version: 1, service: "web", environment: "production", events: [
		{ type: "timing", timestamp: "2026-09-23T00:00:00Z", message: "", name: "browser.longtask", durationMs: 300 },
		{ type: "outcome", timestamp: "2026-09-23T00:00:01Z", message: "not ready for alice@example.com", name: "checkout" },
	] });
	assert.equal(result.metricPoints.find((point) => point.route === "browser.longtask")?.durationSumMs, 300);
	assert.equal(result.occurrences[0]?.errorType, "OutcomeFailure");
	assert.equal(result.occurrences[0]?.message, "checkout: not ready for [redacted]");
});

test("pprof samples are bounded, decoded, and source map contents are dropped", async () => {
	const type = protobuf.parse(`syntax = "proto3";
		message Profile { repeated ValueType sample_type = 1; repeated Sample sample = 2;
			repeated Location location = 4; repeated Function function = 5; repeated string string_table = 6; }
		message ValueType { int64 type = 1; int64 unit = 2; }
		message Sample { repeated uint64 location_id = 1 [packed=true]; repeated int64 value = 2 [packed=true]; }
		message Location { uint64 id = 1; repeated Line line = 4; }
		message Line { uint64 function_id = 1; }
		message Function { uint64 id = 1; int64 name = 2; }`).root.lookupType("Profile");
	const body = Buffer.from(type.encode(type.create({ sampleType: [{ type: 1, unit: 2 }],
		sample: [{ locationId: [1], value: [5] }], location: [{ id: 1, line: [{ functionId: 1 }] }],
		function: [{ id: 1, name: 3 }], stringTable: ["", "cpu", "samples", "checkout"] })).finish());
	const samples = decodeProfile(body, { service: "api", environment: "prod", release: "abc", traceId: "" });
	assert.equal(samples[0]?.stack[0], "checkout");
	assert.equal(samples[0]?.value, 5);
	assert.equal(decodeProfile(gzipSync(body), { service: "api", environment: "prod", release: "abc", traceId: "" })[0]?.value, 5);
	const unavailableStore = new ClickHouseStore({ ...loadConfig(), clickhouseUrl: "" });
	await assert.rejects(unavailableStore.insertProfileSamples({ orgId: "org-a", repositoryId: "repo-a" }, samples));
	assert.throws(() => decodeProfile(Buffer.alloc(1024 * 1024 + 1), { service: "api", environment: "prod", release: "", traceId: "" }));
	const sourceMap = validateSourceMap({ release: "abc", filename: "https://example.com/app.js?q=1", map: { version: 3, mappings: "AAAA", sources: ["src/app.ts"], sourcesContent: ["secret"] } });
	assert.equal(sourceMap?.filename, "/app.js");
	assert.equal(sourceMap?.map.includes("secret"), false);
});

test("profile and source map uploads require a server key and use its tenant", async () => {
	const config = { ...loadConfig(), clickhouseUrl: "http://127.0.0.1:8123", ingestKeys: [
		{ key: "server-test", orgId: "org-a", repositoryId: "repo-a", scope: "server" as const },
		{ key: "client-test", orgId: "org-b", repositoryId: "repo-b", scope: "client" as const },
	] };
	const { app, store } = createIngesterApp(config);
	let storedTenant = "";
	let storedProfileTenant = "";
	store.insertSourceMap = async (ctx) => { storedTenant = `${ctx.orgId}/${ctx.repositoryId}`; };
	store.insertProfileSamples = async (ctx, samples) => {
		storedProfileTenant = `${ctx.orgId}/${ctx.repositoryId}`;
		assert.equal(samples[0]?.stack[0], "checkout");
	};
	const server = app.listen(0, "127.0.0.1");
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no listener");
		const url = `http://127.0.0.1:${address.port}/v1/sourcemaps`;
		const body = JSON.stringify({ release: "abc", filename: "/app.js", map: { version: 3, mappings: "AAAA", sources: ["src/app.ts"] } });
		const post = (key?: string) => fetch(url, { method: "POST", headers: {
			"content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}),
		}, body });
		assert.equal((await post()).status, 401);
		assert.equal((await post("client-test")).status, 403);
		assert.equal((await post("server-test")).status, 202);
		assert.equal(storedTenant, "org-a/repo-a");
		const profileType = protobuf.parse(`syntax = "proto3";
			message Profile { repeated Sample sample = 2; repeated Location location = 4;
				repeated Function function = 5; repeated string string_table = 6; }
			message Sample { repeated uint64 location_id = 1 [packed=true]; repeated int64 value = 2 [packed=true]; }
			message Location { uint64 id = 1; repeated Line line = 4; }
			message Line { uint64 function_id = 1; }
			message Function { uint64 id = 1; int64 name = 2; }`).root.lookupType("Profile");
		const profileBody = Buffer.from(profileType.encode(profileType.create({
			sample: [{ locationId: [1], value: [5] }],
			location: [{ id: 1, line: [{ functionId: 1 }] }],
			function: [{ id: 1, name: 1 }], stringTable: ["", "checkout"],
		})).finish());
		const profileUrl = `http://127.0.0.1:${address.port}/v1/profiles`;
		const postProfile = (key: string) => fetch(profileUrl, { method: "POST", headers: {
			"content-type": "application/x-pprof", authorization: `Bearer ${key}`,
			"x-autter-service": "api", "x-autter-release": "abc",
		}, body: profileBody });
		assert.equal((await postProfile("client-test")).status, 403);
		assert.equal((await postProfile("server-test")).status, 202);
		assert.equal(storedProfileTenant, "org-a/repo-a");
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
