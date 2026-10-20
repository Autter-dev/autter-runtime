import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { captureException, initAutterLogging } from "../dist/index.js";

test("logger-only mode sends `fingerprint` as autter.fingerprint on the promoted error record", async () => {
	const requests = [];
	const collector = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			requests.push({ path: req.url, body: JSON.parse(body) });
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	const logging = initAutterLogging({
		apiKey: "server-key",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		service: "logger-only",
		environment: "test",
		captureGlobalErrors: false,
		autoFlush: false,
		logging: { console: false },
	});
	try {
		captureException(new Error("Loading chunk 12 failed"), { fingerprint: ["chunk-load"], page: "/checkout" });
		captureException(new Error("plain"));
		await logging.flush();
		const records = requests.flatMap((r) => r.body.resourceLogs[0].scopeLogs[0].logRecords);
		const get = (record) => Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue]));
		const promoted = records.map(get).filter((a) => a["autter.capture.mode"] === "log");
		const chunk = promoted.find((a) => a["exception.message"] === "Loading chunk 12 failed");
		assert.equal(chunk["autter.fingerprint"], '["chunk-load"]');
		assert.equal(chunk.page, "/checkout");
		assert.equal("fingerprint" in chunk, false);
		assert.equal(promoted.find((a) => a["exception.message"] === "plain")["autter.fingerprint"], undefined);
	} finally {
		await logging.shutdown();
		await new Promise((resolve) => {
			collector.close(resolve);
			collector.closeAllConnections();
		});
	}
});
