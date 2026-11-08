/**
 * Index source maps (`{ "version": 3, "sections": [...] }`, ECMA-426 §
 * "Index source map"): one map made of several regular maps, each placed at
 * a generated offset. Turbopack (Next.js 16's default bundler) writes them
 * for some server files. The ingester stores and reads regular maps only, so
 * `upload` flattens an index map into one before sending it.
 */

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((ch, i) => [ch, i]));

/** [generated column, source, original line, original column, name?], absolute. */
type Segment = number[];

function decode(mappings: string): Segment[][] {
	const lines: Segment[][] = [];
	let source = 0;
	let line = 0;
	let column = 0;
	let name = 0;
	for (const text of mappings.split(";")) {
		const segments: Segment[] = [];
		let generated = 0;
		for (const part of text ? text.split(",") : []) {
			if (!part) continue;
			const values: number[] = [];
			let shift = 0;
			let value = 0;
			for (const ch of part) {
				const digit = DIGIT.get(ch);
				if (digit === undefined) throw new Error(`invalid mappings character ${JSON.stringify(ch)}`);
				value += (digit & 31) * 2 ** shift;
				if (digit & 32) shift += 5;
				else {
					values.push(value % 2 ? -Math.floor(value / 2) : value / 2);
					value = 0;
					shift = 0;
				}
			}
			generated += values[0] ?? 0;
			if (values.length >= 4) {
				source += values[1]!;
				line += values[2]!;
				column += values[3]!;
				const segment = [generated, source, line, column];
				if (values.length >= 5) {
					name += values[4]!;
					segment.push(name);
				}
				segments.push(segment);
			} else {
				segments.push([generated]);
			}
		}
		lines.push(segments);
	}
	return lines;
}

function vlq(value: number): string {
	let rest = value < 0 ? -value * 2 + 1 : value * 2;
	let out = "";
	do {
		let digit = rest % 32;
		rest = Math.floor(rest / 32);
		if (rest > 0) digit |= 32;
		out += BASE64[digit];
	} while (rest > 0);
	return out;
}

function encode(lines: Segment[][]): string {
	let source = 0;
	let line = 0;
	let column = 0;
	let name = 0;
	return lines
		.map((segments) => {
			let generated = 0;
			return segments
				.map((segment) => {
					let out = vlq(segment[0]! - generated);
					generated = segment[0]!;
					if (segment.length >= 4) {
						out += vlq(segment[1]! - source) + vlq(segment[2]! - line) + vlq(segment[3]! - column);
						source = segment[1]!;
						line = segment[2]!;
						column = segment[3]!;
						if (segment.length >= 5) {
							out += vlq(segment[4]! - name);
							name = segment[4]!;
						}
					}
					return out;
				})
				.join(",");
		})
		.join(";");
}

export function isIndexMap(map: unknown): map is { sections: unknown[] } {
	return Boolean(map) && typeof map === "object" && Array.isArray((map as { sections?: unknown }).sections);
}

/**
 * One regular map equivalent to an index map: sources, contents, names and
 * ignore lists concatenated, each section's mappings moved to its offset
 * (the column offset applies to the section's first line only). Nested
 * index maps are flattened too. Throws on a malformed section.
 */
export function flattenIndexMap(map: Record<string, unknown>): Record<string, unknown> {
	const sources: string[] = [];
	const contents: Array<string | null> = [];
	const names: string[] = [];
	const ignoreList: number[] = [];
	const lines: Segment[][] = [];

	const addMap = (sub: Record<string, unknown>, lineOffset: number, columnOffset: number) => {
		if (isIndexMap(sub)) return addSections(sub as Record<string, unknown>, lineOffset, columnOffset);
		if (typeof sub.mappings !== "string" || !Array.isArray(sub.sources)) throw new Error("a section's map has no mappings or sources");
		const sourceBase = sources.length;
		const nameBase = names.length;
		const root = typeof sub.sourceRoot === "string" && sub.sourceRoot ? sub.sourceRoot.replace(/\/?$/, "/") : "";
		const subContents = Array.isArray(sub.sourcesContent) ? sub.sourcesContent : [];
		sub.sources.forEach((source, index) => {
			sources.push(typeof source === "string" ? `${root}${source}` : "");
			const content = subContents[index];
			contents.push(typeof content === "string" ? content : null);
		});
		for (const name of Array.isArray(sub.names) ? sub.names : []) names.push(typeof name === "string" ? name : "");
		const ignored = Array.isArray(sub.ignoreList) ? sub.ignoreList : Array.isArray(sub.x_google_ignoreList) ? sub.x_google_ignoreList : [];
		for (const index of ignored) if (typeof index === "number") ignoreList.push(index + sourceBase);
		decode(sub.mappings).forEach((segments, i) => {
			const target = lineOffset + i;
			while (lines.length <= target) lines.push([]);
			for (const segment of segments) {
				const moved = [segment[0]! + (i === 0 ? columnOffset : 0)];
				if (segment.length >= 4) moved.push(segment[1]! + sourceBase, segment[2]!, segment[3]!);
				if (segment.length >= 5) moved.push(segment[4]! + nameBase);
				lines[target]!.push(moved);
			}
		});
	};

	const addSections = (index: Record<string, unknown>, lineOffset: number, columnOffset: number) => {
		for (const section of index.sections as unknown[]) {
			const { offset, map: sub } = (section ?? {}) as { offset?: { line?: unknown; column?: unknown }; map?: unknown };
			const line = typeof offset?.line === "number" ? offset.line : NaN;
			const column = typeof offset?.column === "number" ? offset.column : NaN;
			if (!Number.isInteger(line) || !Number.isInteger(column) || !sub || typeof sub !== "object") {
				throw new Error("an index map section has no offset or map");
			}
			addMap(sub as Record<string, unknown>, lineOffset + line, (line === 0 ? columnOffset : 0) + column);
		}
	};

	addSections(map, 0, 0);
	for (const segments of lines) segments.sort((a, b) => a[0]! - b[0]!);
	const flat: Record<string, unknown> = {
		version: 3,
		...(typeof map.file === "string" ? { file: map.file } : {}),
		sources,
		names,
		mappings: encode(lines),
	};
	if (contents.some((content) => content !== null)) flat.sourcesContent = contents;
	if (ignoreList.length) flat.ignoreList = ignoreList;
	if (map.debugId !== undefined) flat.debugId = map.debugId;
	return flat;
}
