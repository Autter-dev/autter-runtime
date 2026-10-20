import assert from "node:assert/strict";
import { test } from "node:test";
import { withAutter } from "../dist/index.js";

test("rt.captureException sends `fingerprint` as autter.fingerprint on the promoted record", async () => {
	const posts = [];
	const fetch = async (_url, init) => {
		posts.push(JSON.parse(init.body));
		return new Response("{}", { status: 200 });
	};
	const pending = [];
	const ctx = { waitUntil: (promise) => pending.push(promise) };
	const worker = withAutter(
		() => ({ apiKey: "k", service: "edge-api", environment: "test", fetch, endpoint: "https://ingest.test/" }),
		async (_request, _env, _ctx, rt) => {
			rt.captureException(new Error("Loading chunk 12 failed"), { fingerprint: ["chunk-load"], region: "eu" });
			rt.captureException(new Error("plain"), { region: "eu" });
			return new Response("ok");
		},
	);
	await worker.fetch(new Request("https://edge.test/app"), {}, ctx);
	await Promise.all(pending);
	const records = posts
		.flatMap((p) => p.resourceLogs[0].scopeLogs[0].logRecords)
		.map((r) => Object.fromEntries(r.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.arrayValue])));
	const promoted = records.filter((a) => a["autter.capture.mode"] === "log");
	const chunk = promoted.find((a) => a["exception.message"] === "Loading chunk 12 failed");
	assert.equal(chunk["autter.fingerprint"], '["chunk-load"]');
	assert.equal(chunk.region, "eu");
	assert.equal("fingerprint" in chunk, false);
	assert.equal(promoted.find((a) => a["exception.message"] === "plain")["autter.fingerprint"], undefined);
});
