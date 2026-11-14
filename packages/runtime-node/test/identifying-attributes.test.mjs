// Identifying attributes (client address, raw user agent, host id and
// addresses, command line and owner) never leave the process by default, whoever set
// them: HttpInstrumentation on server and client spans, sdk-node's process
// and host resource detectors, the app's own spans, events and links. Each
// case runs initAutterServer in a child process against a local collector,
// so the real detectors and instrumentation run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../../../test-vectors/redaction.json"), "utf8")).identifying;
const DROP = vectors.drop;

/** Every OTLP body received: { path, body }. */
const received = [];
let collector;
let endpoint;

before(async () => {
	collector = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			try {
				received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
			} catch {
				/* not JSON: not ours */
			}
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	endpoint = `http://127.0.0.1:${collector.address().port}`;
});

after(async () => {
	await new Promise((resolve) => {
		collector.close(resolve);
		collector.closeAllConnections();
	});
});

const until = async (check, ms = 5000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
	return check();
};

const value = (v) => v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue ?? v?.arrayValue;
const attrs = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, value(a.value)]));

/** What one service exported: span, event and link attributes, and the
 * resources of its spans and metrics. */
function exportedBy(service) {
	const out = { spans: [], events: [], links: [], spanResources: [], metricResources: [] };
	for (const { path, body } of received) {
		for (const rs of body.resourceSpans ?? []) {
			const resource = attrs(rs.resource?.attributes);
			if (resource["service.name"] !== service) continue;
			out.spanResources.push(resource);
			for (const ss of rs.scopeSpans ?? [])
				for (const span of ss.spans ?? []) {
					out.spans.push({ name: span.name, kind: span.kind, attributes: attrs(span.attributes) });
					for (const event of span.events ?? []) out.events.push(attrs(event.attributes));
					for (const link of span.links ?? []) out.links.push(attrs(link.attributes));
				}
		}
		if (path === "/v1/metrics")
			for (const rm of body.resourceMetrics ?? []) {
				const resource = attrs(rm.resource?.attributes);
				if (resource["service.name"] === service) out.metricResources.push(resource);
			}
	}
	return out;
}

/** Every attribute bag the service exported. */
const bags = (exported) => [
	...exported.spans.map((span) => span.attributes),
	...exported.events,
	...exported.links,
	...exported.spanResources,
	...exported.metricResources,
];

/** initAutterServer with `options`, one incoming request through
 * HttpInstrumentation (with a user agent and X-Forwarded-For) and its
 * outgoing client call, one manual span carrying identifying keys on its
 * attributes, an event and a link; then shutdown (flushes spans and metrics). */
async function run(service, options = {}, env = {}) {
	const script = `
		import { createRequire } from "node:module";
		import { trace } from "@opentelemetry/api";
		import { initAutterServer } from "./dist/index.js";
		const sdk = initAutterServer({
			apiKey: "k", service: process.env.SERVICE, endpoint: process.env.ENDPOINT, traceSampleRate: 1,
			captureGlobalErrors: false, autoFlush: false, memoryMetrics: false, compatCheck: false,
			metricIntervalMs: 3_600_000, logging: { console: false },
			...JSON.parse(process.env.OPTIONS),
		});
		const http = createRequire(import.meta.url)("http");
		const server = http.createServer((req, res) => res.end("ok"));
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		await new Promise((resolve, reject) => {
			http.get({
				host: "127.0.0.1", port: server.address().port, path: "/hello",
				headers: { "user-agent": "Mozilla/5.0 (Macintosh) identifying-test", "x-forwarded-for": "203.0.113.9" },
			}, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
		});
		await new Promise((resolve) => server.close(resolve));
		const span = trace.getTracer("t").startSpan("manual", {
			attributes: { "client.address": "198.51.100.7", "user_agent.original": "curl/8", "host.name": "janes-laptop",
				"http.route": "/x", "user.email": "kept@example.com" },
			links: [{
				context: { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 },
				attributes: { "network.peer.address": "198.51.100.8", "link.note": "kept" },
			}],
		});
		span.addEvent("peer", { "net.peer.ip": "198.51.100.9", "event.note": "kept" });
		span.end();
		await sdk.shutdown();
	`;
	const childEnv = { ...process.env, ENDPOINT: endpoint, SERVICE: service, OPTIONS: JSON.stringify(options), ...env };
	for (const name of ["AUTTER_KEEP_IDENTIFYING_ATTRIBUTES", "AUTTER_DROP_ATTRIBUTES"])
		if (!(name in env)) delete childEnv[name];
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: join(here, ".."),
		env: childEnv,
		stdio: ["ignore", "inherit", "inherit"],
	});
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 0);
	// shutdown() awaited both exports; poll in case a response raced the exit.
	await until(() => {
		const exported = exportedBy(service);
		return exported.spans.some((span) => span.name === "manual") && exported.metricResources.length > 0;
	});
	const exported = exportedBy(service);
	assert.ok(exported.spans.some((span) => span.name === "manual"), "manual span exported");
	assert.ok(exported.spans.some((span) => span.kind === 2), "HTTP server span exported");
	assert.ok(exported.metricResources.length > 0, "metrics exported");
	return exported;
}

const present = (exported, key) => bags(exported).some((bag) => key in bag);

