import assert from "node:assert/strict";
import { test } from "node:test";
import type { IngesterConfig } from "./config.js";
import { SinkForwarder, type SinkTuning } from "./sink.js";
import type { IngestContext, RuntimeOccurrence } from "./types.js";

/**
 * SinkForwarder unit tests — fake fetch, no network, no ClickHouse. Timing
 * is compressed through the tuning seam so retry/backoff paths run in
 * milliseconds.
 */

const TUNING: Partial<SinkTuning> = {
	retryBaseMs: 4,
	retryCapMs: 8,
	requestTimeoutMs: 500,
	healthyConcurrency: 4,
};

function cfg(overrides: Partial<IngesterConfig> = {}): IngesterConfig {
	return {
		port: 0,
		clickhouseUrl: null,
		clickhouseUser: "default",
		clickhousePassword: "",
		clickhouseDatabase: "autter_runtime",
		ingestKeys: [],
		keyValidatorUrl: null,
		keyValidatorToken: null,
		sinkUrl: "http://sink.local/hook",
		sinkToken: "sink-token",
		sinkMaxAttempts: 5,
		sinkMaxBufferedBatches: 1000,
		sinkMaxBufferedMb: 64,
		maxBodyBytes: 1_048_576,
		rateLimitPerMinute: 300,
		clientRateLimitPerMinute: 120,
		occurrenceTtlDays: 14,
		spanTtlDays: 7,
		metricsTtlDays: 90,
		llmCallTtlDays: 90,
		...overrides,
	};
}

function ctx(orgId = "org-a"): IngestContext {
	return { orgId, repositoryId: "repo-1", scope: "server", allowedOrigins: [] };
}

function occ(overrides: Partial<RuntimeOccurrence> = {}): RuntimeOccurrence {
	return {
		source: "server",
		severity: "error",
		service: "svc",
		environment: "prod",
		release: null,
		errorType: "TypeError",
		message: "boom",
		stack: null,
		route: "/x",
		method: "GET",
		statusCode: 500,
		traceId: "trace-1",
		sessionId: null,
		attributes: null,
		occurredAt: new Date("2026-01-01T00:00:00.000Z"),
		occurrenceId: "occ-1",
		fingerprint: "fp-1",
		routeNormalized: "/x",
		messageNormalized: "boom",
		topFrames: [],
		firstFrame: "",
		...overrides,
	};
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const ok = () => new Response("", { status: 200 });

async function until(cond: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 2));
	}
}

test("delivers a batch with batchId, bearer auth, and ISO timestamps", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return ok();
	}) as typeof fetch;
	const sink = new SinkForwarder(cfg(), fetchImpl, TUNING);

	sink.enqueue(ctx(), [occ()]);
	await until(() => sink.stats().delivered === 1);

	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, "http://sink.local/hook");
	const headers = calls[0]?.init.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer sink-token");
	const body = JSON.parse(String(calls[0]?.init.body));
	assert.equal(body.version, 1);
	assert.match(body.batchId, /^[0-9a-f-]{36}$/);
	assert.equal(body.orgId, "org-a");
	assert.equal(body.repositoryId, "repo-1");
	assert.equal(body.occurrences[0].occurredAt, "2026-01-01T00:00:00.000Z");
	assert.equal(body.occurrences[0].occurrenceId, "occ-1");
});

test("retries 5xx and reports a sanitized http_<status> reason", async (t) => {
	t.mock.method(console, "warn", () => {});
	let attempts = 0;
	const fetchImpl = (async () => {
		attempts += 1;
		return attempts === 1 ? new Response("", { status: 503 }) : ok();
	}) as typeof fetch;
	const sink = new SinkForwarder(cfg(), fetchImpl, TUNING);

	sink.enqueue(ctx(), [occ()]);
	await until(() => sink.stats().delivered === 1);

	const stats = sink.stats();
	assert.equal(attempts, 2);
	assert.equal(stats.retried, 1);
	assert.equal(stats.consecutiveFailures, 0);
	assert.equal(stats.lastFailureReason, "http_503");
	assert.ok(!JSON.stringify(stats).includes("sink responded"));
});

test("non-retryable 4xx drops immediately without retry", async (t) => {
	t.mock.method(console, "error", () => {});
	let attempts = 0;
	const fetchImpl = (async () => {
		attempts += 1;
		return new Response("", { status: 400 });
	}) as typeof fetch;
	const sink = new SinkForwarder(cfg(), fetchImpl, TUNING);

	sink.enqueue(ctx(), [occ()]);
	await until(() => sink.stats().droppedPermanent === 1);

	assert.equal(attempts, 1);
	assert.equal(sink.stats().delivered, 0);
	assert.equal(sink.stats().lastFailureReason, "http_400");
});

