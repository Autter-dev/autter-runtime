#!/usr/bin/env node
/**
 * The quickstart and the JavaScript examples, end to end, against the repo's
 * own `docker compose up` (ClickHouse 24.8 + the ingester with its built-in
 * local key): each example runs as the docs say, with no AUTTER_* variables
 * set, and the rows it sent are read back from ClickHouse.
 *
 *   docker compose up -d --build --wait
 *   npm install && npm run build
 *   node scripts/examples-e2e.mjs
 *
 * Checks, in order:
 *   1. `doctor` passes against the local ingester with the local key;
 *   2. examples/express-app: `npm start` (prestart copies the browser SDK),
 *      says it sends to http://localhost:4318, serves the SDK and every chunk
 *      it imports, and its server error, request summary and a browser error
 *      through its relay are stored;
 *   3. examples/edge-worker: the Worker's fetch handler, run in Node with
 *      .dev.vars.example as its env; its request summary is stored;
 *   4. examples/runtime-relay: the Worker, run in Node with .dev.vars.example
 *      as its env; a browser error posted through it is stored;
 *   5. with AUTTER_ENDPOINT set and no key, the Express example refuses to
 *      start instead of sending anywhere.
 * The Python recipes have their own runner (examples/python/testing/compose_e2e.py).
 * Exits non-zero on the first failure.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INGESTER = "http://localhost:4318";
const CH = (process.env.CLICKHOUSE_URL ?? "http://localhost:8123").replace(/\/$/, "");
const CH_USER = process.env.CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "dev";
const LOCAL_DEV_KEY = "autter_rt_local_dev_only";
const RUN = `e2e-${Date.now().toString(36)}`;
const EXPRESS_PORT = 3917;
const STARTED = new Date().toISOString().replace("T", " ").replace("Z", "");
const children = new Set();

const ok = (message) => console.log(`  ✔ ${message}`);
function check(condition, message, detail) {
	if (condition) return ok(message);
	throw new Error(`${message}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

async function sql(query) {
	const res = await fetch(`${CH}/?database=autter_runtime`, {
		method: "POST",
		headers: { "x-clickhouse-user": CH_USER, "x-clickhouse-key": CH_PASSWORD },
		body: `${query} FORMAT JSONEachRow`,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`);
	return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

/** Poll until the query returns a row (exporters batch; the ingester inserts async). */
async function row(query, what, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const rows = await sql(query);
		if (rows.length) {
			ok(`stored: ${what}`);
			return rows[0];
		}
		if (Date.now() > deadline) throw new Error(`no row after ${timeoutMs / 1000}s: ${what}\n  ${query}`);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

/** Env without any AUTTER_* or OTEL_* setting: the examples' own defaults. */
function cleanEnv(extra = {}) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTTER_|OTEL_)/.test(k)));
	return { ...env, ...extra };
}

function run(command, args, options = {}) {
	const windows = process.platform === "win32";
	// Own process group off Windows, so stopping `npm start` stops the app too.
	const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: windows, detached: !windows, ...options });
	children.add(child);
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	const exited = new Promise((resolve) => child.on("exit", (code) => (children.delete(child), resolve(code))));
	const stop = (signal = "SIGTERM") => {
		try {
			if (windows) child.kill(signal);
			else process.kill(-child.pid, signal);
		} catch {
			// already gone
		}
	};
	return { child, exited, stop, output: () => output };
}

/** `.dev.vars` format: KEY=value lines, # comments. */
function devVars(path) {
	const vars = {};
	for (const line of readFileSync(join(ROOT, path), "utf8").split(/\r?\n/)) {
		const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (match) vars[match[1]] = match[2];
	}
	return vars;
}

