// What a service says it runs: its environment, its commit and its release
// (src/deployment.ts), and that initAutterServer and initAutterLogging send
// them. The rules:
//
// - environment: the option, else NODE_ENV, else `test` when a test runner
//   is detected (JEST_WORKER_ID, VITEST, NODE_TEST_CONTEXT), else
//   `production`. An explicit value always wins.
// - commit: the first commit variable (COMMIT_ENV_VARS) holding 7-40
//   hexadecimal characters, sent as the resource attribute
//   `deployment.commit` whenever one is found. Never read from git.
// - release: the option, else AUTTER_RELEASE, else the commit (full value).
//   `release: false` or AUTTER_DETECT_RELEASE=false: no release.
//
// This file itself runs under `node --test`, which sets NODE_TEST_CONTEXT:
// the child processes below get an environment with every variable these
// rules read removed, then only what each case sets.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { enrichDeployment } from "../dist/index.js";
import { until } from "./support/wait.mjs";

const {
	COMMIT_ENV_VARS,
	COMMIT_RE,
	LEGACY_RELEASE_ENV_VARS,
	TEST_RUNNER_ENV_VARS,
	defaultRelease,
	detectCommit,
	detectCommitFrom,
	resolveEnvironment,
	resolveRelease,
} = await tsImport("../src/deployment.ts", import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHORT = "abc1234";

// ---------------------------------------------------------------- helpers

test("environment: an explicit option wins, then NODE_ENV, then test under a runner, then production", () => {
	assert.equal(resolveEnvironment(undefined, {}), "production");
	for (const name of ["JEST_WORKER_ID", "VITEST", "NODE_TEST_CONTEXT"]) {
		assert.equal(resolveEnvironment(undefined, { [name]: "1" }), "test", name);
		assert.equal(resolveEnvironment(undefined, { [name]: "1", NODE_ENV: "staging" }), "staging", `${name} + NODE_ENV`);
		assert.equal(resolveEnvironment("production", { [name]: "1" }), "production", `${name} + option`);
	}
	assert.equal(resolveEnvironment(undefined, { NODE_ENV: "development" }), "development");
	assert.equal(resolveEnvironment("eu-prod", { NODE_ENV: "development" }), "eu-prod");
	// Set but empty is not set.
	assert.equal(resolveEnvironment(undefined, { VITEST: "" }), "production");
	assert.deepEqual([...TEST_RUNNER_ENV_VARS], ["JEST_WORKER_ID", "VITEST", "NODE_TEST_CONTEXT"]);
});

test("commit: only 7 to 40 hexadecimal characters, first valid variable in the shared order", () => {
	// Autter's own, then the source-map CLI's four in its order, then the rest.
	assert.deepEqual([...COMMIT_ENV_VARS], [
		"AUTTER_COMMIT", "GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA", "CF_PAGES_COMMIT_SHA", "GIT_SHA", "GIT_COMMIT",
		"COMMIT_SHA", "SOURCE_COMMIT", "RENDER_GIT_COMMIT", "RAILWAY_GIT_COMMIT_SHA", "HEROKU_SLUG_COMMIT",
		"SOURCE_VERSION",
	]);
	assert.deepEqual([...LEGACY_RELEASE_ENV_VARS], ["GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA", "CF_PAGES_COMMIT_SHA", "GIT_SHA"]);
	assert.deepEqual(COMMIT_ENV_VARS.slice(1, 5), [...LEGACY_RELEASE_ENV_VARS]);
	assert.equal(detectCommit({}), undefined);
	assert.equal(detectCommit({ GIT_SHA: SHA }), SHA);
	assert.equal(detectCommit({ GIT_SHA: `  ${SHORT}\n` }), SHORT);
	assert.equal(detectCommit({ GIT_SHA: SHA.toUpperCase() }), SHA.toUpperCase());
	for (const bad of ["abc123", `${SHA}0`, "main", "refs/heads/main", "v1.2.3", "0123abz", "", "   "]) {
		assert.equal(detectCommit({ GIT_SHA: bad }), undefined, JSON.stringify(bad));
		assert.ok(!COMMIT_RE.test(bad.trim()), bad);
	}
	// An earlier variable wins; one that is not a commit is skipped.
	assert.deepEqual(detectCommitFrom({ AUTTER_COMMIT: SHORT, GITHUB_SHA: SHA }), { commit: SHORT, source: "AUTTER_COMMIT" });
	assert.deepEqual(detectCommitFrom({ GIT_SHA: SHORT, GITHUB_SHA: SHA }), { commit: SHA, source: "GITHUB_SHA" }, "GITHUB_SHA before GIT_SHA, as the CLI");
	assert.deepEqual(detectCommitFrom({ SOURCE_VERSION: "pr/12", GIT_SHA: "main", HEROKU_SLUG_COMMIT: SHA }), { commit: SHA, source: "HEROKU_SLUG_COMMIT" });
	for (const name of COMMIT_ENV_VARS) assert.equal(detectCommit({ [name]: SHA }), SHA, name);
});

test("release: explicit wins, then AUTTER_RELEASE, then the full commit; false or AUTTER_DETECT_RELEASE=false is none", () => {
	assert.equal(resolveRelease(undefined, {}), undefined);
	assert.equal(resolveRelease(undefined, { GITHUB_SHA: SHA }), SHA);
	assert.equal(resolveRelease(undefined, { GITHUB_SHA: SHA, AUTTER_RELEASE: "2024.06.1" }), "2024.06.1");
	assert.equal(resolveRelease("v2", { GITHUB_SHA: SHA, AUTTER_RELEASE: "2024.06.1" }), "v2");
	assert.equal(resolveRelease("", { GITHUB_SHA: SHA }), SHA, "an empty release is no release given");
	assert.equal(resolveRelease(false, { GITHUB_SHA: SHA, AUTTER_RELEASE: "r" }), undefined);
	for (const off of ["false", "FALSE", "0", "no", "off"]) {
		assert.equal(resolveRelease(undefined, { GITHUB_SHA: SHA, AUTTER_RELEASE: "r", AUTTER_DETECT_RELEASE: off }), undefined, off);
		assert.equal(resolveRelease("v2", { AUTTER_DETECT_RELEASE: off }), "v2", `explicit beats ${off}`);
	}
	assert.equal(resolveRelease(undefined, { GITHUB_SHA: SHA, AUTTER_DETECT_RELEASE: "true" }), SHA);
	assert.equal(resolveRelease(undefined, { GIT_SHA: "main" }), undefined, "a value that is not a commit is not a release");
	assert.equal(defaultRelease({ AUTTER_RELEASE: "  r1 " }), "r1");
});

test("the SDK's default release is the release the source-map CLI uploads under, for a commit in any one variable", async () => {
	// The CLI's resolver from source (it bundles src/deployment.ts by path).
	const cli = await tsImport("../../runtime-cli/src/release.ts", import.meta.url);
	assert.deepEqual([...cli.RELEASE_ENV_VARS], [...LEGACY_RELEASE_ENV_VARS]);
	for (const name of COMMIT_ENV_VARS) {
		for (const commit of [SHA, SHORT]) {
			const env = { [name]: commit };
			assert.equal(defaultRelease(env), commit, name);
			assert.deepEqual(cli.resolveRelease(undefined, env), { release: commit, source: name }, name);
		}
	}
	const named = { AUTTER_RELEASE: "r9", GITHUB_SHA: SHA };
	assert.equal(defaultRelease(named), cli.resolveRelease(undefined, named).release);
});

test("enrichDeployment: deployment.commit only for a commit, from the shared list", () => {
	const run = (env) => {
		const event = { attributes: {} };
		enrichDeployment(env)(event, {});
		return event.attributes;
	};
	assert.deepEqual(run({ RENDER_GIT_COMMIT: SHA, AWS_REGION: "eu-west-1" }), { "deployment.region": "eu-west-1", "deployment.commit": SHA });
	assert.deepEqual(run({ GIT_SHA: "main" }), {});
	assert.deepEqual(run({ GIT_SHA: "not-a-sha", AUTTER_COMMIT: SHORT }), { "deployment.commit": SHORT });
});

// ------------------------------------------------- what the SDK sends

/** Every variable the rules read, removed from each child's environment. */
const RULE_VARS = [...TEST_RUNNER_ENV_VARS, ...COMMIT_ENV_VARS, "NODE_ENV", "AUTTER_RELEASE", "AUTTER_DETECT_RELEASE"];

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

const value = (v) => v?.stringValue ?? v?.intValue ?? v?.boolValue ?? v?.doubleValue;
const attrs = (list) => Object.fromEntries((list ?? []).map((a) => [a.key, value(a.value)]));

/** The resources one service sent: of its spans, and of its log records. */
function resourcesOf(service) {
	const spans = [];
	const logs = [];
	for (const { body } of received) {
		for (const rs of body.resourceSpans ?? []) {
			const resource = attrs(rs.resource?.attributes);
			if (resource["service.name"] === service) spans.push(resource);
		}
		for (const rl of body.resourceLogs ?? []) {
			// Log records name it with the newer semconv key.
			const { "deployment.environment.name": environment, ...resource } = attrs(rl.resource?.attributes);
			if (resource["service.name"] === service) logs.push({ ...resource, "deployment.environment": environment });
		}
	}
	return { spans, logs };
}

let serial = 0;

/**
 * Start the SDK in a child process (`mode`: "server" for initAutterServer,
 * "logging" for initAutterLogging) with `options` and only the rule
 * variables in `env`; emit one span (server mode) and one log record; shut
 * down. Returns the resources the collector received.
 */
async function run(mode, options = {}, env = {}) {
	const service = `env-${mode}-${++serial}`;
	const script = `
		import { trace } from "@opentelemetry/api";
		import { initAutterLogging, initAutterServer, runtimeLogger } from "./dist/index.js";
		const base = {
			apiKey: "k", service: process.env.SERVICE, endpoint: process.env.ENDPOINT,
			captureGlobalErrors: false, autoFlush: false, logging: { console: false, file: false },
		};
		const options = { ...base, ...JSON.parse(process.env.OPTIONS) };
		if (process.env.MODE === "server") {
			const sdk = initAutterServer({ ...options, traceSampleRate: 1, memoryMetrics: false, compatCheck: false, metricIntervalMs: 3_600_000 });
			trace.getTracer("t").startSpan("work").end();
			runtimeLogger.info("hello");
			await sdk.shutdown();
		} else {
			const logging = initAutterLogging(options);
			runtimeLogger.info("hello");
			await logging.flush();
			await logging.shutdown();
		}
	`;
	const childEnv = { ...process.env };
	for (const name of RULE_VARS) delete childEnv[name];
	Object.assign(childEnv, env, { ENDPOINT: endpoint, SERVICE: service, MODE: mode, OPTIONS: JSON.stringify(options) });
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: join(here, ".."),
		env: childEnv,
		stdio: ["ignore", "inherit", "inherit"],
	});
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 0);
	// shutdown() awaited the exports; poll in case a response raced the exit.
	await until(() => {
		const got = resourcesOf(service);
		return got.logs.length > 0 && (mode !== "server" || got.spans.length > 0);
	}, 10_000);
	const got = resourcesOf(service);
	assert.ok(got.logs.length > 0, "log records exported");
	if (mode === "server") assert.ok(got.spans.length > 0, "spans exported");
	return got;
}

