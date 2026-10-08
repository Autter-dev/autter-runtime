import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { MIGRATIONS } from "./migrations.js";
import { createIngesterApp } from "./server.js";
import { ingesterVersion, SdkVersionTracker, sdkSightingsFromOtlp } from "./sdk-versions.js";

const listen = async (server: Server) => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) =>
	new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});

function config(clickhouseUrl: string | null): IngesterConfig {
	return {
		port: 0,
		clickhouseUrl,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [
			{ key: "server", orgId: "org-1", repositoryId: "repo-1" },
			{ key: "client", orgId: "org-1", repositoryId: "repo-1", scope: "client" },
		],
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
	};
}

/** Fake ClickHouse HTTP interface: records INSERT rows per table. */
async function fakeClickHouse() {
	const inserts: Record<string, Array<Record<string, unknown>>> = {};
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const query = new URL(req.url!, "http://localhost").searchParams.get("query") ?? "";
			const table = /INSERT INTO \w+\.(\w+)/.exec(query)?.[1];
			if (table) {
				(inserts[table] ??= []).push(
					...body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
				);
			}
			res.end();
		});
	});
	return { server, url: await listen(server), inserts };
}

const waitFor = async (check: () => boolean) => {
	for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
	assert.ok(check(), "condition not reached");
};

