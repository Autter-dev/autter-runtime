// onRequestError for Next.js instrumentation.ts: the Node path records on
// the request span through the registerAutter tracker; the edge path (and
// the edge-only build) sends a promoted error record over /v1/logs and never
// references Node code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as instrumentation from "../dist/instrumentation.js";
import * as edgeBuild from "../dist/instrumentation-edge.js";
import { registerAutter, withRuntimeRequest } from "../dist/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const require = createRequire(import.meta.url);

const traceBodies = [];
let collector;
let sdk;

before(async () => {
	const { createServer } = await import("node:http");
	collector = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.url === "/v1/traces") traceBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	sdk = registerAutter({
		apiKey: "test-key",
		service: "next-app",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		compatCheck: false,
		metricIntervalMs: 3_600_000,
		logging: { console: false },
	});
	require("http"); // patched by the HTTP instrumentation from here on
});

after(async () => {
	await new Promise((resolve) => {
		collector.close(resolve);
		collector.closeAllConnections();
	});
});

const nextRequest = {
	path: "/blog/hello?draft=preview42#frag",
	method: "get",
	headers: { cookie: "sid=rawcookievalue", authorization: "Bearer headersecret123" },
};
const nextContext = {
	routerKind: "App Router",
	routePath: "/blog/[slug]",
	routeType: "render",
	renderSource: "react-server-components",
	revalidateReason: undefined,
	renderType: "dynamic",
};

/** A Node server whose handler lets `fail(url)` produce the error, then
 * calls onRequestError like Next does, and answers 500. */
async function nextLikeServer(onRequestError, fail) {
	const server = require("http").createServer(async (req, res) => {
		try {
			await fail(req.url);
			res.end("ok");
		} catch (error) {
			await onRequestError(error, { ...nextRequest, path: req.url }, nextContext);
			res.statusCode = 500;
			res.end("error page");
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		close: () =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	};
}

const attrs = (list = []) =>
	Object.fromEntries(list.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue]));

test("Node runtime: onRequestError records the error with its stack and Next's context on the request span", async () => {
	function renderBlogPost() {
		throw Object.assign(new Error("cannot read properties of undefined (reading 'title')"), { digest: "2817364" });
	}
	const handled = withRuntimeRequest(async () => {
		throw new Error("route handler failed");
	});
	// `next start` runs edge route handlers in a vm sandbox and hands their
	// errors to the Node onRequestError: an Error from another realm.
	const edgeRealmError = vm.runInNewContext(
		"(function edgeRouteExplodes() { return new TypeError('edge route boom'); })()",
	);
	const app = await nextLikeServer(instrumentation.onRequestError, async (url) => {
		if (url.startsWith("/blog/")) renderBlogPost();
		if (url === "/redirect") throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
		if (url === "/not-found") throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
		if (url === "/api/route") await handled(new Request("http://next.test/api/route"));
		if (url === "/api/edge-route") throw edgeRealmError;
	});
	try {
		for (const route of ["/blog/hello?draft=preview42", "/redirect", "/not-found", "/api/route", "/api/edge-route"]) {
			const response = await fetch(`${app.url}${route}`, { headers: { cookie: "sid=rawcookievalue" } });
			assert.equal(response.status, 500);
			await response.text();
		}
	} finally {
		await app.close();
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	await sdk.shutdown();

	const spans = traceBodies.flatMap((body) =>
		body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans ?? [])),
	);
	const serverSpan = (target) => spans.find((span) => span.kind === 2 && attrs(span.attributes)["http.target"] === target);
	const exceptions = (span) => (span?.events ?? []).filter((event) => event.name === "exception");

	// The query never leaves the process: only its parameter names (runtime-node's query policy).
	const blog = serverSpan("/blog/hello");
	assert.ok(blog, "request span exported");
	assert.equal(attrs(blog.attributes)["url.query"], "draft=[redacted]");
	assert.equal(JSON.stringify(traceBodies).includes("preview42"), false, "query values never exported");
	const [event, ...more] = exceptions(blog);
	assert.equal(more.length, 0);
	const eventAttrs = attrs(event.attributes);
	assert.equal(eventAttrs["exception.type"], "Error");
	assert.match(eventAttrs["exception.stacktrace"], /renderBlogPost/, "the error's real stack");
	const spanAttrs = attrs(blog.attributes);
	assert.equal(spanAttrs["next.route_path"], "/blog/[slug]");
	assert.equal(spanAttrs["next.router_kind"], "App Router");
	assert.equal(spanAttrs["next.route_type"], "render");
	assert.equal(spanAttrs["next.render_source"], "react-server-components");
	assert.equal(spanAttrs["next.render_type"], "dynamic");
	assert.equal(spanAttrs["next.digest"], "2817364");
	assert.equal(spanAttrs["http.request.method"], "GET");
	assert.equal(spanAttrs["url.path"], "/blog/hello", "path without its query string");
	assert.equal(spanAttrs["next.revalidate_reason"], undefined);
	const wire = JSON.stringify(traceBodies);
	assert.equal(wire.includes("rawcookievalue"), false, "cookies never recorded");
	assert.equal(wire.includes("headersecret123"), false, "headers never recorded");

	// Next's control-flow signals are not errors.
	assert.equal(exceptions(serverSpan("/redirect")).length, 0);
	assert.equal(exceptions(serverSpan("/not-found")).length, 0);

	// Captured once: withRuntimeRequest reported it, onRequestError skips it
	// but still puts Next's context on the request span.
	const route = serverSpan("/api/route");
	assert.equal(exceptions(route).length, 1);
	assert.equal(attrs(exceptions(route)[0].attributes)["exception.message"], "route handler failed");
	assert.equal(attrs(route.attributes)["next.route_path"], "/blog/[slug]");
	assert.equal(attrs(route.attributes)["url.path"], "/api/route");

	// An error from another realm is still an Error: its own type, message and stack.
	const [edgeEvent, ...extra] = exceptions(serverSpan("/api/edge-route"));
	assert.equal(extra.length, 0);
	const edgeAttrs = attrs(edgeEvent.attributes);
	assert.equal(edgeAttrs["exception.type"], "TypeError");
	assert.equal(edgeAttrs["exception.message"], "edge route boom", "not the stringified error");
	assert.match(edgeAttrs["exception.stacktrace"], /edgeRouteExplodes/, "the sandboxed error's own stack");
});