/** One value of `key` across every resource the service sent (they must agree). */
function only(resources, key) {
	const values = new Set(resources.map((resource) => resource[key]));
	assert.equal(values.size, 1, `${key}: ${JSON.stringify([...values])}`);
	return [...values][0];
}

test("initAutterServer: production outside a test runner, test under one, explicit values win", async () => {
	const outside = await run("server");
	assert.equal(only(outside.spans, "deployment.environment"), "production");
	assert.equal(only(outside.logs, "deployment.environment"), "production");
	assert.equal(only(outside.spans, "service.version"), undefined);
	assert.equal(only(outside.spans, "deployment.commit"), undefined);

	const nodeTest = await run("server", {}, { NODE_TEST_CONTEXT: "child" });
	assert.equal(only(nodeTest.spans, "deployment.environment"), "test");
	assert.equal(only(nodeTest.logs, "deployment.environment"), "test");

	const jest = await run("server", {}, { JEST_WORKER_ID: "1", NODE_ENV: "staging" });
	assert.equal(only(jest.spans, "deployment.environment"), "staging", "NODE_ENV wins over the runner");

	const vitest = await run("server", { environment: "production" }, { VITEST: "true" });
	assert.equal(only(vitest.spans, "deployment.environment"), "production", "the option wins over the runner");
});

