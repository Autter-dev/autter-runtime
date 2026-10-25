import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { causeTexts } from "./cause-chain.js";
import { parsedCauseLinks } from "./fingerprint-v3.js";
import { parseStackFrames } from "./stack-frames.js";
import type { StackFrame } from "./types.js";

/**
 * Cause chains (RF-06). The `causes` of stack-parse-vectors.json are shared
 * with the platform mirror (runtime-stack-parse-vectors.json): the causes of
 * the reported exception, nearest first, each with its type and its frames
 * as parseStackFrames reads them from its block. Vectors without `causes`
 * have none.
 */
const vectors = JSON.parse(
	readFileSync(new URL("./stack-parse-vectors.json", import.meta.url), "utf8"),
) as Array<{ name: string; stack: string; frames: StackFrame[]; causes?: Array<{ type: string; frames: StackFrame[] }> }>;

test("stack-parse vectors: chained JVM, .NET and Python stacks carry their causes", () => {
	const chained = vectors.filter((vector) => vector.causes);
	assert.ok(chained.length >= 10, `${chained.length} vectors with causes`);
	for (const language of ["python", "jvm", "dotnet"]) {
		assert.ok(chained.some((vector) => vector.name.startsWith(language)), `no chained ${language} vector`);
	}
});

for (const vector of vectors) {
	test(`cause chain vector: ${vector.name}`, () => {
		const links = causeTexts(vector.stack, null).map((cause) => ({ type: cause.type, frames: parseStackFrames(cause.stack) }));
		assert.deepEqual(links, vector.causes ?? []);
		// The reported exception's own frames are unchanged by the chain.
		assert.deepEqual(parseStackFrames(vector.stack), vector.frames);
	});
}

test("a JVM Suppressed: block and the causes inside it are not part of the chain", () => {
	const stack = [
		"java.lang.RuntimeException: batch failed",
		"\tat com.example.Batch.run(Batch.java:10)",
		"\tSuppressed: java.io.IOException: close failed",
		"\t\tat com.example.Batch.close(Batch.java:30)",
		"\tCaused by: java.net.SocketException: reset",
		"\t\tat com.example.Net.read(Net.java:5)",
		"Caused by: java.lang.IllegalStateException: not ready",
		"\tat com.example.Loader.load(Loader.java:20)",
		"\t... 1 more",
	].join("\n");
	const causes = causeTexts(stack, null);
	assert.deepEqual(causes.map((cause) => cause.type), ["java.lang.IllegalStateException"]);
	assert.deepEqual(parseStackFrames(causes[0]!.stack).map((frame) => frame.function), ["load"]);
});

test("a three-deep JVM chain lists its causes nearest first, the root last", () => {
	const stack = [
		"java.lang.RuntimeException: request failed",
		"\tat com.example.Web.handle(Web.java:9)",
		"Caused by: com.example.OrderException: order failed",
		"\tat com.example.Orders.place(Orders.java:40)",
		"\t... 1 more",
		"Caused by: java.sql.SQLException: timeout",
		"\tat com.example.Db.query(Db.java:77)",
		"\t... 2 more",
	].join("\n");
	assert.deepEqual(causeTexts(stack, null).map((cause) => cause.type), ["com.example.OrderException", "java.sql.SQLException"]);
});

test(".NET: two inner exceptions, nearest first; a cause without frames has no stack", () => {
	const stack = [
		"System.InvalidOperationException: Checkout failed ---> System.Net.Http.HttpRequestException: Connection refused ---> System.Net.Sockets.SocketException: Connection refused",
		"   at Shop.Http.Get(String url) in /src/Shop/Http.cs:line 12",
		"   --- End of inner exception stack trace ---",
		"   at Shop.Checkout.Submit(Order order) in /src/Shop/Checkout.cs:line 61",
	].join("\n");
	// The socket exception was never thrown with frames: two segments for three exceptions.
	const causes = causeTexts(stack, null);
	assert.deepEqual(causes.map((cause) => cause.type), ["System.Net.Http.HttpRequestException", "System.Net.Sockets.SocketException"]);
	assert.deepEqual(parseStackFrames(causes[0]!.stack).map((frame) => frame.function), ["Get"]);
	assert.equal(causes[1]!.stack, null);
});

test("JS (and any SDK): exception.cause.N.* attributes, until one is missing", () => {
	const attributes = {
		"exception.cause.1.type": "Error",
		"exception.cause.1.stacktrace": "Error: wrap\n    at a (/app/a.js:1:1)",
		"exception.cause.2.type": "TypeError",
		"exception.cause.2.message": "fetch failed",
		"exception.cause.4.type": "Orphan",
	};
	assert.deepEqual(causeTexts("Error: top\n    at b (/app/b.js:2:2)", attributes), [
		{ type: "Error", stack: "Error: wrap\n    at a (/app/a.js:1:1)" },
		{ type: "TypeError", stack: null },
	]);
	assert.deepEqual(causeTexts(null, null), []);
	assert.deepEqual(causeTexts("Error: top", { "exception.cause.1.message": "no type" }), []);
	// A text chain wins over attributes.
	const jvm = "java.lang.RuntimeException: x\n\tat com.example.A.b(A.java:1)\nCaused by: java.lang.Error: y\n\tat com.example.C.d(C.java:2)";
	assert.deepEqual(causeTexts(jvm, attributes).map((cause) => cause.type), ["java.lang.Error"]);
	// parsedCauseLinks parses each cause's frames.
	assert.deepEqual(
		parsedCauseLinks({ stack: null, attributes }).map((link) => [link.type, link.frames.map((frame) => frame.function)]),
		[["Error", ["a"]], ["TypeError", []]],
	);
});
