import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveFields } from "./fingerprint.js";
import { collapseIdentity, LoopCollapser, type CollapsedSample } from "./loop-collapse.js";
import type { IngestContext, RuntimeOccurrence } from "./types.js";

/**
 * Loop collapse (EI-38): per tenant and identity, the first N occurrences of
 * a minute are kept, the rest fold into one sample whose collapsedCount
 * makes stored rows + Σ collapsedCount exactly the occurrences accepted.
 */

const ctx: IngestContext = { orgId: "org-1", repositoryId: "repo-1", scope: "server", allowedOrigins: [] };
const T0 = Date.parse("2026-10-21T10:00:05Z");

let serial = 0;
function occurrence(overrides: Partial<RuntimeOccurrence> = {}, at = T0): RuntimeOccurrence {
	const input = {
		source: "server" as const,
		severity: "error" as const,
		service: "api",
		environment: "production",
		release: "abc123",
		errorType: "TypeError",
		message: `Cannot read properties of undefined (reading 'id') at row ${serial}`,
		stack: "TypeError: boom\n    at handler (/app/src/orders.ts:10:5)\n    at loop (/app/src/worker.ts:3:1)",
		route: "/orders/:id",
		method: "GET",
		statusCode: 500,
		traceId: `trace-${serial}`,
		sessionId: null,
		attributes: null,
		occurredAt: new Date(at),
		...overrides,
	};
	serial += 1;
	return {
		...input,
		occurrenceId: (overrides.occurrenceId ?? serial.toString(16).padStart(32, "0")) as string,
		fingerprint: "f".repeat(32),
		fingerprintScheme: "message-v1",
		fingerprints: [
			{ scheme: "frames-v3", fingerprint: "3".repeat(32) },
			{ scheme: "message-v1", fingerprint: "f".repeat(32) },
		],
		...deriveFields(input),
		...overrides,
	} as RuntimeOccurrence;
}

function collapser(after = 10, now = () => T0) {
	const flushed: Array<{ ctx: IngestContext; samples: CollapsedSample[] }> = [];
	let fail = false;
	const c = new LoopCollapser(
		async (tenant, samples) => {
			if (fail) throw new Error("clickhouse down");
			flushed.push({ ctx: tenant, samples });
		},
		{ after, now, log: () => {} },
	);
	return {
		c,
		flushed,
		samples: () => flushed.flatMap((f) => f.samples),
		setFail: (value: boolean) => {
			fail = value;
		},
	};
}

/** Stored rows + Σ collapsedCount: the count every reader sees. */
const exactCount = (kept: RuntimeOccurrence[], samples: CollapsedSample[]) =>
	kept.length + samples.reduce((n, s) => n + 1 + (s.sample.collapsedCount ?? 0), 0);

test("a loop of 10,000 a minute stores N occurrences and one sample with the exact count", async () => {
	let now = T0;
	const { c, samples } = collapser(10, () => now);
	const kept: RuntimeOccurrence[] = [];
	// 20 exports of 500, as a batch exporter would send them over the minute.
	for (let batch = 0; batch < 20; batch++) {
		now = T0 + batch * 2_500;
		const plan = c.plan(ctx, "/v1/traces", Array.from({ length: 500 }, () => occurrence({}, now)));
		kept.push(...plan.kept);
		plan.commit();
	}
	assert.equal(kept.length, 10, "the first N are stored as they arrive");
	assert.equal(c.stats().heldSamples, 1);
	// The minute is not over: nothing flushed yet.
	await c.flush();
	assert.equal(samples().length, 0);
	now = T0 + 60_000;
	await c.flush();
	assert.equal(samples().length, 1, "one sample for the minute");
	const [sample] = samples();
	assert.equal(sample!.folded, 9_990);
	assert.equal(sample!.sample.collapsedCount, 9_989);
	assert.equal(sample!.route, "/v1/traces");
	// The newest folded occurrence is the sample (last-seen stays exact).
	assert.equal(sample!.sample.occurredAt.getTime(), T0 + 19 * 2_500);
	assert.equal(exactCount(kept, samples()), 10_000);
	assert.equal(c.stats().heldSamples, 0);
	assert.equal(c.stats().windows, 0, "the minute's windows are cleared");
});