test("initAutterServer: the detected commit is deployment.commit and, by default, the release", async () => {
	const detected = await run("server", {}, { GITHUB_SHA: SHA });
	assert.equal(only(detected.spans, "deployment.commit"), SHA);
	assert.equal(only(detected.spans, "service.version"), SHA);
	assert.equal(only(detected.logs, "service.version"), SHA, "log records carry the same release");
	assert.equal(only(detected.logs, "deployment.commit"), SHA, "and the same commit");

	const explicit = await run("server", { release: "v2" }, { GITHUB_SHA: SHA, AUTTER_RELEASE: "r9" });
	assert.equal(only(explicit.spans, "service.version"), "v2");
	assert.equal(only(explicit.spans, "deployment.commit"), SHA, "the commit is sent whatever the release");

	const named = await run("server", {}, { GITHUB_SHA: SHA, AUTTER_RELEASE: "r9" });
	assert.equal(only(named.spans, "service.version"), "r9");

	const off = await run("server", { release: false }, { GIT_SHA: SHORT });
	assert.equal(only(off.spans, "service.version"), undefined);
	assert.equal(only(off.logs, "service.version"), undefined);
	assert.equal(only(off.spans, "deployment.commit"), SHORT);
	assert.equal(only(off.logs, "deployment.commit"), SHORT, "the commit is on log records whatever the release");

	const envOff = await run("server", {}, { GIT_SHA: SHORT, AUTTER_RELEASE: "r9", AUTTER_DETECT_RELEASE: "false" });
	assert.equal(only(envOff.spans, "service.version"), undefined);
	assert.equal(only(envOff.spans, "deployment.commit"), SHORT);

	const notCommit = await run("server", {}, { GIT_SHA: "main" });
	assert.equal(only(notCommit.spans, "service.version"), undefined);
	assert.equal(only(notCommit.spans, "deployment.commit"), undefined);
	assert.equal(only(notCommit.logs, "deployment.commit"), undefined);
});

test("initAutterLogging: the same environment and release defaults", async () => {
	const outside = await run("logging");
	assert.equal(only(outside.logs, "deployment.environment"), "production");
	assert.equal(only(outside.logs, "service.version"), undefined);
	assert.equal(only(outside.logs, "deployment.commit"), undefined);

	const vitest = await run("logging", {}, { VITEST: "true", RAILWAY_GIT_COMMIT_SHA: SHA });
	assert.equal(only(vitest.logs, "deployment.environment"), "test");
	assert.equal(only(vitest.logs, "service.version"), SHA);
	assert.equal(only(vitest.logs, "deployment.commit"), SHA, "logger-only mode sends the commit too");

	const explicit = await run("logging", { environment: "eu", release: "v3" }, { VITEST: "true", GIT_SHA: SHA, NODE_ENV: "development" });
	assert.equal(only(explicit.logs, "deployment.environment"), "eu");
	assert.equal(only(explicit.logs, "service.version"), "v3");

	const off = await run("logging", { release: false }, { GIT_SHA: SHA });
	assert.equal(only(off.logs, "service.version"), undefined);
	assert.equal(only(off.logs, "deployment.commit"), SHA);
});
