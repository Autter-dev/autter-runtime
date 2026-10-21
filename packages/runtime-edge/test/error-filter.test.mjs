import assert from "node:assert/strict";
import { test } from "node:test";
import { captureEdgeException, withAutter } from "../dist/index.js";

/** `ignoreErrors` and `sampleRate` on the edge (EI-38). */

function harness(options) {
	const posts = [];
	const fetch = async (_url, init) => {
		posts.push(JSON.parse(init.body));
		return new Response("{}", { status: 200 });
	};
	return {
		options: { apiKey: "k", service: "edge-api", environment: "test", fetch, endpoint: "https://ingest.test", ...options },
		/** Messages of the promoted (occurrence) records sent. */
		reported: () =>
			posts
				.flatMap((p) => p.resourceLogs[0].scopeLogs[0].logRecords)
				.map((r) => Object.fromEntries(r.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue])))
				.filter((a) => a["autter.capture.mode"] === "log")
				.map((a) => a["exception.message"]),
	};
}

test("rt.captureException honours ignoreErrors and sampleRate; a thrown error is never sampled out", async () => {
	const h = harness({ ignoreErrors: ["ResizeObserver", /^AbortError$/], sampleRate: 0 });
	const pending = [];
	const ctx = { waitUntil: (promise) => pending.push(promise) };
	const worker = withAutter(
		() => h.options,
		async (request, _env, _ctx, rt) => {
			rt.captureException(new Error("ResizeObserver loop"));
			const abort = new Error("aborted");
			abort.name = "AbortError";
			rt.captureException(abort);
			rt.captureException(new Error("sampled out"));
			if (new URL(request.url).pathname === "/throw") throw new Error("thrown out of the handler");
			return new Response("ok");
		},
	);
	await worker.fetch(new Request("https://edge.test/ok"), {}, ctx);
	await assert.rejects(worker.fetch(new Request("https://edge.test/throw"), {}, ctx), /thrown out of the handler/);
	await Promise.all(pending);
	assert.deepEqual(h.reported(), ["thrown out of the handler"]);
});

test("captureEdgeException (unhandled errors) honours ignoreErrors, never sampleRate", async () => {
	const h = harness({ ignoreErrors: ["known noise"], sampleRate: 0 });
	await captureEdgeException(h.options, new Error("known noise from a scheduled job"));
	await captureEdgeException(h.options, new Error("real failure"));
	assert.deepEqual(h.reported(), ["real failure"]);
});
