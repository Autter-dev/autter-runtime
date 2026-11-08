// Relay-only process (no initAutterServer): the relay checks browser
// features against the ingester's version header on its forward responses.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBrowserRelayFetchHandler, sanitizeBrowserPayload } from "../dist/index.js";

const event = (type) => ({ type, timestamp: new Date().toISOString(), message: "m" });

async function ingester(handler) {
	const bodies = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			bodies.push(body ? JSON.parse(body) : null);
			handler(res);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		bodies,
		close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
	};
}

const until = async (check, ms = 2000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
};

test("the relay forwards a valid browser SDK version and drops a malformed one", () => {
	const base = { version: 1, service: "web", environment: "production", events: [event("exception")] };
	assert.equal(sanitizeBrowserPayload({ ...base, sdk: "1.4.0" }).sdk, "1.4.0");
	assert.equal(sanitizeBrowserPayload({ ...base, sdk: "<script>" }).sdk, undefined);
});

test("relay warns once when CSP events reach an ingester without CSP support", async () => {
	const warnings = [];
	const original = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	const old = await ingester((res) => {
		res.setHeader("x-autter-ingester-version", "1.3.3");
		res.writeHead(202).end("{}");
	});
	try {
		const POST = createBrowserRelayFetchHandler({ apiKey: "k", endpoint: old.url, perIpRateLimit: false });
		const send = () =>
			POST(new Request("http://app.test/api/autter", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version: 1, service: "web", environment: "production", sdk: "1.4.0", events: [event("csp_violation")] }),
			}));
		assert.equal((await send()).status, 202);
		await until(() => warnings.some((w) => w.includes("CSP")));
		assert.equal((await send()).status, 202);
		await until(() => old.bodies.length === 2);
		await new Promise((r) => setTimeout(r, 50));
		const csp = warnings.filter((w) => w.includes("CSP"));
		assert.equal(csp.length, 1, warnings.join("\n"));
		assert.match(csp[0], /Browser CSP violation capture needs ingester >= 1\.3\.4; yours is 1\.3\.3\. Upgrade the ingester/);
		assert.equal(old.bodies[0].sdk, "1.4.0", "browser SDK version is forwarded");
	} finally {
		console.warn = original;
		await old.close();
	}
});

test("the relay retries a forward the ingester answers 503 (Retry-After) or 429, never a 401", async () => {
	const answers = [[503, { "retry-after": "1" }], [429, {}], [202, {}], [401, {}]];
	const at = [];
	const server = await ingester((res) => {
		at.push(Date.now());
		const [status, headers] = answers.shift() ?? [202, {}];
		res.writeHead(status, headers).end("{}");
	});
	try {
		const POST = createBrowserRelayFetchHandler({ apiKey: "k", endpoint: server.url, perIpRateLimit: false, compatCheck: false });
		const send = () =>
			POST(new Request("http://app.test/api/autter", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version: 1, service: "web", environment: "production", events: [event("csp_violation")] }),
			}));
		assert.equal((await send()).status, 202);
		await until(() => server.bodies.length === 3, 5000);
		assert.equal(server.bodies.length, 3);
		assert.deepEqual(server.bodies[2], server.bodies[0]);
		assert.ok(at[1] - at[0] >= 950, `waited for Retry-After (${at[1] - at[0]} ms)`);
		assert.ok(at[2] - at[1] >= 1900, `then backed off (${at[2] - at[1]} ms)`);

		assert.equal((await send()).status, 202);
		await until(() => server.bodies.length === 4);
		await new Promise((r) => setTimeout(r, 1200));
		assert.equal(server.bodies.length, 4, "a 401 is final");
	} finally {
		await server.close();
	}
});
