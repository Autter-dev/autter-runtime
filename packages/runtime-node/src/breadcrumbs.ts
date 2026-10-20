import { trace, type Attributes } from "@opentelemetry/api";
import {
	BREADCRUMBS_ATTRIBUTE,
	BREADCRUMBS_ATTRIBUTE_MAX_CHARS,
	BreadcrumbTrail,
	breadcrumbsAttribute,
	normalizeBreadcrumb,
	type BreadcrumbInput,
	type RuntimeLogContext,
	type RuntimeLogLevel,
} from "@autter/runtime-core";
import { noteCompatFeature } from "./compat.js";
import { local, loggerConfigured, type OperationState } from "./logger.js";
import { redactAttributes } from "./redact.js";
import { sharedSlot } from "./shared.js";

/**
 * Server breadcrumbs: the steps before an error, scoped to the current
 * request through AsyncLocalStorage.
 *
 * - Inside `autterRequests()` / `withRuntimeRequest()` / `withRuntimeOperation()`
 *   the trail belongs to the request (or root operation) and is shared with
 *   its child operations and forks.
 * - Elsewhere inside a traced request (OpenTelemetry's HTTP instrumentation
 *   without the middleware) it belongs to the active trace.
 * - Outside both, a process-wide trail (startup, timers) is used, so a crash
 *   outside any request still carries what happened before it.
 *
 * The last 30 are kept per scope. `captureException` / `captureMessage`
 * attach them to the exception span event as `autter.breadcrumbs` (a JSON
 * string), which the ingester validates, stores and forwards to the sink.
 */

const INVALID_TRACE_ID = "00000000000000000000000000000000";
/** Traces with a trail but no operation: insertion-ordered, oldest evicted. */
const MAX_TRACE_TRAILS = 200;
/** Trails outside operations, shared by every copy of this package in the
 * process (see shared.ts): a breadcrumb a route's copy records is attached by
 * the copy that captures the error. Errors thrown out of an operation keep
 * its trail (`thrown`): the span records them after the operation's
 * AsyncLocalStorage scope has already exited. */
const trails = sharedSlot("breadcrumbs", () => ({
	byTrace: new Map<string, BreadcrumbTrail>(),
	process: new BreadcrumbTrail(),
	thrown: new WeakMap<object, BreadcrumbTrail>(),
}));
const byTrace = trails.byTrace;
const processTrail = trails.process;
const thrownTrails = trails.thrown;

function redact(attributes: Attributes): Attributes {
	return loggerConfigured()?.redact(attributes) ?? redactAttributes(attributes);
}

function trailFor(
	create: boolean,
	state: OperationState | null | undefined = local.getStore(),
): BreadcrumbTrail | undefined {
	if (state) {
		if (!state.breadcrumbs && create) state.breadcrumbs = new BreadcrumbTrail();
		return state.breadcrumbs;
	}
	const traceId = trace.getActiveSpan()?.spanContext().traceId;
	if (traceId && traceId !== INVALID_TRACE_ID) {
		let trail = byTrace.get(traceId);
		if (!trail && create) {
			trail = new BreadcrumbTrail();
			byTrace.set(traceId, trail);
			if (byTrace.size > MAX_TRACE_TRAILS) {
				const oldest = byTrace.keys().next().value;
				if (oldest !== undefined) byTrace.delete(oldest);
			}
		}
		return trail;
	}
	return processTrail;
}

/**
 * Record a step (type "custom" unless you say otherwise) on the current
 * request. The next exception captured in it carries the last 30. Message
 * and data are scrubbed with your `redact` settings. Never throws.
 *
 *   addBreadcrumb({ message: "Loaded cart", data: { items: 3 } });
 */
export function addBreadcrumb(input: BreadcrumbInput): void {
	try {
		const crumb = normalizeBreadcrumb(input, redact);
		if (!crumb) return;
		trailFor(true)?.add(crumb);
		noteCompatFeature("breadcrumbs");
	} catch {
		/* never break the host app */
	}
}

/** @internal A runtimeLogger entry becomes a `log` breadcrumb on its operation's trail. */
export function recordLogBreadcrumb(
	level: RuntimeLogLevel,
	message: string,
	attributes: RuntimeLogContext,
	state: OperationState | undefined,
): void {
	try {
		const data: Record<string, unknown> = {};
		let count = 0;
		for (const [key, value] of Object.entries(attributes)) {
			if (count >= 10) break;
			if (/^(?:exception|autter)\./.test(key)) continue;
			if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
				data[key] = value;
				count++;
			}
		}
		const crumb = normalizeBreadcrumb({ type: "log", level, message, data }, redact);
		if (crumb) trailFor(true, state)?.add(crumb);
	} catch {
		/* never break logging */
	}
}

function attributeBudget(): number {
	// A smaller OTel attribute length limit would cut the JSON mid-array.
	const limit = Number(
		process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT ?? process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT,
	);
	return Number.isFinite(limit) && limit > 0
		? Math.min(BREADCRUMBS_ATTRIBUTE_MAX_CHARS, limit)
		: BREADCRUMBS_ATTRIBUTE_MAX_CHARS;
}

/** @internal An error escaping an operation remembers the operation's trail. */
export function rememberThrownBreadcrumbs(error: unknown, state: OperationState): void {
	if (state.breadcrumbs && error !== null && (typeof error === "object" || typeof error === "function"))
		thrownTrails.set(error, state.breadcrumbs);
}

/**
 * @internal `{ "autter.breadcrumbs": json }` for an exception span event in
 * the current scope (or the operation `error` was thrown out of), or `{}`.
 * `scrub` is the exporter's text scrubber.
 */
export function breadcrumbEventAttributes(
	scrub: (text: string) => string,
	error?: unknown,
): Record<string, string> {
	try {
		const thrown = error !== null && typeof error === "object" ? thrownTrails.get(error) : undefined;
		const trail = thrown ?? trailFor(false);
		if (!trail?.size) return {};
		const json = breadcrumbsAttribute(trail.list(), scrub, attributeBudget());
		return json ? { [BREADCRUMBS_ATTRIBUTE]: json } : {};
	} catch {
		return {};
	}
}

/** @internal Tests: forget every trail outside operations. */
export function resetBreadcrumbs(): void {
	byTrace.clear();
	processTrail.clear();
}