test("network failures give up after sinkMaxAttempts with a safe category", async (t) => {
	t.mock.method(console, "warn", () => {});
	t.mock.method(console, "error", () => {});
	let attempts = 0;
	const fetchImpl = (async () => {
		attempts += 1;
		throw new TypeError("fetch failed: super secret internal detail");
	}) as typeof fetch;
	const sink = new SinkForwarder(cfg({ sinkMaxAttempts: 2 }), fetchImpl, TUNING);

	sink.enqueue(ctx(), [occ()]);
	await until(() => sink.stats().droppedPermanent === 1);

	const stats = sink.stats();
	assert.equal(attempts, 2);
	assert.equal(stats.lastFailureReason, "connection_error");
	// Raw exception text must never surface in stats (/healthz is public).
	assert.ok(!JSON.stringify(stats).includes("super secret"));
});

test("a concurrent stale success does not clear an active failure episode", async (t) => {
	t.mock.method(console, "warn", () => {});
	const pending: Deferred<Response>[] = [];
	const fetchImpl = (() => {
		const d = deferred<Response>();
		pending.push(d);
		return d.promise;
	}) as typeof fetch;
	const sink = new SinkForwarder(cfg(), fetchImpl, TUNING);

	// Two batches go in flight concurrently (healthy concurrency).
	sink.enqueue(ctx(), [occ({ message: "first" })]);
	sink.enqueue(ctx(), [occ({ message: "second" })]);
	await until(() => pending.length === 2);

	// First request fails — the forwarder enters its failure episode.
	pending[0]?.reject(new TypeError("down"));
	await until(() => sink.stats().consecutiveFailures === 1);

	// Second request succeeds, but it STARTED before the failure: it must
	// not reset the failure state and reopen full concurrency.
	pending[1]?.resolve(ok());
	await until(() => sink.stats().delivered === 1);
	assert.equal(sink.stats().consecutiveFailures, 1);

	// The failed batch retries (serially) and succeeds — now it resets.
	await until(() => pending.length === 3);
	pending[2]?.resolve(ok());
	await until(() => sink.stats().delivered === 2);
	assert.equal(sink.stats().consecutiveFailures, 0);
});

test("overflow evicts the heaviest org's oldest batch, sparing small tenants", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	// Never resolves: four org-a batches occupy the in-flight slots, the
	// rest sit in the queue where eviction applies.
	const fetchImpl = (() => deferred<Response>().promise) as typeof fetch;
	const sink = new SinkForwarder(
		cfg({ sinkMaxBufferedBatches: 2 }),
		fetchImpl,
		TUNING,
	);

	for (let i = 0; i < 6; i += 1) {
		sink.enqueue(ctx("org-a"), [
			occ({ occurredAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }),
		]);
	}
	// 4 in flight + 2 queued for org-a; org-b's batch overflows the queue.
	sink.enqueue(ctx("org-b"), [occ()]);

	assert.equal(sink.stats().droppedOverflow, 1);
	const warned = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
	assert.ok(warned.includes("org org-a"), warned);
	assert.ok(!warned.includes("org org-b"), warned);
});

test("a retrying batch keeps its enqueue-age position for eviction", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	t.mock.method(console, "error", () => {});
	const fetchImpl = (async () => {
		throw new TypeError("down");
	}) as typeof fetch;
	const sink = new SinkForwarder(
		cfg({ sinkMaxBufferedBatches: 1, sinkMaxAttempts: 10 }),
		fetchImpl,
		{ ...TUNING, retryBaseMs: 60, retryCapMs: 120 },
	);

	sink.enqueue(ctx(), [occ({ occurredAt: new Date("2026-01-01T00:00:00Z") })]);
	await until(() => sink.stats().retried >= 1);

	// The older (failed, backing-off) batch must be the eviction victim —
	// not pushed behind this newer one.
	sink.enqueue(ctx(), [occ({ occurredAt: new Date("2026-02-02T00:00:00Z") })]);
	await until(() => sink.stats().droppedOverflow === 1);

	const warned = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
	assert.ok(warned.includes("2026-01-01"), warned);
	assert.ok(!warned.includes("2026-02-02"), warned);
});

test("a single batch larger than the whole buffer is dropped alone", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	let called = false;
	const fetchImpl = (async () => {
		called = true;
		return ok();
	}) as typeof fetch;
	const sink = new SinkForwarder(cfg({ sinkMaxBufferedMb: 1 }), fetchImpl, TUNING);

	sink.enqueue(ctx(), [occ({ message: "x".repeat(2 * 1024 * 1024) })]);

	assert.equal(sink.stats().droppedOverflow, 1);
	assert.equal(sink.stats().queued, 0);
	assert.equal(called, false);
	const warned = warn.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
	assert.ok(warned.includes("exceeds the buffer cap"), warned);
});

test("enqueue after stop is a no-op and pendingCount reflects the queue", async () => {
	const fetchImpl = (() => deferred<Response>().promise) as typeof fetch;
	const sink = new SinkForwarder(cfg(), fetchImpl, TUNING);

	sink.enqueue(ctx(), [occ()]);
	assert.equal(sink.pendingCount(), 1);
	sink.stop();
	sink.enqueue(ctx(), [occ()]);
	assert.equal(sink.pendingCount(), 1);
});
