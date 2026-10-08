import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
	initAutterServer,
	withRuntimeOperation,
	runtimeLogger,
	flushRuntimeLogs,
} from "../dist/index.js";

test("operation context isolates concurrent requests and exports outcomes, steps and redacted logs", async () => {
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
	const server = initAutterServer({
		service: "checkout",
		apiKey: "test-key",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		logging: { console: false },
		// These collectors treat every request as a log export.
		compatCheck: false,
	});
	try {
		await Promise.all(
			["a", "b"].map((id) =>
				withRuntimeOperation("checkout", async (op) => {
					op.setContext({
						"checkout.id": id,
						token: "secret-value",
						note: "person@example.com",
					});
					await op.step(
						"reserve",
						async () =>
							new Promise((resolve) =>
								setTimeout(resolve, id === "a" ? 15 : 1),
							),
					);
					runtimeLogger.info("reservation complete");
					if (id === "b") op.outcome("failed", "payment timeout");
				}),
			),
		);
		await assert.rejects(
			withRuntimeOperation("throwing", async () => {
				throw new Error("declined");
			}),
			/declined/,
		);
		await flushRuntimeLogs();
		const records = requests
			.filter((r) => r.path === "/v1/logs")
			.flatMap((r) => r.body.resourceLogs[0].scopeLogs[0].logRecords);
		const attributes = (r) =>
			Object.fromEntries(
				r.attributes.map((a) => [
					a.key,
					a.value.stringValue ??
						a.value.doubleValue ??
						a.value.kvlistValue ??
						a.value.arrayValue,
				]),
			);
		const summaries = records.filter(
			(r) => attributes(r)["autter.event.type"] === "operation",
		);
		assert.equal(summaries.length, 3);
		const checkouts = summaries.filter(
			(r) => attributes(r)["autter.operation.name"] === "checkout",
		);
		assert.deepEqual(
			checkouts.map((r) => attributes(r)["checkout.id"]).sort(),
			["a", "b"],
		);
		assert.equal(
			new Set(checkouts.map((r) => attributes(r)["autter.operation.id"])).size,
			2,
		);
		assert.equal(
			attributes(checkouts.find((r) => attributes(r)["checkout.id"] === "b"))[
				"autter.operation.outcome"
			],
			"failed",
		);
		assert.ok(checkouts.every((r) => /^[a-f0-9]{32}$/.test(r.traceId)));
		assert.ok(
			checkouts.every(
				(r) => attributes(r)["autter.operation.steps"].values.length === 1,
			),
		);
		assert.equal(JSON.stringify(records).includes("secret-value"), false);
		assert.equal(JSON.stringify(records).includes("person@example.com"), false);
	} finally {
		await server.shutdown();
		await new Promise((resolve) => collector.close(resolve));
	}
});

test("export retries retain buffered records, enforce limits and report undelivered shutdown", async () => {
	const { runtimeLogStats } = await import("../dist/index.js");
	let fail = true;
	let attempts = 0;
	const records = [];
	const collector = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (req.url === "/v1/logs") {
				attempts++;
				if (fail) {
					res.writeHead(503).end();
					return;
				}
				records.push(
					...JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords,
				);
			}
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	const runtime = initAutterServer({
		service: "limits",
		apiKey: "test-key",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		logging: { console: false },
		// These collectors treat every request as a log export.
		compatCheck: false,
	});
	try {
		const before = runtimeLogStats().dropped;
		for (let i = 0; i < 1001; i++) runtimeLogger.info(`record-${i}`);
		assert.equal(runtimeLogStats().buffered, 1000);
		assert.equal(runtimeLogStats().dropped, before + 1);
		await assert.rejects(flushRuntimeLogs(), /Runtime log export failed/);
		assert.equal(attempts, 3);
		assert.equal(runtimeLogStats().buffered, 1000);
		fail = false;
		await flushRuntimeLogs();
		assert.equal(runtimeLogStats().buffered, 0);
		assert.equal(records.length, 1000);
		runtimeLogger.error(new Error("failure"), { huge: "x".repeat(50000) });
		await flushRuntimeLogs();
		const oversized = records.at(-1);
		assert.ok(JSON.stringify(oversized).length < 40000);
		assert.ok(
			oversized.attributes.some(
				(attribute) =>
					attribute.key === "autter.context.truncated" &&
					attribute.value.boolValue,
			),
		);
		fail = true;
		runtimeLogger.info("shutdown failure");
		await assert.rejects(runtime.shutdown(), /Runtime log export failed/);
		assert.equal(runtimeLogStats().buffered, 0);
		assert.equal(runtimeLogStats().dropped, before + 2);
	} finally {
		await new Promise((resolve) => collector.close(resolve));
	}
});
