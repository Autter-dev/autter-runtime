import { sharedSlot } from "./shared.js";

/**
 * Errors already reported, by any copy of this package in the process (see
 * shared.ts): an error a route's copy reported is skipped by the copy Next's
 * `onRequestError` runs in. A WeakSet keyed by identity, so it also marks
 * errors from another realm (Next's edge sandbox) and frozen errors.
 */
const CAPTURED = sharedSlot("requests", () => ({ captured: new WeakSet<object>() })).captured;

/** @internal Remember errors already captured so boundaries don't double-report. */
export function markCaptured(error: unknown): void {
	if (error && typeof error === "object") CAPTURED.add(error);
}

/** @internal True for an error some capture path already reported. */
export function isCaptured(error: unknown): boolean {
	return !!error && typeof error === "object" && CAPTURED.has(error);
}