function browserPayload(service) {
	return {
		version: 1,
		service,
		environment: "development",
		release: RUN,
		events: [
			{
				type: "exception",
				timestamp: new Date().toISOString(),
				errorType: "TypeError",
				message: `e2e browser error from ${service}`,
				stack: `TypeError: e2e browser error from ${service}\n    at onClick (http://localhost:${EXPRESS_PORT}/app.js:1:1)`,
				route: "/",
			},
		],
	};
}

async function doctor() {
	console.log("doctor");
	const cli = join(ROOT, "packages", "runtime-node", "dist", "cli.js");
	const { exited, output } = run(process.execPath, [cli, "doctor", "--endpoint", INGESTER, "--key", LOCAL_DEV_KEY], { env: cleanEnv() });
	const code = await exited;
	check(code === 0, "doctor exits 0 against the local ingester", output());
	check(/^\s*key\s+accepted$/m.test(output()), "doctor says the local key is accepted", output());
}

async function expressApp() {
	console.log("examples/express-app");
	const app = run("npm", ["start", "-w", "example-express-app"], {
		env: cleanEnv({ PORT: String(EXPRESS_PORT), GIT_SHA: RUN }),
	});
	const base = `http://localhost:${EXPRESS_PORT}`;
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (app.child.exitCode !== null) throw new Error(`express example exited with ${app.child.exitCode}:\n${app.output()}`);
		try {
			if ((await fetch(`${base}/healthz`)).ok) break;
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) throw new Error(`express example did not start:\n${app.output()}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	check(app.output().includes(`Sending telemetry to ${INGESTER}`), "says where it sends (the local ingester)", app.output());

	// The browser SDK and every module it imports load (the old prestart copied index.js only).
	const queue = ["/sdk/index.js"];
	const seen = new Set();
	while (queue.length) {
		const path = queue.shift();
		if (seen.has(path)) continue;
		seen.add(path);
		const res = await fetch(`${base}${path}`);
		check(res.ok && /javascript/.test(res.headers.get("content-type") ?? ""), `serves ${path}`, `${res.status} ${res.headers.get("content-type")}`);
		const source = await res.text();
		for (const [, spec] of source.matchAll(/(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
			queue.push(new URL(spec, `${base}${path}`).pathname);
		}
	}
	check(seen.size > 1, `the SDK's imports were followed (${[...seen].join(", ")})`);

	check((await fetch(`${base}/api/boom`)).status === 500, "GET /api/boom → 500");
	const search = await fetch(`${base}/api/orders/search`);
	check(search.status === 500, "GET /api/orders/search (router with its own error handler) → 500");
	const searchRequestId = search.headers.get("x-request-id") ?? "";
	check(/^[\w.-]{8,128}$/.test(searchRequestId), "GET /api/orders/search echoes its request id", searchRequestId);
	check((await fetch(`${base}/api/checkout?declined`, { method: "POST" })).status === 402, "POST /api/checkout?declined → 402");
	const relay = await fetch(`${base}/api/autter-runtime`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: base },
		body: JSON.stringify(browserPayload("example-web")),
	});
	check(relay.status === 202, "browser error through the relay → 202", relay.status);

	await row(
		`SELECT error_type, message FROM runtime_error_occurrences WHERE service = 'example-express' AND release = '${RUN}' AND message LIKE '%reading ''total''%' LIMIT 1`,
		"the server error from /api/boom (runtime_error_occurrences)",
	);
	// No autterErrorHandler in that router: the SDK captures Express errors
	// by default, with the route and the request id.
	await row(
		`SELECT error_type FROM runtime_error_occurrences WHERE service = 'example-express' AND release = '${RUN}' AND error_type = 'RangeError' AND message = 'search index unavailable' AND route = '/api/orders/search' AND request_id = '${searchRequestId}' AND position(stack, 'server.js') > 0 LIMIT 1`,
		"the nested router's error, captured by default with stack, route and request id",
	);
	await row(
		`SELECT status_code FROM runtime_logs WHERE service = 'example-express' AND release = '${RUN}' AND kind = 'request' AND status_code = 402 LIMIT 1`,
		"the request summary of /api/checkout (runtime_logs)",
	);
	await row(
		`SELECT message FROM runtime_error_occurrences WHERE service = 'example-web' AND release = '${RUN}' LIMIT 1`,
		"the browser error sent through the Express relay",
	);
	app.stop();
	await app.exited;
}