test("each minute starts its own window", async () => {
	let now = T0;
	const { c, samples } = collapser(3, () => now);
	const kept: RuntimeOccurrence[] = [];
	for (const minute of [0, 1]) {
		now = T0 + minute * 60_000;
		const plan = c.plan(ctx, "/v1/traces", Array.from({ length: 8 }, () => occurrence({}, now)));
		kept.push(...plan.kept);
		plan.commit();
	}
	now = T0 + 120_000;
	await c.flush();
	assert.equal(kept.length, 6, "N per minute");
	assert.deepEqual(samples().map((s) => s.folded), [5, 5]);
	assert.equal(exactCount(kept, samples()), 16);
});

test("identical means same identity, normalised message and frames, release, severity and session", () => {
	const base = occurrence();
	// Numbers, ids and quoted strings in the message are templated out.
	assert.equal(collapseIdentity(base), collapseIdentity(occurrence({ traceId: "other", route: "/elsewhere" })));
	for (const different of [
		occurrence({ fingerprint: "e".repeat(32) }),
		occurrence({ release: "def456" }),
		occurrence({ severity: "fatal" }),
		occurrence({ environment: "staging" }),
		occurrence({ sessionId: "s_1" }),
		occurrence({ errorType: "RangeError" }),
		occurrence({ expected: true }),
		occurrence({ errorCode: "orders.missing" }),
	]) {
		assert.notEqual(collapseIdentity(different), collapseIdentity(base), JSON.stringify(different).slice(0, 80));
	}
	const otherMessage = occurrence();
	otherMessage.messageNormalized = "a different message";
	assert.notEqual(collapseIdentity(otherMessage), collapseIdentity(base));
	const otherFrames = occurrence();
	otherFrames.topFrames = ["other (/app/src/x.ts)"];
	assert.notEqual(collapseIdentity(otherFrames), collapseIdentity(base));
});

test("tenants, routes and sessions never share a window", async () => {
	let now = T0;
	const { c, samples } = collapser(2, () => now);
	const other: IngestContext = { ...ctx, repositoryId: "repo-2" };
	let kept = 0;
	for (const [tenant, route, session] of [
		[ctx, "/v1/traces", null],
		[other, "/v1/traces", null],
		[ctx, "/v1/browser", null],
		[ctx, "/v1/traces", "s_1"],
	] as const) {
		const plan = c.plan(tenant, route, Array.from({ length: 5 }, () => occurrence({ sessionId: session })));
		kept += plan.kept.length;
		plan.commit();
	}
	now = T0 + 60_000;
	await c.flush();
	assert.equal(kept, 8);
	assert.equal(samples().length, 4);
	assert.deepEqual(samples().map((s) => s.sample.collapsedCount), [2, 2, 2, 2]);
});

test("a failed request gives its reservations back, so its retry is planned the same", async () => {
	let now = T0;
	const { c, samples } = collapser(3, () => now);
	const batch = Array.from({ length: 6 }, () => occurrence());
	const first = c.plan(ctx, "/v1/traces", batch);
	assert.equal(first.kept.length, 3);
	assert.equal(first.folded, 3);
	first.rollback();
	assert.equal(c.stats().heldSamples, 0);
	const retry = c.plan(ctx, "/v1/traces", batch);
	assert.deepEqual(retry.kept.map((o) => o.occurrenceId), first.kept.map((o) => o.occurrenceId));
	retry.commit();
	now = T0 + 60_000;
	await c.flush();
	assert.equal(exactCount(retry.kept, samples()), 6);
});

