import type { RuntimeOccurrence, RuntimeSeverity } from "./types.js";

/**
 * Suppression rules (1.9.0, EI-38): occurrences the user chose not to keep,
 * set per repository in Autter and delivered with the key (the validator's
 * `suppression` answer, cached with the key for 60 s), or on a static key
 * entry for self-hosted ingesters.
 *
 * A rule is a list of filters that must ALL match (AND) and an action:
 *
 *   { "id": "rsr_1", "action": "drop",
 *     "filters": [{ "key": "errorType", "op": "equals", "value": "AbortError" }] }
 *   { "id": "rsr_2", "action": "sample", "sampleRate": 0.1,
 *     "filters": [{ "key": "message", "op": "matches", "value": "ResizeObserver loop*" }] }
 *
 * Keys: errorType, message, service, environment, route, release, source
 * (`browser` or `server`). Operators, all case-insensitive: `equals`,
 * `contains`, `starts_with`, `matches` (a glob over the whole value where
 * `*` is any run of characters; matched segment by segment, so time is
 * linear in the value and no user pattern can stall ingest). A missing
 * value (no route, no release) is the empty string.
 *
 * Rules are tried in order and the first that matches decides: `drop`
 * leaves the occurrence out; `sample` keeps `sampleRate` (0 < rate < 1) of
 * them, chosen by the occurrence id, so a retried batch keeps the same
 * ones, and never samples out a `fatal` occurrence. Suppressed occurrences
 * are not stored or forwarded and are counted in `runtime_ingest_drops`
 * (reason `suppressed`). Request and error-rate rollups are not affected:
 * they count requests, not the occurrences kept.
 *
 * Parsing never throws: an invalid rule (unknown key or operator, empty or
 * oversized value, a sample rate outside (0, 1)) is left out on its own.
 */

export const SUPPRESSION_PROPERTIES = ["errorType", "message", "service", "environment", "route", "release", "source"] as const;
export type SuppressionProperty = (typeof SUPPRESSION_PROPERTIES)[number];

export const SUPPRESSION_OPERATORS = ["equals", "contains", "starts_with", "matches"] as const;
export type SuppressionOperator = (typeof SUPPRESSION_OPERATORS)[number];

export type SuppressionAction = "drop" | "sample";

export interface SuppressionFilter {
	key: SuppressionProperty;
	op: SuppressionOperator;
	/** Lower-cased at parse time: every comparison is case-insensitive. */
	value: string;
}

export interface SuppressionRule {
	id: string;
	filters: SuppressionFilter[];
	action: SuppressionAction;
	/** `sample` only: the share kept, 0 < rate < 1. */
	sampleRate?: number;
}

/** Longest filter value accepted; longer ones make the rule invalid. */
export const MAX_SUPPRESSION_VALUE_LENGTH = 500;

const PROPERTIES: ReadonlySet<string> = new Set(SUPPRESSION_PROPERTIES);
const OPERATORS: ReadonlySet<string> = new Set(SUPPRESSION_OPERATORS);

function parseFilter(raw: unknown): SuppressionFilter | null {
	if (!raw || typeof raw !== "object") return null;
	const { key, op, value } = raw as Record<string, unknown>;
	if (typeof key !== "string" || !PROPERTIES.has(key)) return null;
	if (typeof op !== "string" || !OPERATORS.has(op)) return null;
	if (typeof value !== "string" || !value || value.length > MAX_SUPPRESSION_VALUE_LENGTH) return null;
	return { key: key as SuppressionProperty, op: op as SuppressionOperator, value: value.toLowerCase() };
}

/** One rule, or null when any part of it is invalid (a rule is never half-applied). */
export function parseSuppressionRule(raw: unknown): SuppressionRule | null {
	if (!raw || typeof raw !== "object") return null;
	const { id, filters, action, sampleRate } = raw as Record<string, unknown>;
	if (typeof id !== "string" || !id || id.length > 200) return null;
	if (action !== "drop" && action !== "sample") return null;
	if (!Array.isArray(filters) || filters.length === 0) return null;
	const parsed: SuppressionFilter[] = [];
	for (const item of filters) {
		const filter = parseFilter(item);
		if (!filter) return null;
		parsed.push(filter);
	}
	if (action === "sample") {
		if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate >= 1) return null;
		return { id, filters: parsed, action, sampleRate };
	}
	return { id, filters: parsed, action };
}

