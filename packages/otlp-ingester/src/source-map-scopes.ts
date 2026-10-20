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
 * Shape: `{ version: 1, names: string[], scopes: [startLine, startCol,
 * endLine, endCol, nameIndex][] }` — 0-based generated lines and UTF-16
 * columns, end exclusive; nameIndex into `names`, -1 for an anonymous
 * function, -2 for a named one whose original name the CLI could not map.
 * Anything else (wrong version, bad entries, ranges that overlap without
 * nesting) makes the whole field unusable, and the map is used as if it
 * had none.
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
const UNKNOWN = -2;
/** startLine, startCol, endLine, endCol, nameIndex, parent. */
const STRIDE = 6;
const MAX_POSITION = 0x7fffffff;

const ANONYMOUS_SCOPE: ScopeName = { kind: "anonymous" };
const UNKNOWN_SCOPE: ScopeName = { kind: "unknown" };

type Entry = [number, number, number, number, number];

function isEntry(value: unknown, nameCount: number): value is Entry {
	if (!Array.isArray(value) || value.length !== 5) return false;
	for (let i = 0; i < 4; i++) {
		const n = value[i];
		if (!Number.isInteger(n) || n < 0 || n > MAX_POSITION) return false;
	}
	const [startLine, startCol, endLine, endCol, nameIndex] = value as Entry;
	if (!Number.isInteger(nameIndex) || nameIndex < UNKNOWN || nameIndex >= nameCount) return false;
	// Non-empty: a function is at least `()=>0`.
	return endLine > startLine || (endLine === startLine && endCol > startCol);
}

/** a < b for (line, column) pairs. */
function before(lineA: number, colA: number, lineB: number, colB: number): boolean {
	return lineA < lineB || (lineA === lineB && colA < colB);
}

export class ScopeIndex {
	private constructor(
		/** STRIDE ints per scope, sorted by start (outer first on a tie). */
		private readonly table: Int32Array,
		private readonly names: readonly string[],
	) {}

	/** Number of function scopes. */
	get size(): number {
		return this.table.length / STRIDE;
	}

	/** Estimated memory, for the source map cache's byte budget. */
	get bytes(): number {
		let bytes = this.table.byteLength + 64;
		for (const name of this.names) bytes += 2 * name.length + 32;
		return bytes;
	}

	/** The parsed `x_autter_scopes` value, or null when it is absent or malformed. */
	static from(raw: unknown): ScopeIndex | null {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const { version, names, scopes } = raw as Record<string, unknown>;
		if (version !== 1 || !Array.isArray(names) || !Array.isArray(scopes)) return null;
		if (!names.every((name) => typeof name === "string")) return null;
		const entries: Entry[] = [];
		for (const entry of scopes) {
			if (!isEntry(entry, names.length)) return null;
			entries.push(entry);
		}
		entries.sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[2] - a[2] || b[3] - a[3]);

		const table = new Int32Array(entries.length * STRIDE);
		// Open scopes, outermost first: each new scope either nests in the
		// innermost one still open or starts after it has ended.
		const open: number[] = [];
		for (let i = 0; i < entries.length; i++) {
			const [startLine, startCol, endLine, endCol, nameIndex] = entries[i]!;
			while (open.length > 0) {
				const top = open[open.length - 1]! * STRIDE;
				if (before(startLine, startCol, table[top + 2]!, table[top + 3]!)) break;
				open.pop();
			}
			const parent = open.length > 0 ? open[open.length - 1]! : -1;
			if (parent >= 0 && before(table[parent * STRIDE + 2]!, table[parent * STRIDE + 3]!, endLine, endCol)) {
				return null; // overlaps its parent without nesting in it
			}
			table.set([startLine, startCol, endLine, endCol, nameIndex, parent], i * STRIDE);
			open.push(i);
		}
		return new ScopeIndex(table, names as string[]);
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
			if (!before(line, column, t[i * STRIDE + 2]!, t[i * STRIDE + 3]!)) continue;
			const nameIndex = t[i * STRIDE + 4]!;
			if (nameIndex === ANONYMOUS) return ANONYMOUS_SCOPE;
			if (nameIndex === UNKNOWN) return UNKNOWN_SCOPE;
			return { kind: "named", name: this.names[nameIndex]! };
		}
		return ANONYMOUS_SCOPE;
	}
}