async function edgeWorker() {
	console.log("examples/edge-worker");
	const env = devVars("examples/edge-worker/.dev.vars.example");
	check(env.AUTTER_ENDPOINT === INGESTER && env.AUTTER_RUNTIME_KEY === LOCAL_DEV_KEY, ".dev.vars.example points at the local ingester");
	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => (logs.push(args.join(" ")), originalLog(...args));
	try {
		const { default: worker } = await import(pathToFileURL(join(ROOT, "examples", "edge-worker", "src", "index.js")).href);
		const pending = [];
		const ctx = { waitUntil: (promise) => pending.push(promise), passThroughOnException() {} };
		const res = await worker.fetch(new Request(`http://localhost:8787/?over&plan=${RUN}`), env, ctx);
		check(res.status === 429, "GET /?over → 429 quota.exceeded", res.status);
		await Promise.all(pending);
	} finally {
		console.log = originalLog;
	}
	check(logs.some((line) => line.includes(`sending telemetry to ${INGESTER}`)), "says where it sends", logs);
	await row(
		`SELECT status_code FROM runtime_logs WHERE service = 'edge-example' AND kind = 'request' AND status_code = 429 AND occurred_at >= toDateTime64('${STARTED}', 3, 'UTC') LIMIT 1`,
		"the edge request summary (runtime_logs)",
	);
}

async function runtimeRelay() {
	console.log("examples/runtime-relay");
	const env = devVars("examples/runtime-relay/.dev.vars.example");
	check(env.AUTTER_INGEST_URL === `${INGESTER}/v1/browser`, ".dev.vars.example points at the local ingester");
	const { transform } = await import("esbuild");
	const source = readFileSync(join(ROOT, "examples", "runtime-relay", "src", "index.ts"), "utf8");
	const { code } = await transform(source, { loader: "ts", format: "esm", target: "node20" });
	const dir = mkdtempSync(join(tmpdir(), "autter-relay-e2e-"));
	try {
		const file = join(dir, "relay.mjs");
		writeFileSync(file, code);
		const { default: relay } = await import(pathToFileURL(file).href);
		const res = await relay.fetch(
			new Request("http://localhost:8788/api/autter-runtime", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "http://localhost:8788" },
				body: JSON.stringify(browserPayload("relay-example")),
			}),
			env,
		);
		check(res.status === 202, "browser error through the Worker relay → 202", res.status);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	await row(
		`SELECT message FROM runtime_error_occurrences WHERE service = 'relay-example' AND release = '${RUN}' LIMIT 1`,
		"the browser error sent through the Worker relay",
	);
}

async function refusesWithoutKey() {
	console.log("no silent fallback");
	const app = run(process.execPath, ["server.js"], {
		cwd: join(ROOT, "examples", "express-app"),
		env: cleanEnv({ AUTTER_ENDPOINT: "https://ingest.example.invalid", PORT: String(EXPRESS_PORT + 1) }),
	});
	const code = await app.exited;
	check(code === 1 && /AUTTER_RUNTIME_KEY is not set/.test(app.output()), "AUTTER_ENDPOINT without a key: exits 1 and says why", app.output());
}

async function main() {
	const health = await fetch(`${INGESTER}/healthz`).catch((err) => ({ ok: false, status: String(err) }));
	check(health.ok, `ingester ready at ${INGESTER}`, health.status);
	await doctor();
	await expressApp();
	await edgeWorker();
	await runtimeRelay();
	await refusesWithoutKey();
	console.log("\nall examples stored their telemetry");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
		for (const child of children) {
			try {
				process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		process.exit(1);
	});