function edgeHarness() {
	const posts = [];
	const fetch = async (url, init) => {
		posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
		return new Response("{}");
	};
	const records = () =>
		posts.flatMap((p) => p.body.resourceLogs[0].scopeLogs[0].logRecords).map((r) =>
			Object.fromEntries(r.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue])),
		);
	return { posts, fetch, records };
}

for (const [name, build, env] of [
	["default build with NEXT_RUNTIME=edge", instrumentation, "edge"],
	["edge-only build", edgeBuild, undefined],
]) {
	test(`edge runtime (${name}): a promoted error record with Next's context, no headers`, async () => {
		const h = edgeHarness();
		const previous = process.env.NEXT_RUNTIME;
		if (env) process.env.NEXT_RUNTIME = env;
		try {
			const onRequestError = build.autterOnRequestError({
				edge: () => ({ apiKey: "server-key", service: "web-edge", endpoint: "https://ingest.test", fetch: h.fetch }),
			});
			function middlewareFailure() {
				return new Error("middleware exploded");
			}
			await onRequestError(middlewareFailure(), nextRequest, { ...nextContext, routeType: "middleware" });
			await onRequestError(
				Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/;307;" }),
				nextRequest,
				nextContext,
			);
		} finally {
			if (previous === undefined) delete process.env.NEXT_RUNTIME;
			else process.env.NEXT_RUNTIME = previous;
		}
		assert.equal(h.posts.length, 1, "one record; redirects are skipped");
		assert.equal(h.posts[0].url, "https://ingest.test/v1/logs");
		assert.equal(h.posts[0].headers.authorization, "Bearer server-key");
		const [record] = h.records();
		assert.equal(record["autter.capture.mode"], "log");
		assert.equal(record["exception.message"], "middleware exploded");
		assert.match(record["exception.stacktrace"], /middlewareFailure/);
		assert.equal(record["next.route_type"], "middleware");
		assert.equal(record["next.route_path"], "/blog/[slug]");
		assert.equal(record["url.path"], "/blog/hello");
		assert.equal(record["http.request.method"], "GET");
		const wire = JSON.stringify(h.posts);
		assert.equal(wire.includes("rawcookievalue"), false);
		assert.equal(wire.includes("headersecret123"), false);
		assert.equal(wire.includes("preview42"), false, "query string dropped");
	});
}

