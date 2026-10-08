import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	buildCompatReport,
	COMPAT_MANIFEST,
	compareVersions,
	evaluateCompat,
	featuresForBrowserEvents,
	ingesterInfoFromReport,
	versionAtLeast,
} from "./compat.js";
import { MIGRATIONS } from "./migrations.js";
import { browserPayloadSchema } from "./normalize-browser.js";

const ALL = MIGRATIONS.map((m) => m.id);
const pkgVersion = (dir: string) =>
	(JSON.parse(readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")) as { version: string }).version;

test("version comparison handles v-prefixes, prereleases and junk", () => {
	assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
	assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
	assert.equal(compareVersions("1.3.4", "1.4.0"), -1);
	assert.equal(compareVersions("1.4.0-rc.1", "1.4.0"), -1);
	assert.equal(compareVersions("latest", "1.4.0"), null);
	assert.equal(versionAtLeast(null, "1.0.0"), null);
	assert.equal(versionAtLeast("2.0.0", "1.4.0"), true);
});

test("manifest is consistent with migrations, routes and released package versions", () => {
	const ids = new Set<string>();
	const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
	for (const feature of COMPAT_MANIFEST.features) {
		assert.ok(!ids.has(feature.id), `duplicate ${feature.id}`);
		ids.add(feature.id);
		assert.ok(compareVersions(feature.ingester, pkgVersion("otlp-ingester"))! <= 0, `${feature.id}: ingester ${feature.ingester} is unreleased`);
		for (const migration of feature.migrations) assert.ok(ALL.includes(migration), `${feature.id}: unknown migration ${migration}`);
		if (feature.route) assert.ok(server.includes(`app.post("${feature.route}"`), `${feature.id}: no route ${feature.route}`);
		for (const [pkg, min] of Object.entries(feature.sdks)) {
			const dir = pkg.replace("@autter/", "");
			assert.ok(compareVersions(min, pkgVersion(dir))! <= 0, `${feature.id}: ${pkg} ${min} is unreleased`);
		}
		for (const type of feature.browserEvents ?? []) {
			const parsed = browserPayloadSchema.safeParse({
				version: 1, service: "s", environment: "e",
				events: [{ type, timestamp: new Date().toISOString() }],
			});
			assert.ok(parsed.success, `${feature.id}: browser event ${type} not accepted`);
		}
	}
});

test("operation logging on an older ingester names both versions and the fix", () => {
	const issues = evaluateCompat({
		features: ["operation_logging", "memory_metrics"],
		ingester: { version: "1.3.4" },
	});
	assert.equal(issues.length, 1);
	const [issue] = issues;
	assert.equal(issue!.kind, "ingester_too_old");
	assert.equal(issue!.required, "1.4.0");
	assert.equal(issue!.actual, "1.3.4");
	assert.match(issue!.message, /^Operation logging needs ingester >= 1\.4\.0; yours is 1\.3\.4\. Upgrade the ingester: .*otlp-ingester/);
	assert.match(issue!.message, /COMPATIBILITY\.md/);
});

test("no issues when compatible, unknown, or for unknown feature ids", () => {
	const ready = { status: "ready" as const, applied: ALL };
	assert.deepEqual(evaluateCompat({ features: ["operation_logging", "csp_violations"], ingester: { version: "1.4.0", schema: ready } }), []);
	assert.deepEqual(evaluateCompat({ features: ["operation_logging"], ingester: null }), []);
	assert.deepEqual(evaluateCompat({ features: ["operation_logging"], ingester: { version: null, legacy: true } }), []);
	assert.deepEqual(evaluateCompat({ features: ["no_such_feature"], ingester: { version: "0.1.0" } }), []);
	assert.deepEqual(
		evaluateCompat({ features: ["operation_logging"], ingester: { version: "1.4.0", schema: { status: "pending", applied: [] } } }),
		[],
	);
});

test("legacy ingesters are flagged only when a route probe proved the route missing", () => {
	const issues = evaluateCompat({
		features: ["operation_logging", "memory_metrics"],
		ingester: { version: null, legacy: true, routes: { "/v1/logs": false } },
	});
	assert.equal(issues.length, 1);
	assert.match(issues[0]!.message, /1\.4\.0 or older .*no \/v1\/logs route/);
	assert.deepEqual(
		evaluateCompat({ features: ["operation_logging"], ingester: { version: null, legacy: true, routes: { "/v1/logs": true } } }),
		[],
	);
});

test("unapplied or failed migrations are reported with a schema fix", () => {
	const missing = evaluateCompat({
		features: ["operation_logging"],
		ingester: { version: "1.4.0", schema: { status: "ready", applied: ALL.filter((id) => id !== "0011-runtime-logs") } },
	});
	assert.equal(missing[0]!.kind, "schema_not_applied");
	assert.match(missing[0]!.message, /0011-runtime-logs/);
	const failed = evaluateCompat({
		features: ["memory_metrics"],
		ingester: { version: "1.4.0", schema: { status: "failed", applied: [] } },
	});
	assert.match(failed[0]!.message, /schema failed.*CLICKHOUSE_URL/);
});

test("SDK too old for a feature is reported against that SDK package", () => {
	const issues = evaluateCompat({
		features: ["operation_logging"],
		ingester: { version: "1.4.0" },
		sdk: { name: "@autter/runtime-next", version: "1.3.4" },
	});
	assert.equal(issues.length, 1);
	assert.equal(issues[0]!.kind, "sdk_too_old");
	assert.match(issues[0]!.message, /npm install @autter\/runtime-next@latest/);
});

test("browser event types map to their features", () => {
	assert.deepEqual(featuresForBrowserEvents(["exception", "csp_violation"]), ["csp_violations"]);
	assert.deepEqual(featuresForBrowserEvents(["timing"]), ["browser_network_events"]);
});

test("compat report marks availability from version and schema state, and round-trips", () => {
	const pending = buildCompatReport({ version: "1.4.0", schemaStatus: "pending", applied: [], allMigrations: ALL });
	const logs = pending.features.find((f) => f.id === "operation_logging")!;
	assert.equal(logs.ingesterSupported, true);
	assert.equal(logs.available, false);
	assert.equal(pending.features.find((f) => f.id === "csp_violations")!.available, true);
	const ready = buildCompatReport({ version: "1.5.0", schemaStatus: "ready", applied: ALL, allMigrations: ALL });
	assert.equal(ready.schema.level, ALL[ALL.length - 1]);
	assert.ok(ready.features.every((f) => f.available));
	assert.deepEqual(ingesterInfoFromReport(JSON.parse(JSON.stringify(ready))), {
		version: "1.5.0",
		schema: { status: "ready", applied: ALL },
	});
	assert.equal(ingesterInfoFromReport({ ingester: { version: "<script>" } }), null);
	assert.equal(ingesterInfoFromReport("nope"), null);
});
