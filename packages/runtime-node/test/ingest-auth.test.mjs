import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	checkBrowserPayload,
	createBrowserRelayFetchHandler,
	createBrowserRelayHandler,
} from "../dist/index.js";

const index = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** A stub ingester that records every request and answers with `answer`. */
async function stubIngester(answer) {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			requests.push({ url: req.url, authorization: req.headers.authorization ?? null, body });
			const [status, json] = answer(req);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(json));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
	};
}

/** initAutterServer in a child process (it is a per-process singleton). */
function runServerScript(endpoint, init, env = {}) {
	const script = `
		import { initAutterServer, captureException } from ${JSON.stringify(index)};
		const rt = initAutterServer({ endpoint: ${JSON.stringify(endpoint)}, service: "svc", memoryMetrics: false, compatCheck: false, ${init} });
		captureException(new Error("boom"));
		await rt.flush?.();
		await new Promise((r) => setTimeout(r, 300));
		await rt.shutdown();
	`;
	return new Promise((resolve) => {
		const childEnv = { ...process.env, ...env };
		if (!("AUTTER_RUNTIME_KEY" in env)) delete childEnv.AUTTER_RUNTIME_KEY;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: childEnv });
		let output = "";
		child.stdout.on("data", (c) => (output += c));
		child.stderr.on("data", (c) => (output += c));
		child.on("exit", (code) => resolve({ code, output }));
	});
}

for (const [label, init] of [
	["no apiKey", ""],
	["apiKey: undefined", "apiKey: undefined"],
	['apiKey: "undefined" (a stringified unset variable)', 'apiKey: "undefined"'],
	['apiKey: ""', 'apiKey: ""'],
]) {
	test(`initAutterServer with ${label}: one warning, nothing sent, never "Bearer undefined"`, async () => {
		const ingester = await stubIngester(() => [200, { partialSuccess: {} }]);
		try {
			const { code, output } = await runServerScript(ingester.url, init);
			assert.equal(code, 0, output);
			const warnings = output.split("\n").filter((line) => line.includes("No ingest key"));
			assert.equal(warnings.length, 1, output);
			assert.match(warnings[0], /AUTTER_RUNTIME_KEY is not set, so traces, metrics and logs from "svc" are not sent/);
			assert.match(warnings[0], /npx @autter\/runtime-node verify/);
			assert.deepEqual(ingester.requests, [], "nothing may reach the ingester without a key");
		} finally {
			await ingester.close();
		}
	});
}

test("initAutterServer falls back to AUTTER_RUNTIME_KEY", async () => {
	const ingester = await stubIngester(() => [200, { partialSuccess: {} }]);
	try {
		const { code, output } = await runServerScript(ingester.url, "", { AUTTER_RUNTIME_KEY: "autter_rt_from_env" });
		assert.equal(code, 0, output);
		assert.doesNotMatch(output, /No ingest key/);
		const traces = ingester.requests.filter((r) => r.url === "/v1/traces");
		assert.ok(traces.length >= 1, output);
		for (const r of ingester.requests) assert.equal(r.authorization, "Bearer autter_rt_from_env");
	} finally {
		await ingester.close();
	}
});

test("the first 401 is logged once, with the ingester's reason", async () => {
	const ingester = await stubIngester(() => [401, { error: "invalid ingest key" }]);
	try {
		const { code, output } = await runServerScript(ingester.url, 'apiKey: "autter_rt_wrong"');
		assert.equal(code, 0, output);
		const lines = output.split("\n").filter((line) => line.includes("refused the ingest key"));
		assert.equal(lines.length, 1, output);
		assert.match(lines[0], /on \/v1\/traces \(401: invalid ingest key\)/);
		assert.match(lines[0], /Check AUTTER_RUNTIME_KEY/);
	} finally {
		await ingester.close();
	}
});