test("GET /v1/compat reports version, schema state and features without auth or DDL", async () => {
	const app = createIngesterApp(config(null)).app;
	const server = app.listen(0);
	const url = await new Promise<string>((resolve) =>
		server.once("listening", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
	);
	try {
		const res = await fetch(`${url}/v1/compat`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("x-autter-ingester-version"), ingesterVersion());
		const body = (await res.json()) as {
			ingester: { name: string; version: string };
			schema: { status: string; latest: string };
			features: Array<{ id: string; ingesterSupported: boolean }>;
			issues?: unknown;
		};
		assert.equal(body.ingester.name, "@autter/otlp-ingester");
		assert.equal(body.ingester.version, ingesterVersion());
		assert.equal(body.schema.status, "unconfigured");
		assert.equal(body.schema.latest, MIGRATIONS[MIGRATIONS.length - 1]!.id);
		assert.ok(body.features.some((f) => f.id === "operation_logging" && f.ingesterSupported));
		assert.equal(body.issues, undefined);

		const evaluated = (await (
			await fetch(`${url}/v1/compat?sdk=${encodeURIComponent("@autter/runtime-node@1.3.0")}&features=operation_logging`)
		).json()) as { issues: Array<{ kind: string; component: string }> };
		assert.deepEqual(evaluated.issues.map((i) => [i.kind, i.component]), [["sdk_too_old", "@autter/runtime-node"]]);
	} finally {
		await close(server);
	}
});

test("ingest responses carry the version header; SDK versions are recorded once per service", async () => {
	const ch = await fakeClickHouse();
	const { app, store } = createIngesterApp(config(ch.url));
	const server = app.listen(0);
	const url = await new Promise<string>((resolve) =>
		server.once("listening", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
	);
	const traces = {
		resourceSpans: [{
			resource: { attributes: [
				{ key: "service.name", value: { stringValue: "api" } },
				{ key: "deployment.environment", value: { stringValue: "staging" } },
				{ key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
				{ key: "telemetry.sdk.version", value: { stringValue: "1.30.1" } },
				{ key: "telemetry.distro.name", value: { stringValue: "@autter/runtime-node" } },
				{ key: "telemetry.distro.version", value: { stringValue: "1.4.0" } },
			] },
			scopeSpans: [],
		}],
	};
	try {
		for (let i = 0; i < 3; i++) {
			const res = await fetch(`${url}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer server" },
				body: JSON.stringify(traces),
			});
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("x-autter-ingester-version"), ingesterVersion());
		}
		await waitFor(() => (ch.inserts.runtime_sdk_versions?.length ?? 0) >= 1);
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(ch.inserts.runtime_sdk_versions!.length, 1, "deduplicated");
		assert.deepEqual(
			{ ...ch.inserts.runtime_sdk_versions![0], last_seen: undefined },
			{
				org_id: "org-1", repository_id: "repo-1", service: "api", environment: "staging",
				sdk_name: "@autter/runtime-node", sdk_version: "1.4.0", sdk_language: "nodejs",
				ingester_version: ingesterVersion(), last_seen: undefined,
			},
		);
		// The ingester reports its own version once the schema is ready.
		await waitFor(() => (ch.inserts.runtime_ingester_info?.length ?? 0) === 1);
		assert.equal(ch.inserts.runtime_ingester_info![0]!.ingester_version, ingesterVersion());
		assert.equal(store.schemaStatus().status, "ready");

		const compat = (await (await fetch(`${url}/v1/compat`)).json()) as {
			schema: { status: string; applied: string[] };
			features: Array<{ available: boolean }>;
		};
		assert.equal(compat.schema.status, "ready");
		assert.equal(compat.schema.applied.length, MIGRATIONS.length);
		assert.ok(compat.features.every((f) => f.available));

		// Browser payloads: `sdk` is recorded; an invalid value is ignored, not rejected.
		const browser = (sdk: string) =>
			fetch(`${url}/v1/browser?key=client`, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: JSON.stringify({
					version: 1, service: "web", environment: "production", sdk,
					events: [{ type: "session_start", timestamp: new Date().toISOString() }],
				}),
			});
		const ok = await browser("1.4.0");
		assert.equal(ok.status, 202);
		assert.equal(ok.headers.get("access-control-expose-headers"), "x-autter-ingester-version");
		assert.equal((await browser("<img>")).status, 202);
		await waitFor(() => ch.inserts.runtime_sdk_versions!.some((row) => row.sdk_name === "@autter/runtime-browser"));
		assert.equal(ch.inserts.runtime_sdk_versions!.filter((row) => row.sdk_name === "@autter/runtime-browser").length, 1);
	} finally {
		await close(server);
		await store.close();
		await close(ch.server);
	}
});

test("plain OpenTelemetry SDKs are recorded by language; resources without identity are skipped", () => {
	const sightings = sdkSightingsFromOtlp({
		resourceLogs: [
			{ resource: { attributes: [
				{ key: "service.name", value: { stringValue: "worker" } },
				{ key: "telemetry.sdk.language", value: { stringValue: "python" } },
				{ key: "telemetry.sdk.version", value: { stringValue: "1.27.0" } },
			] } },
			{ resource: { attributes: [{ key: "service.name", value: { stringValue: "anon" } }] } },
		],
	});
	assert.deepEqual(sightings, [{
		service: "worker", environment: "production", sdkName: "opentelemetry-python",
		sdkVersion: "1.27.0", sdkLanguage: "python",
	}]);
	assert.deepEqual(sdkSightingsFromOtlp(null), []);
});

test("SDK tracker refreshes after the window, retries failed writes and never throws", async () => {
	let now = 0;
	const writes: number[] = [];
	let fail = true;
	const errors: unknown[] = [];
	const tracker = new SdkVersionTracker(
		async (_ctx, rows) => {
			if (fail) throw new Error("clickhouse down");
			writes.push(rows.length);
		},
		{ refreshMs: 1000, now: () => now, onError: (err) => errors.push(err) },
	);
	const ctx = { orgId: "o", repositoryId: "r", scope: "server" as const, allowedOrigins: [] };
	const sighting = { service: "s", environment: "e", sdkName: "n", sdkVersion: "1.0.0", sdkLanguage: "" };
	await tracker.observe(ctx, [sighting]);
	assert.equal(errors.length, 1);
	fail = false;
	await tracker.observe(ctx, [sighting, sighting]);
	await tracker.observe(ctx, [sighting]);
	now = 1500;
	await tracker.observe(ctx, [sighting]);
	assert.deepEqual(writes, [1, 1]);
});
