import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import {
	initAutterLogging,
	withRuntimeOperation,
	captureException,
	runtimeContext,
	RuntimeError,
} from "../dist/index.js";

test("initAutterLogging exports logs and coded exceptions without starting NodeSDK", async () => {
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
		let activeSpan;
		await assert.rejects(
			withRuntimeOperation("sync", async () => {
				activeSpan = trace.getActiveSpan();
				runtimeContext.set({ batch: 7 });
				throw new RuntimeError({ code: "sync.upstream_failed", message: "Upstream failed", fix: "Retry" });
			}),
			/Upstream failed/,
		);
		assert.equal(activeSpan, undefined, "no tracing SDK, no spans");
		captureException(new TypeError("outside any operation"));
		await logging.flush();
		assert.ok(requests.every((r) => r.path === "/v1/logs"), "only /v1/logs is used");
		const records = requests.flatMap((r) => r.body.resourceLogs[0].scopeLogs[0].logRecords);
		const get = (record) =>
			Object.fromEntries(record.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.doubleValue]));
		const promoted = records.map(get).filter((a) => a["autter.capture.mode"] === "log");
		assert.equal(promoted.length, 2, "one promoted record per exception (no double capture through nesting)");
		const coded = promoted.find((a) => a["autter.error.code"] === "sync.upstream_failed");
		assert.equal(coded["exception.type"], "RuntimeError");
		assert.equal(coded["exception.message"], "Upstream failed");
		assert.equal(coded["autter.error.fix"], "Retry");
		assert.ok(coded["exception.stacktrace"].includes("Upstream failed"));
		assert.ok(promoted.some((a) => a["exception.type"] === "TypeError"));
		const summary = records.map(get).find((a) => a["autter.event.type"] === "operation");
		assert.equal(summary["autter.operation.outcome"], "failed");
		assert.equal(summary["autter.error.code"], "sync.upstream_failed");
	} finally {
		await logging.shutdown();
		await new Promise((resolve) => {
			collector.close(resolve);
			collector.closeAllConnections();
		});
	}
});