/** The valid rules of a validator answer or static key entry, in order; [] for anything else. */
export function parseSuppressionRules(raw: unknown): SuppressionRule[] {
	if (!Array.isArray(raw)) return [];
	const rules: SuppressionRule[] = [];
	for (const item of raw) {
		try {
			const rule = parseSuppressionRule(item);
			if (rule) rules.push(rule);
		} catch {
			// A hostile getter or Proxy: leave the rule out.
		}
	}
	return rules;
}

/**
 * `*`-glob over the whole text: literal segments must appear in order, the
 * first anchored at the start unless the pattern starts with `*`, the last
 * at the end unless it ends with `*`. Each segment is found leftmost with
 * indexOf, which is always a valid placement for star-only globs, so there
 * is no backtracking. Both sides are expected lower-cased.
 */
export function globMatch(pattern: string, text: string): boolean {
	const segments = pattern.split("*");
	if (segments.length === 1) return pattern === text;
	const first = segments[0]!;
	const last = segments[segments.length - 1]!;
	if (!text.startsWith(first)) return false;
	let at = first.length;
	for (let i = 1; i < segments.length - 1; i++) {
		const segment = segments[i]!;
		if (!segment) continue;
		const found = text.indexOf(segment, at);
		if (found === -1) return false;
		at = found + segment.length;
	}
	return text.length - last.length >= at && text.endsWith(last);
}

function propertyOf(o: RuntimeOccurrence, key: SuppressionProperty): string {
	switch (key) {
		case "errorType":
			return o.errorType ?? "";
		case "message":
			return o.message ?? "";
		case "service":
			return o.service ?? "";
		case "environment":
			return o.environment ?? "";
		case "route":
			return o.route ?? "";
		case "release":
			return o.release ?? "";
		case "source":
			return o.source ?? "";
	}
}

function filterMatches(filter: SuppressionFilter, o: RuntimeOccurrence): boolean {
	const value = propertyOf(o, filter.key).toLowerCase();
	switch (filter.op) {
		case "equals":
			return value === filter.value;
		case "contains":
			return value.includes(filter.value);
		case "starts_with":
			return value.startsWith(filter.value);
		case "matches":
			return globMatch(filter.value, value);
	}
}

/** The first rule whose filters all match, or null. */
export function matchingRule(rules: readonly SuppressionRule[], o: RuntimeOccurrence): SuppressionRule | null {
	for (const rule of rules) {
		if (rule.filters.every((filter) => filterMatches(filter, o))) return rule;
	}
	return null;
}

/**
 * A stable number in [0, 1) for an occurrence: its id is a content-derived
 * hex digest (occurrenceIdFor), so the same occurrence in a retried batch
 * lands in the same place. Ids that are not hex fall back to FNV-1a.
 */
export function sampleUnit(occurrenceId: string): number {
	const head = occurrenceId.slice(0, 8);
	if (/^[0-9a-f]{8}$/i.test(head)) return Number.parseInt(head, 16) / 0x1_0000_0000;
	let hash = 0x811c9dc5;
	for (let i = 0; i < occurrenceId.length; i++) {
		hash ^= occurrenceId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash / 0x1_0000_0000;
}

const NEVER_SAMPLED: ReadonlySet<RuntimeSeverity> = new Set<RuntimeSeverity>(["fatal"]);

export interface SuppressionOutcome<T> {
	kept: T[];
	/** Occurrences left out (dropped or sampled out). */
	suppressed: number;
}

/** Apply the tenant's rules; order of the kept occurrences is preserved. */
export function applySuppression<T extends RuntimeOccurrence>(
	occurrences: T[],
	rules: readonly SuppressionRule[] | undefined,
): SuppressionOutcome<T> {
	if (!rules?.length || occurrences.length === 0) return { kept: occurrences, suppressed: 0 };
	const kept: T[] = [];
	let suppressed = 0;
	for (const o of occurrences) {
		let rule: SuppressionRule | null = null;
		try {
			rule = matchingRule(rules, o);
		} catch {
			// Never fail ingest on a rule: keep the occurrence.
		}
		if (!rule) {
			kept.push(o);
		} else if (rule.action === "drop") {
			suppressed += 1;
		} else if (NEVER_SAMPLED.has(o.severity) || sampleUnit(o.occurrenceId) < (rule.sampleRate ?? 1)) {
			kept.push(o);
		} else {
			suppressed += 1;
		}
	}
	return { kept, suppressed };
}
