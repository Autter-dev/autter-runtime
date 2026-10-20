/**
 * Position lookups in a source map's `mappings`, without the memory of a
 * general-purpose decoder.
 *
 * @jridgewell/trace-mapping decodes `mappings` into one small array per
 * segment: about 14 bytes of heap per byte of JSON (a 5 MB map takes 67 MB).
 * Symbolication only needs "which original position is at or before this
 * generated one", so a map that is kept in the cache is decoded into one
 * Int32Array (5 ints per segment: about 3 bytes per byte of JSON), and a map
 * too big to keep is not decoded at all: its frames are resolved in one
 * streaming pass over the string.
 *
 * Lookup semantics match trace-mapping's `originalPositionFor` (greatest
 * lower bound): the first segment that starts at the frame's column, else
 * the last segment before it on the same line; a segment without a source
 * maps to nothing.
 */

/** An original position. Lines and columns are 0-based; `name` is -1 when the segment has none. */
export interface MappedSegment {
	source: number;
	line: number;
	column: number;
	name: number;
}

/** A 0-based generated (line, column). */
export interface GeneratedPosition {
	line: number;
	column: number;
}

/** generated column, source, original line, original column, name. */
const FIELDS = 5;
const NONE = -1;

const BASE64 = new Int8Array(128).fill(-1);
for (const [i, ch] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries()) {
	BASE64[ch.charCodeAt(0)] = i;
}

/**
 * Walk a mappings-style string — `;` between generated lines, `,` between
 * groups of base64 VLQ values — calling `visit(line, values, count)` with
 * each group's raw (relative) values. `values` is reused between calls and
 * holds the first 6; `count` is how many the group had. Throws on
 * malformed VLQ. Also reads `x_autter_scopes` (source-map-scopes.ts).
 */
export function forEachVlqGroup(
	text: string,
	visit: (line: number, values: readonly number[], count: number) => void,
): void {
	const values = [0, 0, 0, 0, 0, 0];
	let line = 0;
	let i = 0;
	while (i < text.length) {
		const ch = text.charCodeAt(i);
		if (ch === 59 /* ; */) {
			line++;
			i++;
			continue;
		}
		if (ch === 44 /* , */) {
			i++;
			continue;
		}
		let count = 0;
		while (i < text.length) {
			const next = text.charCodeAt(i);
			if (next === 44 || next === 59) break;
			let value = 0;
			let shift = 0;
			let digit: number;
			do {
				const code = text.charCodeAt(i++);
				digit = code < 128 ? BASE64[code]! : -1;
				if (digit < 0 || shift > 30) throw new Error("invalid VLQ");
				value |= (digit & 31) << shift;
				shift += 5;
			} while (digit & 32);
			if (count < values.length) values[count] = value & 1 ? -(value >>> 1) : value >>> 1;
			count++;
		}
		visit(line, values, count);
	}
}

/**
 * Walk every segment: `visit(line, generatedColumn, source, originalLine,
 * originalColumn, name)`, with source and name -1 when absent. Throws on
 * malformed VLQ.
 */
function forEachSegment(
	mappings: string,
	visit: (line: number, column: number, source: number, originalLine: number, originalColumn: number, name: number) => void,
): void {
	let currentLine = 0;
	let column = 0;
	let source = 0;
	let originalLine = 0;
	let originalColumn = 0;
	let name = 0;
	forEachVlqGroup(mappings, (line, values, count) => {
		// The generated column restarts on each line; the other fields don't.
		if (line !== currentLine) {
			currentLine = line;
			column = 0;
		}
		column += values[0]!;
		if (count >= 4) {
			source += values[1]!;
			originalLine += values[2]!;
			originalColumn += values[3]!;
		}
		if (count >= 5) name += values[4]!;
		visit(line, column, count >= 4 ? source : NONE, originalLine, originalColumn, count >= 5 ? name : NONE);
	});
}

/** Segments and generated lines in `mappings`, from one scan without decoding. */
function countSegments(mappings: string): { segments: number; lines: number } {
	let segments = 0;
	let lines = 1;
	let inSegment = false;
	for (let i = 0; i < mappings.length; i++) {
		const ch = mappings.charCodeAt(i);
		if (ch === 59) {
			lines++;
			inSegment = false;
		} else if (ch === 44) {
			inSegment = false;
		} else if (!inSegment) {
			segments++;
			inSegment = true;
		}
	}
	return { segments, lines };
}

