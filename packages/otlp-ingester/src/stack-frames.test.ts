import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { STACK_FIXTURES } from "./stack-fixtures.js";
import { isInAppFrame, isInAppPath, MAX_FRAMES, parseStackFrames } from "./stack-frames.js";
import type { StackFrame } from "./types.js";

/**
 * Shared parity vectors (contract §9): the platform's text-stack parser
 * (EI-19, runtime-stack-parse-vectors.json) must produce the same frames for
 * the same stacks, or one bug gets two frames-v3 fingerprints.
 */
const vectors = JSON.parse(
	readFileSync(new URL("./stack-parse-vectors.json", import.meta.url), "utf8"),
) as Array<{ name: string; stack: string; frames: StackFrame[] }>;

test("stack-parse vectors: at least 20 cases over every supported language", () => {
	assert.ok(vectors.length >= 20, `${vectors.length} vectors`);
	const names = vectors.map((v) => v.name.toLowerCase()).join("\n");
	for (const language of ["v8", "firefox", "safari", "python", "go", "jvm", "dotnet", "rust"]) {
		assert.ok(names.includes(language), `no ${language} vector`);
	}
});

for (const vector of vectors) {
	test(`stack-parse vector: ${vector.name}`, () => {
		assert.deepEqual(parseStackFrames(vector.stack), vector.frames);
	});
}

test("python frames come out innermost (crash site) first", () => {
	const frames = parseStackFrames(STACK_FIXTURES.python!.primary);
	assert.deepEqual(
		frames.map((f) => [f.function, f.filename, f.lineno]),
		[
			["process", "/app/orders/service.py", 88],
			["handle", "/app/web/handler.py", 42],
		],
	);
});

test("every supported language parses its fixture with the crash site first", () => {
	const crashSite: Record<string, string> = {
		go: "(*OrderService).Process",
		rust: "rust_begin_unwind",
		java: "process",
		dotnet: "Process",
		node: "OrderService.process",
		python: "process",
	};
	for (const [language, fixture] of Object.entries(STACK_FIXTURES)) {
		const frames = parseStackFrames(fixture.primary);
		assert.ok(frames.length > 0, language);
		assert.equal(frames[0]!.function, crashSite[language], language);
		for (const frame of frames) {
			assert.equal(frame.resolved, false);
			assert.equal(typeof frame.inApp, "boolean");
		}
	}
});

test("line numbers are parsed but a redeploy only moves them", () => {
	for (const [language, fixture] of Object.entries(STACK_FIXTURES)) {
		const strip = (frames: StackFrame[]) =>
			frames.map(({ lineno: _l, colno: _c, ...rest }) => rest);
		assert.deepEqual(
			strip(parseStackFrames(fixture.redeploy)).slice(0, 2),
			strip(parseStackFrames(fixture.primary)).slice(0, 2),
			language,
		);
	}
	// The Python redeploy fixture really moved its lines.
	assert.notDeepEqual(
		parseStackFrames(STACK_FIXTURES.python!.redeploy).map((f) => f.lineno),
		parseStackFrames(STACK_FIXTURES.python!.primary).map((f) => f.lineno),
	);
});

test("in-app rule (contract §3): paths", () => {
	for (const path of [
		"/app/node_modules/react/index.js",
		"node_modules/x.js",
		"/usr/lib/python3.12/site-packages/django/x.py",
		"/usr/lib/python3/dist-packages/x.py",
		"/app/vendor/autoload.php",
		"/app/node_modules/.pnpm/x@1/node_modules/x/i.js",
		"/repo/.pnpm/store/x.js",
		"node:internal/process/task_queues",
		"internal/process/task_queues.js",
		"chrome-extension://abc/inject.js",
		"moz-extension://abc/inject.js",
		"safari-extension://abc/inject.js",
		"safari-web-extension://abc/inject.js",
		"webkit-masked-url://hidden/",
		"C:\\app\\node_modules\\x\\index.js",
	]) {
		assert.equal(isInAppPath(path), false, path);
	}
	for (const path of [null, "/app/src/index.ts", "https://app.example.com/assets/index-5f3a9c1e.js", "webpack://shop/./src/a.tsx"]) {
		assert.equal(isInAppPath(path), true, String(path));
	}
});

test("in-app rule (contract §3): language frames", () => {
	const frame = (fn: string | null, module: string | null, filename: string | null = null) => ({ function: fn, module, filename });
	assert.equal(isInAppFrame(frame("gopanic", "runtime"), "go"), false);
	assert.equal(isInAppFrame(frame("(*conn).serve", "net/http", "/usr/local/go/src/net/http/server.go"), "go"), false);
	assert.equal(isInAppFrame(frame("main", "main", "/src/main.go"), "go"), true);
	for (const module of ["java.lang.Thread", "javax.servlet.Filter", "kotlin.collections.CollectionsKt", "jdk.internal.misc.Unsafe"]) {
		assert.equal(isInAppFrame(frame("run", module), "jvm"), false, module);
	}
	assert.equal(isInAppFrame(frame("process", "com.example.Orders"), "jvm"), true);
	assert.equal(isInAppFrame(frame("Start", "System.Threading.Tasks.Task"), "dotnet"), false);
	assert.equal(isInAppFrame(frame("Execute", "Microsoft.AspNetCore.Mvc.X"), "dotnet"), false);
	assert.equal(isInAppFrame(frame("Process", "MyApp.Orders"), "dotnet"), true);
	// Language rules do not leak into other languages.
	assert.equal(isInAppFrame(frame("runtime.start", null, "/app/src/boot.js"), "javascript"), true);
	assert.equal(isInAppFrame(frame("System.load", null, "/app/src/sys.js"), "javascript"), true);
});

test("at most 50 frames are kept, innermost first", () => {
	const stack = [
		"Error: deep",
		...Array.from({ length: 80 }, (_, i) => `    at fn${i} (/app/src/f${i}.js:${i + 1}:1)`),
	].join("\n");
	const frames = parseStackFrames(stack);
	assert.equal(frames.length, MAX_FRAMES);
	assert.equal(frames[0]!.function, "fn0");
	const python = [
		"Traceback (most recent call last):",
		...Array.from({ length: 80 }, (_, i) => `  File "/app/m${i}.py", line ${i + 1}, in f${i}`),
		"RecursionError: maximum recursion depth exceeded",
	].join("\n");
	const pyFrames = parseStackFrames(python);
	assert.equal(pyFrames.length, MAX_FRAMES);
	assert.equal(pyFrames[0]!.function, "f79");
});

test("query strings and hashes are stripped from parsed paths", () => {
	const [frame] = parseStackFrames("Error: x\n    at f (https://cdn.example.com/a.js?v=3#x:1:2)");
	assert.equal(frame!.filename, "https://cdn.example.com/a.js");
	assert.equal(frame!.lineno, 1);
	assert.equal(frame!.colno, 2);
});

test("unparseable text and empty stacks yield no frames", () => {
	assert.deepEqual(parseStackFrames(null), []);
	assert.deepEqual(parseStackFrames(""), []);
	assert.deepEqual(parseStackFrames("Something went wrong"), []);
});