test("a client key on the server is named at startup", async () => {
	const ingester = await stubIngester(() => [403, { error: "client keys cannot send OTLP — use a server key" }]);
	try {
		const { output } = await runServerScript(ingester.url, 'apiKey: "autter_rtc_public"');
		assert.match(output, /is a client \(browser\) key \(autter_rtc_…\)/);
		assert.match(output, /refused \/v1\/traces \(403: client keys cannot send OTLP/);
	} finally {
		await ingester.close();
	}
});

// ── relay ──────────────────────────────────────────────────────────────

const validPayload = {
	version: 1,
	service: "web",
	environment: "production",
	events: [{ type: "exception", timestamp: new Date().toISOString(), message: "x" }],
};

function captureWarnings() {
	const original = console.warn;
	const lines = [];
	console.warn = (...args) => lines.push(args.join(" "));
	return { lines, restore: () => (console.warn = original) };
}

test("relay without a key answers 500 with the fix and warns once; nothing is forwarded", async () => {
	const saved = process.env.AUTTER_RUNTIME_KEY;
	delete process.env.AUTTER_RUNTIME_KEY;
	const warnings = captureWarnings();
	const ingester = await stubIngester(() => [202, {}]);
	try {
		const handler = createBrowserRelayFetchHandler({ apiKey: undefined, endpoint: ingester.url, compatCheck: false });
		createBrowserRelayFetchHandler({ apiKey: "", endpoint: ingester.url, compatCheck: false });
		const response = await handler(new Request("http://app/api/autter-runtime", { method: "POST", body: JSON.stringify(validPayload) }));
		assert.equal(response.status, 500);
		const body = await response.json();
		assert.equal(body.error, "relay has no ingest key");
		assert.match(body.fix, /AUTTER_RUNTIME_KEY/);
		assert.equal(warnings.lines.filter((l) => l.includes("browser relay has no ingest key")).length, 1, warnings.lines.join("\n"));
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(ingester.requests.length, 0);
	} finally {
		warnings.restore();
		if (saved !== undefined) process.env.AUTTER_RUNTIME_KEY = saved;
		await ingester.close();
	}
});

test("relay 400s name the field: path and problem, like the ingester's issues", async () => {
	const handler = createBrowserRelayFetchHandler({ apiKey: "autter_rt_k", endpoint: "http://127.0.0.1:9", compatCheck: false });
	const bad = { ...validPayload, environment: "", events: [{ type: "nope", timestamp: 5 }] };
	const response = await handler(new Request("http://app/r", { method: "POST", body: JSON.stringify(bad) }));
	assert.equal(response.status, 400);
	const body = await response.json();
	assert.equal(body.error, "invalid payload");
	assert.deepEqual(body.issues.map((i) => i.path), [["environment"], ["events", 0, "type"], ["events", 0, "timestamp"]]);
	assert.match(body.issues[1].message, /expected one of exception, .*got "nope"/);
	assert.match(body.issues[2].message, /ISO 8601 string, got a number/);

	assert.deepEqual(checkBrowserPayload([]).issues[0], { path: [], message: "expected a JSON object, got an array" });
	assert.ok("payload" in checkBrowserPayload(validPayload));
});

test("node relay handler: 400 with issues", async () => {
	const handler = createBrowserRelayHandler({ apiKey: "autter_rt_k", endpoint: "http://127.0.0.1:9", compatCheck: false });
	const result = await new Promise((resolve) => {
		const res = {
			statusCode: 0, headers: {},
			setHeader(k, v) { this.headers[k] = v; },
			end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); },
		};
		handler({ method: "POST", headers: {}, socket: {}, body: { ...validPayload, version: 2 } }, res);
	});
	assert.equal(result.status, 400);
	assert.deepEqual(result.body.issues, [{ path: ["version"], message: "expected 1, got a number" }]);
});

test("relay logs the ingester's refusal of a forwarded batch once", async () => {
	const warnings = captureWarnings();
	const ingester = await stubIngester(() => [401, { error: "invalid ingest key" }]);
	try {
		const handler = createBrowserRelayFetchHandler({ apiKey: "autter_rt_relay_wrong", endpoint: ingester.url, compatCheck: false, perIpRateLimit: false });
		for (let i = 0; i < 3; i++) {
			const response = await handler(new Request("http://app/r", { method: "POST", body: JSON.stringify(validPayload) }));
			assert.equal(response.status, 202);
		}
		for (let i = 0; i < 50 && ingester.requests.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
		await new Promise((r) => setTimeout(r, 50));
		const lines = warnings.lines.filter((l) => l.includes("refused the ingest key on /v1/browser"));
		// Once per process for a 401, whichever exporter saw it first.
		assert.equal(lines.length, 1, warnings.lines.join("\n"));
		assert.match(lines[0], /\(401: invalid ingest key\)\. Nothing is stored until it is fixed: browser events forwarded by the relay are dropped/);
		assert.ok(ingester.requests.every((r) => r.authorization === "Bearer autter_rt_relay_wrong"));
	} finally {
		warnings.restore();
		await ingester.close();
	}
});