function assertKeptIdentity(exported) {
	// Never dropped: the ingester needs service.instance.id; the runtime,
	// pid and architecture describe the process without identifying anyone.
	for (const resource of [...exported.spanResources, ...exported.metricResources])
		assert.ok(resource["service.instance.id"], "service.instance.id survives");
	assert.ok(exported.spanResources.some((resource) => resource["process.pid"] !== undefined), "process.pid survives");
	assert.ok(exported.spanResources.some((resource) => resource["process.runtime.name"] === "nodejs"), "process.runtime.* survives");
	assert.ok(exported.spanResources.some((resource) => resource["host.arch"]), "host.arch survives");
	// host.name is kept (container and pod names) unless dropAttributes lists it.
	assert.ok(exported.spanResources.some((resource) => resource["host.name"]), "host.name survives");
	const manual = exported.spans.find((span) => span.name === "manual");
	assert.equal(manual.attributes["http.route"], "/x");
	assert.equal(exported.events.find((event) => "event.note" in event)?.["event.note"], "kept");
	assert.equal(exported.links.find((link) => "link.note" in link)?.["link.note"], "kept");
}

test("by default no identifying attribute leaves the process (spans, events, links, resources)", async () => {
	const exported = await run("identifying-default");
	for (const key of DROP) assert.ok(!present(exported, key), `${key} was exported`);
	assertKeptIdentity(exported);
});

test("the drop applies with redactAttributes: false", async () => {
	const exported = await run("identifying-no-redact", { redactAttributes: false });
	for (const key of DROP) assert.ok(!present(exported, key), `${key} was exported`);
	assertKeptIdentity(exported);
	// Redaction itself stays off, as configured.
	assert.equal(exported.spans.find((span) => span.name === "manual").attributes["user.email"], "kept@example.com");
});

test("keepIdentifyingAttributes: true keeps them all", async () => {
	const exported = await run("identifying-keep-all", { keepIdentifyingAttributes: true });
	// What OpenTelemetry really emits here, now let through.
	for (const key of ["net.peer.ip", "net.peer.port", "net.host.ip", "http.client_ip", "http.user_agent", "client.address",
		"user_agent.original", "network.peer.address"])
		assert.ok(present(exported, key), `${key} kept`);
	for (const key of ["host.id", "process.command_args", "process.executable.path", "process.owner"])
		assert.ok(exported.spanResources.some((resource) => key in resource), `${key} kept on the resource`);
	assert.ok(exported.metricResources.some((resource) => "host.id" in resource), "host.id kept on the metrics resource");
	const server = exported.spans.find((span) => span.kind === 2);
	assert.equal(server.attributes["http.user_agent"], "Mozilla/5.0 (Macintosh) identifying-test");
	assert.equal(server.attributes["http.client_ip"], "203.0.113.9");
	assertKeptIdentity(exported);
});

test("keepIdentifyingAttributes: [keys] keeps those keys only", async () => {
	const exported = await run("identifying-keep-some", { keepIdentifyingAttributes: ["http.user_agent", "host.id"] });
	assert.ok(present(exported, "http.user_agent"), "http.user_agent kept");
	assert.ok(exported.spanResources.some((resource) => "host.id" in resource), "host.id kept");
	for (const key of DROP.filter((key) => key !== "http.user_agent" && key !== "host.id"))
		assert.ok(!present(exported, key), `${key} was exported`);
	assertKeptIdentity(exported);
});

test("AUTTER_KEEP_IDENTIFYING_ATTRIBUTES: a comma-separated list, or true", async () => {
	const some = await run("identifying-env-some", {}, { AUTTER_KEEP_IDENTIFYING_ATTRIBUTES: "net.peer.ip, process.owner" });
	assert.ok(present(some, "net.peer.ip"), "net.peer.ip kept");
	assert.ok(some.spanResources.some((resource) => "process.owner" in resource), "process.owner kept");
	for (const key of DROP.filter((key) => key !== "net.peer.ip" && key !== "process.owner"))
		assert.ok(!present(some, key), `${key} was exported`);

	const all = await run("identifying-env-all", {}, { AUTTER_KEEP_IDENTIFYING_ATTRIBUTES: "true" });
	assert.ok(present(all, "http.user_agent") && present(all, "host.id"), "everything kept");

	// The option wins over the environment.
	const option = await run("identifying-env-overridden", { keepIdentifyingAttributes: false }, { AUTTER_KEEP_IDENTIFYING_ATTRIBUTES: "true" });
	for (const key of DROP) assert.ok(!present(option, key), `${key} was exported`);
});

test("dropAttributes / AUTTER_DROP_ATTRIBUTES drop more keys (host.name)", async () => {
	const option = await run("identifying-drop-option", { dropAttributes: ["host.name", "http.route"], redactAttributes: false });
	for (const key of [...DROP, "host.name", "http.route"]) assert.ok(!present(option, key), `${key} was exported`);
	assert.ok(option.spanResources.some((resource) => resource["service.instance.id"]), "service.instance.id survives");

	const env = await run("identifying-drop-env", {}, { AUTTER_DROP_ATTRIBUTES: "host.name" });
	assert.ok(!present(env, "host.name"), "host.name was exported");
	for (const key of DROP) assert.ok(!present(env, key), `${key} was exported`);
});
