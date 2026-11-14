import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const lockfile = JSON.parse(
	readFileSync(new URL("package-lock.json", root), "utf8"),
);
const manifest = JSON.parse(
	readFileSync(
		new URL("packages/runtime-node/package.json", root),
		"utf8",
	),
);

const FIXED = "0.222.0";

function parseVersion(version) {
	return version
		.replace(/^[\^~>=<\s]+/, "")
		.split(/[.-]/)
		.slice(0, 3)
		.map(Number);
}

function isAtLeast(version, minimum) {
	const actual = parseVersion(version);
	const expected = parseVersion(minimum);
	for (let index = 0; index < expected.length; index += 1) {
		if (actual[index] > expected[index]) return true;
		if (actual[index] < expected[index]) return false;
	}
	return true;
}

test("instrumentation-http is pinned past the incoming server-span query redaction fix", () => {
	const entry = lockfile.packages["node_modules/@opentelemetry/instrumentation-http"];
	assert.ok(entry, "instrumentation-http must be resolved in package-lock.json");
	assert.ok(
		isAtLeast(entry.version, FIXED),
		`instrumentation-http ${entry.version} does not include the GHSA-3v2p-hm54-8qcq fix; expected >= ${FIXED}`,
	);

	const declared = manifest.dependencies["@opentelemetry/instrumentation-http"];
	assert.ok(declared, "runtime-node must declare instrumentation-http");
	assert.ok(
		isAtLeast(declared, FIXED),
		`runtime-node declares instrumentation-http ${declared}; expected >= ${FIXED}`,
	);
});
