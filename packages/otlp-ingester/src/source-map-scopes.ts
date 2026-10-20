import { forEachVlqGroup } from "./source-map-mappings.js";

/**
 * Function scopes uploaded with a source map (`x_autter_scopes`, written by
 * `autter-runtime sourcemaps upload` in @autter/runtime-cli after 1.0.0):
 * every function of the bundle as served, with its generated range and its
 * ORIGINAL name. A frame is named after the innermost function that
 * contains it — the name of the function it is in, as Sentry's
 * js-source-scopes and PostHog cymbal's `token.scope()` do — instead of the
 * name mapped at its caller's position, which is wrong whenever the call
 * goes through a variable or a framework.
 *
 * Shape: `{ version: 1, names: (string | null)[], scopes: string }`.
 * `scopes` is encoded like `mappings`: base64 VLQ, `;` between generated
 * lines (the line each scope starts on), `,` between the scopes that start
 * on one line, in start order (outer first on a tie). Each scope is 3 or 4
 * values, 0-based and in UTF-16 columns:
 *
 *   1. start column, relative to the previous scope's start on the same
 *      line (absolute for a line's first scope);
 *   2. end line, relative to the start line;
 *   3. end column (exclusive), relative to the start column when the scope
 *      ends on its start line, else absolute;
 *   4. the name, when the function has one: an index into the map's own
 *      `names` followed by `x_autter_scopes.names`, relative to the last
 *      name index written (starting from 0). A `null` entry in
 *      `x_autter_scopes.names` is a name the CLI could not map back.
 *
 * A 3-value scope is anonymous. Anything else (wrong version, bad VLQ,
 * out-of-range names, ranges that overlap without nesting) makes the whole
 * field unusable, and the map is used as if it had none.
 */

export const SCOPES_KEY = "x_autter_scopes";

export type ScopeName =
	/** In a function with a known original name. */
	| { kind: "named"; name: string }
	/** In an anonymous function, or in no function at all (top-level code). */
	| { kind: "anonymous" }
	/** In a named function whose original name is unknown. */
	| { kind: "unknown" };

const ANONYMOUS = -1;
/** startLine, startCol, endLine, endCol, nameIndex, parent. */
const STRIDE = 6;
const MAX_POSITION = 0x7fffffff;

const ANONYMOUS_SCOPE: ScopeName = { kind: "anonymous" };
const UNKNOWN_SCOPE: ScopeName = { kind: "unknown" };

class MalformedScopes extends Error {}

/** a < b for (line, column) pairs. */
function before(lineA: number, colA: number, lineB: number, colB: number): boolean {
	return lineA < lineB || (lineA === lineB && colA < colB);
}

/** Decode the `scopes` string into [startLine, startCol, endLine, endCol, nameIndex] rows. */
function decodeScopes(text: string, isName: (index: number) => boolean): number[][] {
	const rows: number[][] = [];
	let currentLine = 0;
	let startCol = 0;
	let name = 0;
	forEachVlqGroup(text, (line, values, count) => {
		if (count !== 3 && count !== 4) throw new MalformedScopes("a scope has 3 or 4 values");
		if (line !== currentLine) {
			currentLine = line;
			startCol = 0;
		}
		startCol += values[0]!;
		const endLine = line + values[1]!;
		const endCol = values[1] === 0 ? startCol + values[2]! : values[2]!;
		let nameIndex = ANONYMOUS;
		if (count === 4) {
			name += values[3]!;
			if (!isName(name)) throw new MalformedScopes("name out of range");
			nameIndex = name;
		}
		if (startCol < 0 || values[1]! < 0 || endCol < 0 || endLine > MAX_POSITION || Math.max(startCol, endCol) > MAX_POSITION) {
			throw new MalformedScopes("position out of range");
		}
		// Non-empty: a function is at least `()=>0`.
		if (!before(line, startCol, endLine, endCol)) throw new MalformedScopes("empty scope");
		rows.push([line, startCol, endLine, endCol, nameIndex]);
	});
	return rows;
}

