import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const lockfile = JSON.parse(
	readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8"),
);

function parseVersion(version) {
	return version.split(/[.-]/).slice(0, 3).map(Number);
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

test("body-parser is pinned past the compressed-body trailing-bytes DoS fix", () => {
	const entry = lockfile.packages["node_modules/body-parser"];
	assert.ok(entry, "body-parser must be resolved in package-lock.json");
	assert.ok(
		isAtLeast(entry.version, "1.20.9"),
		`body-parser ${entry.version} is vulnerable to GHSA-27r3-jxmh-p828; expected >= 1.20.9`,
	);
});
