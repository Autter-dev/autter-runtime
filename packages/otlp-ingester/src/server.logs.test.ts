import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { createIngesterApp } from "./server.js";

const listen = async (server: Server) => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server) =>
	new Promise<void>((resolve) => {
		server.close(resolve);
		server.closeAllConnections();
	});

test("log ingestion authenticates, preserves tenant mapping and refuses malformed or undelivered records", async () => {
	const inserts: Array<Record<string, unknown>> = [];
	let fail = false;
	const ch = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const query =
				new URL(req.url!, "http://localhost").searchParams.get("query") ?? "";
			if (query.includes("INSERT INTO") && query.includes("runtime_logs")) {
				if (fail) {
					res.writeHead(400).end("storage rejected");
					return;
				}
				inserts.push(
					...body
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
				);
			}
			res.end();
		});
	});
	const chUrl = await listen(ch);
	const config: IngesterConfig = {
		port: 0,
		clickhouseUrl: chUrl,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [
			{ key: "server", orgId: "org-owner", repositoryId: "repo-owner" },
			{
				key: "client",
				orgId: "org-owner",
				repositoryId: "repo-owner",
				scope: "client",
			},
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
	const app = createIngesterApp(config).app.listen();
	const url = await new Promise<string>((resolve) =>
		app.once("listening", () =>
			resolve(`http://127.0.0.1:${(app.address() as AddressInfo).port}`),
		),
	);
	const payload = {
		resourceLogs: [
			{
				resource: {
					attributes: [{ key: "org_id", value: { stringValue: "other-org" } }],
				},
				scopeLogs: [
					{
						logRecords: [
							{
								timeUnixNano: "1760000000000000000",
								body: { stringValue: "checkout started" },
							},
						],
					},
				],
			},
		],
	};
	const post = (key: string, body: unknown) =>
		fetch(`${url}/v1/logs`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key}`,
			},
			body: JSON.stringify(body),
		});
	try {
		assert.equal((await post("unknown", payload)).status, 401);
		assert.equal((await post("client", payload)).status, 403);
		assert.equal((await post("server", { resourceLogs: "bad" })).status, 400);
		assert.equal((await post("server", payload)).status, 200);
		assert.equal(inserts.length, 1);
		assert.equal(inserts[0]!.org_id, "org-owner");
		assert.equal(inserts[0]!.repository_id, "repo-owner");
		const proto = await fetch(`${url}/v1/logs`, {
			method: "POST",
			headers: {
				"content-type": "application/x-protobuf",
				authorization: "Bearer server",
			},
			body: Buffer.from([10, 10, 18, 8, 18, 6, 42, 4, 10, 2, 111, 107]),
		});
		assert.equal(proto.status, 200);
		assert.equal(inserts.length, 2);
		assert.equal(inserts[1]!.message, "ok");
		fail = true;
		assert.equal((await post("server", payload)).status, 503);
	} finally {
		await close(app);
		await close(ch);
	}
});
