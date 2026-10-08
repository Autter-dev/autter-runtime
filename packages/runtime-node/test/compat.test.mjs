import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initAutterServer, runtimeLogger, flushRuntimeLogs } from "../dist/index.js";

const ALL_MIGRATIONS = [
	"0001-baseline", "0002-occurrences-aggregation-columns", "0003-compress-fat-columns",
	"0004-llm-calls", "0005-latency-histograms", "0006-profile-samples", "0007-source-maps",
	"0008-memory-signals", "0009-profile-instance", "0010-memory-temporality",
	"0011-runtime-logs", "0012-runtime-compat",
];

/** Fake ingester: `compat` decides the /v1/compat answer; logs/traces 200. */
async function fakeIngester({ compat, logsStatus = 200, versionHeader }) {
	const requests = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			requests.push(`${req.method} ${req.url}`);
			if (versionHeader) res.setHeader("x-autter-ingester-version", versionHeader);
			if (req.url === "/v1/compat") {
				if (compat === null) return void res.writeHead(404).end("Cannot GET /v1/compat");
				return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(compat));
			}
			if (req.url === "/v1/logs") return void res.writeHead(logsStatus).end("{}");
			res.writeHead(200).end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
	};
}

const report = (version, applied = ALL_MIGRATIONS) => ({
	ingester: { name: "@autter/otlp-ingester", version },
	schema: { status: "ready", level: applied.at(-1), latest: applied.at(-1), applied },
	features: [],
});

function captureWarnings() {
	const original = console.warn;
	const lines = [];
	console.warn = (...args) => lines.push(args.join(" "));
	return { lines, restore: () => { console.warn = original; } };
}

const until = async (check, ms = 2000) => {
	const start = Date.now();
	while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
};
const settle = () => new Promise((r) => setTimeout(r, 150));

async function withServer(endpoint, options, fn) {
	const runtime = initAutterServer({
		service: "compat-test",
		apiKey: "test-key",
		endpoint,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		logging: { console: false },
		...options,
	});
	try {
		await fn(runtime);
	} finally {
		await runtime.shutdown().catch(() => {});
	}
}

test("operation logging against an older ingester warns once, naming both versions and the fix", async () => {
	const ingester = await fakeIngester({ compat: report("1.3.4", ALL_MIGRATIONS.slice(0, 10)) });
	const warnings = captureWarnings();
	try {
		await withServer(ingester.url, {}, async () => {
			runtimeLogger.info("first");
			runtimeLogger.info("second");
			await until(() => warnings.lines.some((l) => l.includes("Operation logging")));
			await flushRuntimeLogs().catch(() => {});
			runtimeLogger.info("third");
			await settle();
		});
		const relevant = warnings.lines.filter((l) => l.includes("Operation logging"));
		assert.equal(relevant.length, 1, warnings.lines.join("\n"));
		assert.match(
			relevant[0],
			/^\[autter-runtime\] Operation logging needs ingester >= 1\.4\.0; yours is 1\.3\.4\. Upgrade the ingester: docker pull ghcr\.io\/autter-dev\/otlp-ingester:latest/,
		);
		assert.match(relevant[0], /COMPATIBILITY\.md/);
		assert.equal(ingester.requests.filter((r) => r === "GET /v1/compat").length, 1, "checked once");
	} finally {
		warnings.restore();
		await ingester.close();
	}
});

test("no warning when the ingester is compatible", async () => {
	const ingester = await fakeIngester({ compat: report("1.4.0"), versionHeader: "1.4.0" });
	const warnings = captureWarnings();
	try {
		await withServer(ingester.url, { memoryMetrics: true }, async () => {
			runtimeLogger.info("hello");
			await until(() => ingester.requests.includes("GET /v1/compat"));
			await flushRuntimeLogs();
			await settle();
		});
		assert.ok(ingester.requests.includes("GET /v1/compat"));
		assert.deepEqual(warnings.lines.filter((l) => l.includes("[autter-runtime]")), []);
	} finally {
		warnings.restore();
		await ingester.close();
	}
});

test("a pre-compat ingester without /v1/logs is detected by probe and by the log export 404", async () => {
	const ingester = await fakeIngester({ compat: null, logsStatus: 404 });
	const warnings = captureWarnings();
	try {
		await withServer(ingester.url, {}, async () => {
			runtimeLogger.info("lost");
			await until(() => warnings.lines.some((l) => l.includes("Operation logging")));
			await flushRuntimeLogs().catch(() => {});
			await settle();
		});
		const relevant = warnings.lines.filter((l) => l.includes("Operation logging"));
		assert.equal(relevant.length, 1, warnings.lines.join("\n"));
		assert.match(relevant[0], /needs ingester >= 1\.4\.0; yours is 1\.4\.0 or older \(no \/v1\/compat\) and has no \/v1\/logs route/);
	} finally {
		warnings.restore();
		await ingester.close();
	}
});

test("never throws or warns when the ingester is unreachable", async () => {
	const warnings = captureWarnings();
	try {
		const started = Date.now();
		await withServer("http://127.0.0.1:9", {}, async () => {
			assert.ok(Date.now() - started < 1000, "init is not delayed");
			runtimeLogger.info("nobody is listening");
			await settle();
			await settle();
		});
		assert.deepEqual(warnings.lines.filter((l) => /needs (ingester|@autter)/.test(l)), []);
	} finally {
		warnings.restore();
	}
});

test("compatCheck: false makes no compat request", async () => {
	const ingester = await fakeIngester({ compat: report("1.0.0") });
	const warnings = captureWarnings();
	try {
		await withServer(ingester.url, { compatCheck: false }, async () => {
			runtimeLogger.info("quiet");
			await flushRuntimeLogs();
			await settle();
		});
		assert.ok(!ingester.requests.includes("GET /v1/compat"));
		assert.deepEqual(warnings.lines.filter((l) => l.includes("[autter-runtime]")), []);
	} finally {
		warnings.restore();
		await ingester.close();
	}
});

test("a hanging compat request never delays process exit", async () => {
	let hits = 0;
	const hang = createServer(() => { hits++; }); // accepts, never answers
	await new Promise((resolve) => hang.listen(0, "127.0.0.1", resolve));
	try {
		const fixture = fileURLToPath(new URL("./fixtures/compat-exit.mjs", import.meta.url));
		const started = Date.now();
		const code = await new Promise((resolve) => {
			const child = spawn(process.execPath, [fixture, `http://127.0.0.1:${hang.address().port}`], { stdio: "ignore" });
			child.on("exit", resolve);
		});
		assert.equal(code, 0);
		assert.equal(hits, 1, "the compat request was in flight");
		assert.ok(Date.now() - started < 2500, `exited after ${Date.now() - started}ms`);
	} finally {
		hang.closeAllConnections();
		await new Promise((resolve) => hang.close(resolve));
	}
});

test("SDK identity is sent as OTLP telemetry.distro.* resource attributes", async () => {
	const bodies = [];
	const collector = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			if (req.url === "/v1/logs") bodies.push(JSON.parse(body));
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	try {
		await withServer(`http://127.0.0.1:${collector.address().port}`, { compatCheck: false }, async () => {
			runtimeLogger.info("who am i");
			await flushRuntimeLogs();
		});
		const attrs = Object.fromEntries(
			bodies[0].resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue]),
		);
		assert.equal(attrs["telemetry.distro.name"], "@autter/runtime-node");
		assert.match(attrs["telemetry.distro.version"], /^\d+\.\d+\.\d+/);
	} finally {
		collector.closeAllConnections();
		await new Promise((resolve) => collector.close(resolve));
	}
});
