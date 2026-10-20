import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeTraces } from "../../otlp-ingester/dist/normalize-otlp.js";
import { unhandledRejectionsMode } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "unhandled-rejection.mjs");

let collector;
let collectorPort;
const traceBodies = [];

before(async () => {
	collector = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.url === "/v1/traces") traceBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	collectorPort = collector.address().port;
	await runScenarios();
});

after(() => {
	collector.close();
	collector.closeAllConnections();
});

function run({ mode, env }) {
	const { NODE_OPTIONS: _ignored, ...base } = process.env;
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[...(mode ? [`--unhandled-rejections=${mode}`] : []), fixture],
			{ env: { ...base, COLLECTOR_PORT: String(collectorPort), ...env }, stdio: "pipe" },
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

/** Every occurrence the ingester derives from what one scenario sent. */
function occurrencesFor(service) {
	return traceBodies
		.filter((body) =>
			body.resourceSpans?.some((rs) =>
				rs.resource?.attributes?.some((a) => a.key === "service.name" && a.value?.stringValue === service),
			),
		)
		.flatMap((body) => normalizeTraces(body).occurrences)
		.filter((occurrence) => occurrence.service === service);
}

// Node's own behaviour (AUTTER=0) is the reference: with Autter the exit
// code and whether the process survives must be identical.
const scenarios = [
	{ name: "default-no-listener", expect: { code: 1, survives: false }, telemetry: "fatal" },
	{ name: "default-no-listener-string", env: { REASON: "string" }, expect: { code: 1, survives: false }, telemetry: "fatal-string" },
	{ name: "default-no-listener-no-autoflush", env: { AUTOFLUSH: "0" }, expect: { code: 1, survives: false } },
	{ name: "default-app-listener", env: { APP_LISTENER: "log" }, expect: { code: 0, survives: true }, telemetry: "error" },
	{ name: "default-app-listener-rethrows", env: { APP_LISTENER: "rethrow" }, expect: { code: 1, survives: false }, telemetry: "error" },
	{ name: "default-app-uncaught-handler", env: { APP_UNCAUGHT: "1" }, expect: { code: 0, survives: true }, telemetry: "fatal" },
	{ name: "strict-no-listener", mode: "strict", expect: { code: 1, survives: false }, telemetry: "fatal" },
	{ name: "strict-app-listener", mode: "strict", env: { APP_LISTENER: "log" }, expect: { code: 1, survives: false }, telemetry: "fatal" },
	{ name: "warn-no-listener", mode: "warn", expect: { code: 0, survives: true }, telemetry: "error" },
	{ name: "warn-with-error-code-no-listener", mode: "warn-with-error-code", expect: { code: 1, survives: true }, telemetry: "error" },
	{ name: "none-no-listener", mode: "none", expect: { code: 0, survives: true }, telemetry: "error" },
	{ name: "capture-off-app-listener", env: { APP_LISTENER: "log", CAPTURE_REJECTIONS: "0" }, expect: { code: 0, survives: true }, telemetry: "none" },
];

const results = new Map();

async function runScenarios() {
	await Promise.all(
		scenarios.map(async (scenario) => {
			const env = { ...scenario.env, SERVICE: `rej-${scenario.name}` };
			const [plain, withAutter] = await Promise.all([
				run({ mode: scenario.mode, env: { ...env, AUTTER: "0" } }),
				run({ mode: scenario.mode, env: { ...env, AUTTER: "1" } }),
			]);
			results.set(scenario.name, { plain, withAutter });
		}),
	);
}

for (const scenario of scenarios) {
	test(`crash behaviour unchanged: ${scenario.name}`, () => {
		const { plain, withAutter } = results.get(scenario.name);
		const survived = (run) => /^survived$/m.test(run.out);
		assert.equal(plain.code, scenario.expect.code, `plain node exit code; stderr: ${plain.err}`);
		assert.equal(survived(plain), scenario.expect.survives, "plain node survival");
		assert.equal(withAutter.code, plain.code, `exit code with Autter; stderr: ${withAutter.err}`);
		assert.equal(survived(withAutter), survived(plain), `survival with Autter; stdout: ${withAutter.out}`);
		// The app's own listener still runs. (In strict mode it may also run
		// with Autter while plain Node dies first: autoFlush's
		// uncaughtException handler — 1.5.0 behaviour — keeps the process up
		// for the flush, so Node goes on to emit `unhandledRejection`. Same
		// exit code either way.)
		if (/app listener:/.test(plain.out))
			assert.match(withAutter.out, /app listener: rejection boom/, "the app's listener still runs");
		if (scenario.env?.APP_UNCAUGHT === "1")
			assert.match(withAutter.out, /app uncaught handler: rejection boom/);
		if (!survived(plain)) {
			// Same crash diagnostic: the rejection reason reaches stderr.
			const reason = scenario.env?.REASON === "string" ? /plain rejection reason/ : /rejection boom/;
			assert.match(plain.err, reason);
			assert.match(withAutter.err, reason);
		}
		if (scenario.mode?.startsWith("warn"))
			assert.match(withAutter.err, /UnhandledPromiseRejectionWarning/);
	});
}

test("unhandled rejections Node does not crash on are recorded as errors, crashes stay fatal, one occurrence each", () => {
	for (const scenario of scenarios) {
		if (!scenario.telemetry) continue;
		const occurrences = occurrencesFor(`rej-${scenario.name}`);
		if (scenario.telemetry === "none") {
			assert.equal(occurrences.length, 0, `${scenario.name}: nothing recorded when capture is off`);
			continue;
		}
		assert.equal(occurrences.length, 1, `${scenario.name}: ${JSON.stringify(occurrences.map((o) => [o.errorType, o.message, o.severity]))}`);
		const [occurrence] = occurrences;
		if (scenario.telemetry === "fatal-string") {
			assert.equal(occurrence.severity, "fatal", scenario.name);
			assert.equal(occurrence.errorType, "UnhandledPromiseRejection", scenario.name);
			assert.match(occurrence.message, /The promise rejected with the reason "plain rejection reason"/);
			continue;
		}
		assert.equal(occurrence.severity, scenario.telemetry, scenario.name);
		assert.equal(occurrence.errorType, "Error", scenario.name);
		assert.equal(occurrence.message, "rejection boom", scenario.name);
		// The real stack of the rejection, not a synthetic one.
		assert.match(occurrence.stack ?? "", /unhandled-rejection\.mjs/, scenario.name);
		if (scenario.telemetry === "error")
			assert.equal(occurrence.attributes["autter.unhandled_rejection"], true, scenario.name);
	}
});

test("unhandledRejectionsMode reads NODE_OPTIONS and the command line (command line wins)", () => {
	assert.equal(unhandledRejectionsMode([], undefined), "throw");
	assert.equal(unhandledRejectionsMode(["--unhandled-rejections=strict"], undefined), "strict");
	assert.equal(unhandledRejectionsMode(["--unhandled-rejections", "warn"], undefined), "warn");
	assert.equal(unhandledRejectionsMode(["--unhandled_rejections=none"], undefined), "none");
	assert.equal(unhandledRejectionsMode([], "--max-old-space-size=512 --unhandled-rejections=warn-with-error-code"), "warn-with-error-code");
	assert.equal(unhandledRejectionsMode(["--unhandled-rejections=throw"], "--unhandled-rejections=none"), "throw");
	assert.equal(unhandledRejectionsMode(["--unhandled-rejections=bogus"], undefined), "throw");
});