test("a batch retried after a lost 2xx is not counted twice", async () => {
	let now = T0;
	const { c, samples } = collapser(3, () => now);
	const batch = Array.from({ length: 6 }, () => occurrence());
	const first = c.plan(ctx, "/v1/traces", batch);
	first.commit();
	// Same occurrence ids (content-derived): the stored ones are stored again
	// (same id, deduped downstream), the folded ones are recognised.
	const retry = c.plan(ctx, "/v1/traces", batch);
	assert.deepEqual(retry.kept.map((o) => o.occurrenceId), first.kept.map((o) => o.occurrenceId));
	assert.equal(retry.folded, 0);
	assert.equal(retry.repeated, 3);
	retry.commit();
	now = T0 + 60_000;
	await c.flush();
	assert.equal(samples()[0]!.folded, 3);
});

test("a window held by a request in flight waits for it", async () => {
	let now = T0;
	const { c, samples } = collapser(1, () => now);
	const plan = c.plan(ctx, "/v1/traces", Array.from({ length: 4 }, () => occurrence()));
	now = T0 + 60_000;
	await c.flush();
	assert.equal(samples().length, 0, "still held");
	plan.commit();
	await c.flush();
	assert.equal(samples().length, 1);
	assert.equal(samples()[0]!.folded, 3);
});

test("folds committed after a forced flush are carried into the next one", async () => {
	let now = T0;
	const { c, samples } = collapser(1, () => now);
	const done = c.plan(ctx, "/v1/traces", Array.from({ length: 3 }, () => occurrence()));
	done.commit();
	const slow = c.plan(ctx, "/v1/traces", Array.from({ length: 4 }, () => occurrence()));
	now = T0 + 6 * 60_000; // past the 4-minute safety net
	await c.flush();
	assert.deepEqual(samples().map((s) => s.folded), [2]);
	slow.commit();
	await c.flush();
	assert.deepEqual(samples().map((s) => s.folded), [2, 4], "late folds stored as their own sample");
	assert.equal(1 + samples().reduce((n, s) => n + s.folded, 0), 7);
	assert.equal(c.stats().heldSamples, 0);
});

test("a failed flush keeps the samples and stores them on the next tick", async () => {
	let now = T0;
	const { c, samples, setFail } = collapser(1, () => now);
	c.plan(ctx, "/v1/traces", Array.from({ length: 5 }, () => occurrence())).commit();
	now = T0 + 60_000;
	setFail(true);
	await c.flush();
	assert.equal(samples().length, 0);
	assert.equal(c.stats().failedFlushes, 1);
	assert.equal(c.stats().heldSamples, 1, "still held");
	setFail(false);
	await c.flush();
	assert.equal(samples().length, 1);
	assert.equal(samples()[0]!.folded, 4);
	assert.equal(c.stats().heldSamples, 0);
});

test("stop() stores the minute in progress", async () => {
	const { c, samples } = collapser(2);
	c.plan(ctx, "/v1/browser", Array.from({ length: 7 }, () => occurrence({ source: "browser" }))).commit();
	await c.stop();
	assert.equal(samples().length, 1);
	assert.equal(samples()[0]!.folded, 5);
});

test("past the held-sample bound, new identities pass through uncollapsed", async () => {
	let now = T0;
	const flushed: CollapsedSample[] = [];
	const c = new LoopCollapser(async (_ctx, samples) => void flushed.push(...samples), {
		after: 1,
		maxSamples: 1,
		now: () => now,
		log: () => {},
	});
	const first = c.plan(ctx, "/v1/traces", Array.from({ length: 3 }, () => occurrence()));
	first.commit();
	const second = c.plan(ctx, "/v1/traces", Array.from({ length: 3 }, () => occurrence({ release: "other" })));
	second.commit();
	assert.equal(first.kept.length, 1);
	assert.equal(second.kept.length, 3, "no slot left: stored as usual, never lost");
	assert.equal(c.stats().overflow, 2);
	now = T0 + 60_000;
	await c.flush();
	assert.equal(first.kept.length + second.kept.length + flushed.reduce((n, s) => n + s.folded, 0), 6);
});

test("after = 0 turns collapse off", () => {
	const { c } = collapser(0);
	const plan = c.plan(ctx, "/v1/traces", Array.from({ length: 50 }, () => occurrence()));
	assert.equal(plan.kept.length, 50);
	assert.equal(c.enabled, false);
});