/** Heap a DecodedMappings of `mappings` would take, without decoding it. */
export function decodedMappingsBytes(mappings: string): number {
	const { segments, lines } = countSegments(mappings);
	return segments * FIELDS * 4 + (lines + 1) * 4 + 64;
}

export class DecodedMappings {
	private constructor(
		/** FIELDS ints per segment, each line's segments sorted by generated column. */
		private readonly segments: Int32Array,
		/** Index of each line's first segment; one extra entry closes the last line. */
		private readonly lineStarts: Int32Array,
	) {}

	static decode(mappings: string): DecodedMappings {
		const { segments: count, lines } = countSegments(mappings);
		const segments = new Int32Array(count * FIELDS);
		const lineStarts = new Int32Array(lines + 1);
		let n = 0;
		let currentLine = 0;
		forEachSegment(mappings, (line, column, source, originalLine, originalColumn, name) => {
			while (currentLine < line) lineStarts[++currentLine] = n;
			const at = n * FIELDS;
			segments[at] = column;
			segments[at + 1] = source;
			segments[at + 2] = originalLine;
			segments[at + 3] = originalColumn;
			segments[at + 4] = name;
			n++;
		});
		while (currentLine < lines) lineStarts[++currentLine] = n;
		const decoded = new DecodedMappings(segments, lineStarts);
		for (let line = 0; line < lines; line++) decoded.sortLine(line);
		return decoded;
	}

	get bytes(): number {
		return this.segments.byteLength + this.lineStarts.byteLength + 64;
	}

	/** Generators almost always emit a line's segments in column order; sort the rare line that isn't (stable, as trace-mapping does). */
	private sortLine(line: number): void {
		const start = this.lineStarts[line]!;
		const end = this.lineStarts[line + 1]!;
		const s = this.segments;
		let sorted = true;
		for (let i = start + 1; i < end && sorted; i++) sorted = s[(i - 1) * FIELDS]! <= s[i * FIELDS]!;
		if (sorted) return;
		const rows: number[][] = [];
		for (let i = start; i < end; i++) rows.push(Array.from(s.subarray(i * FIELDS, (i + 1) * FIELDS)));
		rows.sort((a, b) => a[0]! - b[0]!);
		rows.forEach((row, k) => s.set(row, (start + k) * FIELDS));
	}

	/** The original position at a 0-based generated (line, column), or null. */
	find(line: number, column: number): MappedSegment | null {
		if (line < 0 || line + 1 >= this.lineStarts.length) return null;
		const s = this.segments;
		let lo = this.lineStarts[line]!;
		let hi = this.lineStarts[line + 1]! - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (s[mid * FIELDS]! <= column) {
				found = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		if (found < 0) return null;
		// Several segments at exactly this column: the first one (before it,
		// the last one — as trace-mapping does).
		if (s[found * FIELDS] === column) {
			while (found > this.lineStarts[line]! && s[(found - 1) * FIELDS] === column) found--;
		}
		const at = found * FIELDS;
		if (s[at + 1] === NONE) return null;
		return { source: s[at + 1]!, line: s[at + 2]!, column: s[at + 3]!, name: s[at + 4]! };
	}
}

/**
 * Resolve several positions in one pass over `mappings` without decoding
 * it — for maps too big to keep. Same results as DecodedMappings.find.
 */
export function findInMappings(mappings: string, positions: readonly GeneratedPosition[]): Array<MappedSegment | null> {
	const byLine = new Map<number, number[]>();
	positions.forEach((position, index) => {
		const list = byLine.get(position.line);
		if (list) list.push(index);
		else byLine.set(position.line, [index]);
	});
	const best: Array<{ column: number; segment: MappedSegment | null } | null> = positions.map(() => null);
	forEachSegment(mappings, (line, column, source, originalLine, originalColumn, name) => {
		const wanted = byLine.get(line);
		if (!wanted) return;
		for (const index of wanted) {
			const target = positions[index]!.column;
			const current = best[index];
			// Greatest column at or before the position. On a tie the first
			// segment wins at the position itself and the last one before it.
			if (column > target) continue;
			if (current && (current.column > column || (current.column === column && column === target))) continue;
			best[index] = {
				column,
				segment: source === NONE ? null : { source, line: originalLine, column: originalColumn, name },
			};
		}
	});
	return best.map((found) => found?.segment ?? null);
}