for (const [name, build, env] of [
	["default build with NEXT_RUNTIME=edge", instrumentation, "edge"],
	["edge-only build", edgeBuild, undefined],
]) {
	test(`edge runtime (${name}): delivery is handed to Next's request-context waitUntil`, async () => {
		// Next calls onRequestError without awaiting it for errors React reports
		// during a render; waitUntil keeps the edge function alive for the POST.
		const h = edgeHarness();
		const key = Symbol.for("@next/request-context");
		const previousContext = globalThis[key];
		const previousRuntime = process.env.NEXT_RUNTIME;
		const requestContext = {
			pending: [],
			waitUntil(promise) {
				this.pending.push(promise);
			},
		};
		globalThis[key] = { get: () => requestContext };
		if (env) process.env.NEXT_RUNTIME = env;
		try {
			const onRequestError = build.autterOnRequestError({
				edge: { apiKey: "server-key", service: "web-edge", endpoint: "https://ingest.test", fetch: h.fetch },
			});
			await onRequestError(new Error("render failed on the edge"), nextRequest, nextContext);
			// No request context (or a broken one): still delivered, never throws.
			globalThis[key] = { get: () => { throw new Error("no context"); } };
			await onRequestError(new Error("outside a request"), nextRequest, nextContext);
		} finally {
			if (previousContext === undefined) delete globalThis[key];
			else globalThis[key] = previousContext;
			if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
			else process.env.NEXT_RUNTIME = previousRuntime;
		}
		assert.equal(requestContext.pending.length, 1, "handed to waitUntil, called on its context");
		await requestContext.pending[0];
		assert.deepEqual(
			h.records().map((r) => r["exception.message"]),
			["render failed on the edge", "outside a request"],
		);
	});
}

test("edge runtime without edge options: skipped with one warning, never throws", async () => {
	const warn = console.warn;
	const warnings = [];
	console.warn = (message) => warnings.push(String(message));
	try {
		await edgeBuild.onRequestError(new Error("a"), nextRequest, nextContext);
		await edgeBuild.onRequestError(new Error("b"), nextRequest, nextContext);
		// Hostile inputs never throw into Next.
		const hostile = new Proxy({}, { get() { throw new Error("trap"); } });
		await edgeBuild.onRequestError(hostile, hostile, hostile);
		await instrumentation.autterOnRequestError({ capture: () => { throw new Error("rule"); } })(new Error("c"), hostile, hostile);
	} finally {
		console.warn = warn;
	}
	assert.equal(warnings.filter((w) => /without edge options/.test(w)).length, 1);
});

test("the edge build and its chunks never reference Node code; the export map routes edge conditions to it", () => {
	const seen = new Set();
	const visit = (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		const source = readFileSync(path.join(dist, file), "utf8");
		assert.equal(/@autter\/runtime-node|["']node:|require\(["'](?:fs|http|net|async_hooks|crypto|path|os)["']\)/.test(source), false, file);
		for (const [, spec] of source.matchAll(/(?:from|import\(|require\()\s*["'](\.\/[^"']+)["']/g)) visit(spec.slice(2));
	};
	visit("instrumentation-edge.js");
	visit("instrumentation-edge.cjs");
	assert.ok(seen.size >= 3, [...seen].join(", "));

	const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));
	const entry = pkg.exports["./instrumentation"];
	for (const condition of ["edge-light", "worker"]) {
		assert.equal(entry[condition].import, "./dist/instrumentation-edge.js");
		assert.equal(entry[condition].require, "./dist/instrumentation-edge.cjs");
	}
	assert.equal(entry.import, "./dist/instrumentation.js");
	assert.equal(entry.require, "./dist/instrumentation.cjs");
	// Condition order matters: the edge conditions come before import/require.
	const keys = Object.keys(entry);
	assert.ok(keys.indexOf("edge-light") < keys.indexOf("import"));

	// The default build only reaches runtime-node inside the NEXT_RUNTIME
	// branch Next removes from edge bundles.
	for (const file of ["instrumentation.js", "instrumentation.cjs"]) {
		const source = readFileSync(path.join(dist, file), "utf8");
		const branch = source.indexOf('process.env.NEXT_RUNTIME === "edge"');
		const nodeImport = source.indexOf("@autter/runtime-node");
		assert.ok(branch > 0 && nodeImport > branch, file);
		assert.equal(source.split("@autter/runtime-node").length, 2, `${file}: one lazy reference`);
	}
});

test("bundled for the edge with NEXT_RUNTIME defined (as Next does), the default build drops runtime-node", async (t) => {
	let esbuild;
	try {
		esbuild = await import("esbuild");
	} catch {
		t.skip("esbuild not installed");
		return;
	}
	for (const file of ["instrumentation.js", "instrumentation.cjs"]) {
		const bundle = async (runtime, platform) => {
			const result = await esbuild.build({
				entryPoints: [path.join(dist, file)],
				bundle: true,
				write: false,
				platform,
				format: "esm",
				define: { "process.env.NEXT_RUNTIME": JSON.stringify(runtime) },
				external: ["@opentelemetry/*"],
				logLevel: "silent",
			});
			return result.outputFiles[0].text;
		};
		// runtime-node's code (not just the property name at the call site).
		const nodeCode = /function (?:initAutterServer|captureRequestError)\b|@autter\/runtime-node/;
		assert.equal(nodeCode.test(await bundle("edge", "neutral")), false, `${file}: edge bundle`);
		assert.equal(nodeCode.test(await bundle("nodejs", "node")), true, `${file}: nodejs bundle`);
	}
});
