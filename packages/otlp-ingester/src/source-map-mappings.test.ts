import assert from "node:assert/strict";
import { test } from "node:test";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { DecodedMappings, decodedMappingsBytes, findInMappings } from "./source-map-mappings.js";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n: number): string {
	let v = n < 0 ? (-n << 1) | 1 : n << 1;
	let out = "";
	do {
		let digit = v & 31;
		v >>>= 5;
		if (v > 0) digit |= 32;
		out += B64[digit];
	} while (v > 0);
	return out;
}

/** A deterministic pseudo-random generator, so a failure reproduces. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
}

/** Random `mappings` with what real generators emit and a few things they
 * shouldn't: empty lines, generated-only segments, several segments on one
 * column, and an unsorted line. */
function randomMappings(rand: () => number, lines: number): string {
	let source = 0;
	let line = 0;
	let column = 0;
	let name = 0;
	const out: string[] = [];
	for (let l = 0; l < lines; l++) {
		const segments: Array<number[]> = [];
		const count = rand() < 0.15 ? 0 : Math.floor(rand() * 40);
		let gen = 0;
		for (let s = 0; s < count; s++) {
			gen += rand() < 0.1 ? 0 : 1 + Math.floor(rand() * 30);
			if (rand() < 0.08) segments.push([gen]);
			else if (rand() < 0.5) segments.push([gen, Math.floor(rand() * 3), Math.floor(rand() * 200), Math.floor(rand() * 80)]);
			else segments.push([gen, Math.floor(rand() * 3), Math.floor(rand() * 200), Math.floor(rand() * 80), Math.floor(rand() * 10)]);
		}
		if (l === 3 && segments.length > 3) segments.reverse();
		let prevGen = 0;
		out.push(
			segments
				.map((seg) => {
					const parts = [seg[0]! - prevGen];
					prevGen = seg[0]!;
					if (seg.length >= 4) {
						parts.push(seg[1]! - source, seg[2]! - line, seg[3]! - column);
						[source, line, column] = [seg[1]!, seg[2]!, seg[3]!];
					}
					if (seg.length === 5) {
						parts.push(seg[4]! - name);
						name = seg[4]!;
					}
					return parts.map(vlq).join("");
				})
				.join(","),
		);
	}
	return out.join(";");
}

test("compact lookups match trace-mapping's originalPositionFor, decoded or streamed", () => {
	for (const seed of [1, 2, 3, 4, 5]) {
		const rand = random(seed);
		const mappings = randomMappings(rand, 30);
		const map = new TraceMap({
			version: 3,
			sources: ["a.ts", "b.ts", "c.ts"],
			names: Array.from({ length: 10 }, (_, i) => `n${i}`),
			mappings,
		});
		const decoded = DecodedMappings.decode(mappings);
		const positions = Array.from({ length: 600 }, () => ({ line: Math.floor(rand() * 33), column: Math.floor(rand() * 700) }));
		const streamed = findInMappings(mappings, positions);
		positions.forEach((position, i) => {
			const expected = originalPositionFor(map, { line: position.line + 1, column: position.column });
			const found = decoded.find(position.line, position.column);
			const actual = found
				? { source: map.resolvedSources[found.source], line: found.line + 1, column: found.column, name: found.name >= 0 ? map.names[found.name] : null }
				: { source: null, line: null, column: null, name: null };
			assert.deepEqual(actual, expected, `seed ${seed} ${JSON.stringify(position)}`);
			assert.deepEqual(streamed[i], found, `streamed, seed ${seed} ${JSON.stringify(position)}`);
		});
		// The estimate made before decoding is the decoded size.
		assert.equal(decodedMappingsBytes(mappings), decoded.bytes);
	}
});

test("malformed mappings throw instead of resolving garbage", () => {
	assert.throws(() => DecodedMappings.decode("AAAA,!!"));
	assert.throws(() => findInMappings("AAAA;gggggggggg", [{ line: 1, column: 0 }]));
	assert.equal(DecodedMappings.decode("").find(0, 0), null);
	assert.deepEqual(findInMappings("", [{ line: 0, column: 3 }]), [null]);
});
