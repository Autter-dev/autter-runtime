import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "../dist/index.js";
import { normalise, runGoldenScenario } from "./fixtures/golden-scenario.mjs";

test("a fixed 1.4.0 operation still exports byte-identical OTLP JSON (1.5.0 additive keys aside)", async () => {
	const golden = readFileSync(
		new URL("./fixtures/golden-1.4.0-logs.json", import.meta.url),
		"utf8",
	);
	const current = await runGoldenScenario(sdk);
	// Additive 1.5.0 summary keys (kind, level) are the ONLY difference.
	const stripped = normalise(
		current.map((body) => body),
		{ stripAdditive: true },
	);
	assert.equal(`${JSON.stringify(stripped, null, "\t")}\n`, golden);
	// …and they are present on every summary.
	const summaries = current
		.flatMap((body) => body.resourceLogs[0].scopeLogs[0].logRecords)
		.filter((record) =>
			record.attributes.some(
				(a) => a.key === "autter.event.type" && a.value.stringValue === "operation",
			),
		);
	assert.equal(summaries.length, 2);
	for (const summary of summaries)
		assert.ok(
			summary.attributes.some(
				(a) => a.key === "autter.operation.kind" && a.value.stringValue === "operation",
			),
		);
});
