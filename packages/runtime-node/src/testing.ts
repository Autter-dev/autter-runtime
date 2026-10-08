/**
 * Test helpers — `@autter/runtime-node/testing`. No ingester, no network:
 * every record the SDK would export is kept in memory.
 *
 *   import { captureRuntime, expectOperation } from "@autter/runtime-node/testing";
 *
 *   const runtime = captureRuntime();
 *   await request(app).post("/checkout").expect(402);
 *   expectOperation(runtime, "POST /checkout")
 *     .toHaveOutcome("degraded")
 *     .toHaveErrorCode("billing.declined");
 *   runtime.stop();
 *
 * Works with or without initAutterServer/initAutterLogging; before init it
 * replaces the default console output instead of adding to it.
 */
import { isSummary, type RuntimeEvent, type RuntimeOutcome } from "@autter/runtime-core";
import { addRuntimeSink } from "./logger.js";
import { memorySink, type CapturedException } from "./sinks.js";

export { memorySink, type MemorySink, type CapturedException } from "./sinks.js";
export type { RuntimeEvent };

export interface RuntimeCapture {
	/** Every record, in emission order. */
	readonly events: RuntimeEvent[];
	/** Operation and request summaries. */
	readonly operations: RuntimeEvent[];
	/** Plain log records (warn/error and records outside operations). */
	readonly logs: RuntimeEvent[];
	/** Every captureException call (including boundary captures). */
	readonly exceptions: CapturedException[];
	/** All records stamped with this request id. */
	byRequestId(requestId: string): RuntimeEvent[];
	clear(): void;
	/** Detach from the logger. */
	stop(): void;
}

export function captureRuntime(): RuntimeCapture {
	const sink = memorySink();
	const remove = addRuntimeSink(sink);
	return {
		get events() {
			return [...sink.events];
		},
		get operations() {
			return sink.events.filter(isSummary);
		},
		get logs() {
			return sink.events.filter((event) => !isSummary(event));
		},
		get exceptions() {
			return [...sink.exceptions];
		},
		byRequestId: (requestId) =>
			sink.events.filter((event) => event.attributes["autter.request.id"] === requestId),
		clear: () => sink.clear(),
		stop: () => {
			remove();
		},
	};
}

function partialMatch(actual: unknown, expected: unknown): boolean {
	if (expected && typeof expected === "object" && !Array.isArray(expected)) {
		if (!actual || typeof actual !== "object") return false;
		return Object.entries(expected).every(([key, value]) =>
			partialMatch((actual as Record<string, unknown>)[key], value),
		);
	}
	if (Array.isArray(expected))
		return (
			Array.isArray(actual) &&
			expected.length === actual.length &&
			expected.every((item, i) => partialMatch(actual[i], item))
		);
	return Object.is(actual, expected);
}

class OperationExpectation {
	constructor(readonly event: RuntimeEvent) {}
	get attributes(): Record<string, unknown> {
		return this.event.attributes;
	}
	private fail(message: string): never {
		const error = new Error(
			`expectOperation(${JSON.stringify(this.attributes["autter.operation.name"])}): ${message}`,
		);
		error.name = "AssertionError";
		throw error;
	}
	toHaveOutcome(outcome: RuntimeOutcome): this {
		const actual = this.attributes["autter.operation.outcome"];
		if (actual !== outcome) this.fail(`expected outcome ${outcome}, got ${String(actual)}`);
		return this;
	}
	toHaveKind(kind: "request" | "operation"): this {
		const actual = this.attributes["autter.operation.kind"];
		if (actual !== kind) this.fail(`expected kind ${kind}, got ${String(actual)}`);
		return this;
	}
	/** Deep partial match against the summary attributes. */
	toHaveContext(expected: Record<string, unknown>): this {
		if (!partialMatch(this.attributes, expected))
			this.fail(`context does not match ${JSON.stringify(expected)}`);
		return this;
	}
	toHaveStep(name: string, status?: "succeeded" | "failed"): this {
		const steps = (this.attributes["autter.operation.steps"] ?? []) as Array<{ name: string; status: string }>;
		if (!steps.some((step) => step.name === name && (!status || step.status === status)))
			this.fail(`no step ${name}${status ? ` (${status})` : ""}`);
		return this;
	}
	toHaveErrorCode(code: string): this {
		const actual = this.attributes["autter.error.code"];
		if (actual !== code) this.fail(`expected error code ${code}, got ${String(actual)}`);
		return this;
	}
	toHaveLog(message: string | RegExp, level?: string): this {
		const logs = (this.attributes["autter.operation.logs"] ?? []) as Array<{ message: string; level: string }>;
		const ok = logs.some(
			(log) =>
				(typeof message === "string" ? log.message === message : message.test(log.message)) &&
				(!level || log.level === level),
		);
		if (!ok) this.fail(`no inline log ${String(message)}`);
		return this;
	}
	toHaveRequestId(requestId?: string): this {
		const actual = this.attributes["autter.request.id"];
		if (requestId === undefined ? typeof actual !== "string" : actual !== requestId)
			this.fail(`expected request id ${requestId ?? "(any)"}, got ${String(actual)}`);
		return this;
	}
}

/**
 * Find the most recent summary named `name` (exact string or RegExp) and
 * return chainable assertions. Throws when no such summary exists.
 */
export function expectOperation(
	source: RuntimeCapture | RuntimeEvent[],
	name: string | RegExp,
): OperationExpectation {
	const events = Array.isArray(source) ? source.filter(isSummary) : source.operations;
	const matches = events.filter((event) => {
		const actual = String(event.attributes["autter.operation.name"] ?? "");
		return typeof name === "string" ? actual === name : name.test(actual);
	});
	const event = matches[matches.length - 1];
	if (!event) {
		const seen = events.map((e) => e.attributes["autter.operation.name"]);
		const error = new Error(
			`expectOperation: no operation named ${String(name)} (saw ${JSON.stringify(seen)})`,
		);
		error.name = "AssertionError";
		throw error;
	}
	return new OperationExpectation(event);
}
export type { OperationExpectation };
