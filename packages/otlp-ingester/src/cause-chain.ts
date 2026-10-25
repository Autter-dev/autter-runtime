import { detectFrameLanguage } from "./stack-frames.js";

/**
 * The causes of a reported exception (RF-06), for the `cause-v1`
 * fingerprint (fingerprint-v3.ts): its direct cause first, the root cause
 * last, each with its type and the stack text its frames are parsed from.
 *
 * Where the chain comes from:
 * - JVM: the `Caused by:` blocks of the stack (top level only; a
 *   `Suppressed:` block and the causes inside it are not part of the chain).
 * - .NET: `Outer ---> Inner ---> Root` in the header and the frame segments
 *   between `--- End of inner exception stack trace ---` markers, innermost
 *   exception first.
 * - Python: every top-level traceback block of a chained exception ("The
 *   above exception was the direct cause…", "During handling of the above
 *   exception…"); the first block is the root cause, the last the reported
 *   exception.
 * - Otherwise (JavaScript `cause`, and any SDK that sends them): the
 *   `exception.cause.N.type` / `exception.cause.N.stacktrace` attributes
 *   (runtime-core errorAttributes), N = 1, 2, … until one is missing.
 *
 * The reported exception's own frames are the ones parseStackFrames reads
 * from the whole stack (the first JVM block, the last .NET segment, the last
 * Python block), so a cause never repeats them. Shared parity vectors: the
 * `causes` of stack-parse-vectors.json.
 */

export interface CauseText {
	/** The cause's error type as written (`java.lang.IllegalStateException`, `TypeError`). */
	type: string;
	/** Its stack text (frames parse with parseStackFrames), or null when none was sent. */
	stack: string | null;
}

/** The causes of an exception, nearest first; [] when it has none. */
export function causeTexts(
	stack: string | null | undefined,
	attributes: Record<string, unknown> | null | undefined,
): CauseText[] {
	const fromStack = stack ? stackCauses(stack) : [];
	return fromStack.length > 0 ? fromStack : attributeCauses(attributes);
}

function stackCauses(stack: string): CauseText[] {
	const lines = stack.split(/\r?\n/);
	switch (detectFrameLanguage(lines)) {
		case "jvm":
			return jvmCauses(lines);
		case "dotnet":
			return dotnetCauses(lines);
		case "python":
			return pythonCauses(lines);
		default:
			return [];
	}
}

// ── JVM ───────────────────────────────────────────────────────────────────

const JVM_CAUSED_BY_RE = /^(\s*)Caused by:\s*([^\s:]+)/;

function jvmCauses(lines: string[]): CauseText[] {
	// The chain's "Caused by:" lines are indented no deeper than the header;
	// those of a suppressed exception are indented one level more.
	const header = lines.find((line) => line.trim() !== "") ?? "";
	const indent = header.length - header.trimStart().length;
	const starts: Array<{ index: number; type: string }> = [];
	lines.forEach((line, index) => {
		const match = JVM_CAUSED_BY_RE.exec(line);
		if (match && match[1]!.length <= indent) starts.push({ index, type: match[2]! });
	});
	return starts.map((start, k) => ({
		type: start.type,
		stack: lines.slice(start.index, starts[k + 1]?.index ?? lines.length).join("\n"),
	}));
}

// ── .NET ──────────────────────────────────────────────────────────────────

const DOTNET_FRAME_LINE_RE = /^\s*at\s/;
const DOTNET_END_INNER_RE = /---\s*End of inner exception stack trace\s*---/i;

function dotnetCauses(lines: string[]): CauseText[] {
	const firstFrame = lines.findIndex((line) => DOTNET_FRAME_LINE_RE.test(line));
	if (firstFrame <= 0) return [];
	// "Outer: msg ---> Inner: msg ---> Root: msg" (an arrow may start a line).
	const types = lines
		.slice(0, firstFrame)
		.join("\n")
		.split(/\s*--->\s*/)
		.map((part) => /^\s*([^\s:]+)/.exec(part)?.[1] ?? "");
	if (types.length < 2) return [];
	// Frame segments: the innermost exception's first, the reported one's last.
	const segments: string[][] = [[]];
	for (const line of lines.slice(firstFrame)) {
		if (DOTNET_END_INNER_RE.test(line)) segments.push([]);
		else segments[segments.length - 1]!.push(line);
	}
	const causes: CauseText[] = [];
	for (let k = 1; k < types.length; k++) {
		const segment = segments[segments.length - 1 - k];
		causes.push({ type: types[k]!, stack: segment && segment.length > 0 ? segment.join("\n") : null });
	}
	return causes;
}

// ── Python ────────────────────────────────────────────────────────────────

const PY_TRACEBACK_RE = /^\s*Traceback \(most recent call last\):\s*$/;
const PY_GROUP_TRACEBACK_RE = /^\s*\+ Exception Group Traceback \(most recent call last\):\s*$/;
const PY_CHAIN_RE =
	/^(?:During handling of the above exception, another exception occurred|The above exception was the direct cause of the following exception):\s*$/;
const PY_GROUP_MARGIN_RE = /^\s*\| ?/;
const PY_GROUP_SUBEXCEPTIONS_RE = /^\s*\+-/;
const PY_TYPE_RE = /^([A-Za-z_][\w.]*)(?::|\s*$)/;

function pythonCauses(lines: string[]): CauseText[] {
	const starts: Array<{ index: number; group: boolean }> = [];
	lines.forEach((line, index) => {
		if (PY_TRACEBACK_RE.test(line)) starts.push({ index, group: false });
		else if (PY_GROUP_TRACEBACK_RE.test(line)) starts.push({ index, group: true });
	});
	if (starts.length < 2) return [];
	const blocks = starts.map((start, k) => {
		const body = lines.slice(start.index, starts[k + 1]?.index ?? lines.length);
		return { type: pythonExceptionType(body.slice(1), start.group), stack: body.join("\n") };
	});
	// Printed root cause first and the reported exception last.
	return blocks.slice(0, -1).reverse();
}

/** The exception line of one traceback block: its first unindented line. */
function pythonExceptionType(body: string[], group: boolean): string {
	for (const raw of body) {
		let line = raw;
		if (group) {
			if (PY_GROUP_SUBEXCEPTIONS_RE.test(line)) break;
			line = line.replace(PY_GROUP_MARGIN_RE, "");
		}
		if (line.trim() === "" || /^\s/.test(line)) continue;
		if (PY_CHAIN_RE.test(line.trim())) break;
		return PY_TYPE_RE.exec(line)?.[1] ?? "";
	}
	return "";
}

// ── Attributes (JavaScript and any SDK that sends them) ───────────────────

function attributeCauses(attributes: Record<string, unknown> | null | undefined): CauseText[] {
	if (!attributes) return [];
	const causes: CauseText[] = [];
	for (let n = 1; ; n++) {
		const type = attributes[`exception.cause.${n}.type`];
		if (typeof type !== "string") break;
		const stack = attributes[`exception.cause.${n}.stacktrace`];
		causes.push({ type, stack: typeof stack === "string" && stack !== "" ? stack : null });
	}
	return causes;
}