export class ScopeIndex {
	private constructor(
		/** STRIDE ints per scope, sorted by start (outer first on a tie). */
		private readonly table: Int32Array,
		/** The map's own `names`, then `x_autter_scopes.names`. */
		private readonly mapNames: readonly unknown[],
		private readonly extraNames: readonly (string | null)[],
	) {}

	/** Number of function scopes. */
	get size(): number {
		return this.table.length / STRIDE;
	}

	/** Estimated memory, for the source map cache's byte budget (the map's
	 * own `names` are counted with the map). */
	get bytes(): number {
		let bytes = this.table.byteLength + 64;
		for (const name of this.extraNames) bytes += 2 * (name?.length ?? 0) + 32;
		return bytes;
	}

	/**
	 * The parsed `x_autter_scopes` value, or null when it is absent or
	 * malformed. `mapNames` is the map's own `names` array, which scope name
	 * indexes continue.
	 */
	static from(raw: unknown, mapNames: readonly unknown[] = []): ScopeIndex | null {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const { version, names, scopes } = raw as Record<string, unknown>;
		if (version !== 1 || !Array.isArray(names) || typeof scopes !== "string") return null;
		if (!names.every((name) => typeof name === "string" || name === null)) return null;
		const extraNames = names as (string | null)[];
		const isName = (index: number) =>
			index >= 0 &&
			(index < mapNames.length
				? typeof mapNames[index] === "string"
				: index - mapNames.length < extraNames.length);
		let entries: number[][];
		try {
			entries = decodeScopes(scopes, isName);
		} catch {
			return null;
		}
		// Encoded in order already; sort anyway so a hand-written field works too.
		entries.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || b[2]! - a[2]! || b[3]! - a[3]!);

		const table = new Int32Array(entries.length * STRIDE);
		// Open scopes, outermost first: each new scope either nests in the
		// innermost one still open or starts after it has ended.
		const open: number[] = [];
		for (let i = 0; i < entries.length; i++) {
			const [startLine, startCol, endLine, endCol, nameIndex] = entries[i]! as [number, number, number, number, number];
			while (open.length > 0) {
				const top = open[open.length - 1]! * STRIDE;
				if (before(startLine, startCol, table[top + 2]!, table[top + 3]!)) break;
				open.pop();
			}
			const parent = open.length > 0 ? open[open.length - 1]! : -1;
			if (parent >= 0 && before(table[parent * STRIDE + 2]!, table[parent * STRIDE + 3]!, endLine, endCol)) {
				return null; // overlaps its parent without nesting in it
			}
			const at = i * STRIDE;
			table[at] = startLine;
			table[at + 1] = startCol;
			table[at + 2] = endLine;
			table[at + 3] = endCol;
			table[at + 4] = nameIndex;
			table[at + 5] = parent;
			open.push(i);
		}
		return new ScopeIndex(table, mapNames, extraNames);
	}

	private nameOf(index: number): ScopeName {
		if (index === ANONYMOUS) return ANONYMOUS_SCOPE;
		const name = index < this.mapNames.length ? this.mapNames[index] : this.extraNames[index - this.mapNames.length];
		return typeof name === "string" ? { kind: "named", name } : UNKNOWN_SCOPE;
	}

	/**
	 * The name for a frame at a 0-based generated (line, column): the
	 * innermost function containing it. Outside every function (top-level
	 * code) it is anonymous.
	 */
	nameAt(line: number, column: number): ScopeName {
		const t = this.table;
		// Last scope that starts at or before the position…
		let lo = 0;
		let hi = this.size - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (before(line, column, t[mid * STRIDE]!, t[mid * STRIDE + 1]!)) hi = mid - 1;
			else {
				found = mid;
				lo = mid + 1;
			}
		}
		// …or, when it ended before the position, its closest ancestor that hasn't.
		for (let i = found; i >= 0; i = t[i * STRIDE + 5]!) {
			if (before(line, column, t[i * STRIDE + 2]!, t[i * STRIDE + 3]!)) return this.nameOf(t[i * STRIDE + 4]!);
		}
		return ANONYMOUS_SCOPE;
	}
}
