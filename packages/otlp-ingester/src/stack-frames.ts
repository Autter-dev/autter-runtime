import { detectStackLanguage } from "./fingerprint.js";
import type { StackFrame } from "./types.js";

/**
 * Raw stack text → structured frames, INNERMOST (crash site) FIRST.
 *
 * The legacy `message-v1` fingerprint hashes stack lines as text, which
 * keeps Python line numbers, takes Python's outermost frames, and counts
 * dependency frames. `frames-v3` (fingerprint-v3.ts) hashes structured
 * frames instead, so every supported language is parsed into the sink's
 * StackFrame shape here, in one consistent orientation:
 *
 * - V8 (Node, Chrome, Edge): `at fn (file:line:col)` / `at file:line:col`
 * - Firefox / Safari: `fn@url:line:col` / `@url:line:col`
 * - Python: `File "…", line N, in fn` — tracebacks list the OUTERMOST frame
 *   first, so the frames are reversed; only the reported exception's own
 *   frames are used: the last top-level block of a chained exception, and
 *   for an exception group (3.11+) its own `| `-margined block, never its
 *   sub-exceptions
 * - Go: function line + `\t<file>.go:<line> +0x…`, first goroutine only
 * - JVM: `at pkg.Class.method(File.java:N)`, first exception block only
 *   (before `Caused by:`)
 * - .NET: `at Ns.Type.Method(args) in <file>:line N`; for wrapped
 *   exceptions only the frames after the last "End of inner exception"
 * - Rust: `N: path::to::fn` + `at <file>:<line>:<col>`
 * - Ruby / PHP best effort, so those stacks do not collapse to the message
 *
 * `inApp` follows the contract §3 rule (isInAppFrame). `resolved` is always
 * false here; symbolicate.ts sets it for frames a source map resolved.
 * Shared parity vectors: stack-parse-vectors.json.
 */

/** Frames kept per stack (contract §1: at most 50). */
export const MAX_FRAMES = 50;
const MAX_FUNCTION_CHARS = 500;
const MAX_PATH_CHARS = 1000;

export type FrameLanguage =
	| "javascript"
	| "python"
	| "go"
	| "jvm"
	| "dotnet"
	| "rust"
	| "ruby"
	| "php";

// ── In-app rule (contract §3) ─────────────────────────────────────────────

const NOT_IN_APP_PATH_PARTS = [
	"node_modules/",
	"/site-packages/",
	"/dist-packages/",
	"/vendor/",
	"/.pnpm/",
];
const NOT_IN_APP_PATH_PREFIXES = ["node:", "internal/"];
const EXTENSION_SCHEMES = [
	"chrome-extension:",
	"moz-extension:",
	"safari-extension:",
	"safari-web-extension:",
	"webkit-masked-url:",
];

/**
 * Path half of §3: dependency directories, Node internals and browser
 * extension scripts are not in-app. Windows separators are normalised so
 * `C:\app\node_modules\x.js` counts too. A frame with no path is in-app.
 */
export function isInAppPath(path: string | null): boolean {
	if (!path) return true;
	const normalized = path.replace(/\\/g, "/");
	if (NOT_IN_APP_PATH_PARTS.some((part) => normalized.includes(part))) return false;
	if (NOT_IN_APP_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
	const lower = normalized.toLowerCase();
	if (EXTENSION_SCHEMES.some((scheme) => lower.startsWith(scheme))) return false;
	return true;
}

/**
 * Python's standard library: frozen modules (`<frozen runpy>`) and the
 * version directory of an installation (`/usr/local/lib/python3.12/`,
 * `…/Versions/3.14/lib/python3.14/`, `C:\Python312\Lib\`); a
 * virtualenv's packages are `site-packages`, covered by the path rule. Like
 * Go's `/usr/local/go/`, they are the runtime, not the app: an asyncio or
 * socket error's first five frames would otherwise all be stdlib frames.
 */
const PY_STDLIB_RE = /\/lib\/(?:python|pypy)\d\.\d+t?\/|\/python\d{2,3}t?\/lib\//i;

export function isPythonStdlibPath(path: string | null): boolean {
	if (!path) return false;
	if (path.startsWith("<frozen ")) return true;
	return PY_STDLIB_RE.test(path.replace(/\\/g, "/"));
}

/** Fully qualified name for the language rules (`module.function`). */
function qualifiedName(frame: Pick<StackFrame, "function" | "module">): string {
	if (frame.module && frame.function) return `${frame.module}.${frame.function}`;
	return frame.module ?? frame.function ?? "";
}

/**
 * Contract §3. Source-map ignore lists are applied by symbolicate.ts; the
 * language rules apply only to frames of that language, so a JS object
 * that happens to be called `runtime` or `System` stays in-app.
 */
export function isInAppFrame(
	frame: Pick<StackFrame, "function" | "module" | "filename">,
	language: FrameLanguage | null,
): boolean {
	if (!isInAppPath(frame.filename)) return false;
	const qualified = qualifiedName(frame);
	if (language === "go") {
		if (qualified.startsWith("runtime.")) return false;
		if ((frame.filename ?? "").replace(/\\/g, "/").includes("/usr/local/go/")) return false;
	}
	if (language === "python" && isPythonStdlibPath(frame.filename)) return false;
	if (language === "jvm" && /^(?:java|javax|kotlin|jdk)\./.test(qualified)) return false;
	if (language === "dotnet" && /^(?:System|Microsoft)\./.test(qualified)) return false;
	return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Strip a query string and/or hash from a path or URL. */
export function stripQueryAndHash(path: string): string {
	const at = path.search(/[?#]/);
	return at === -1 ? path : path.slice(0, at);
}

function clean(value: string | null | undefined, max: number): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : null;
}

function toInt(value: string | undefined): number | null {
	if (value === undefined) return null;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : null;
}

function frame(
	language: FrameLanguage,
	parts: {
		function?: string | null;
		module?: string | null;
		filename?: string | null;
		lineno?: number | null;
		colno?: number | null;
	},
): StackFrame {
	const filename = clean(parts.filename ? stripQueryAndHash(parts.filename) : null, MAX_PATH_CHARS);
	const out: StackFrame = {
		function: clean(parts.function, MAX_FUNCTION_CHARS),
		module: clean(parts.module, MAX_FUNCTION_CHARS),
		filename,
		lineno: parts.lineno ?? null,
		colno: parts.colno ?? null,
		inApp: true,
		resolved: false,
	};
	out.inApp = isInAppFrame(out, language);
	return out;
}

/**
 * Drop the trailing (balanced) call-argument group: "f(0x1, 0x2)" → "f",
 * "C->handle(Object(Request))" → "C->handle". Receiver parentheses earlier
 * in the name ("main.(*T).M(…)") are kept.
 */
function stripTrailingArgs(fn: string): string {
	const trimmed = fn.trim();
	if (!trimmed.endsWith(")")) return trimmed;
	let depth = 0;
	for (let i = trimmed.length - 1; i >= 0; i--) {
		const ch = trimmed[i];
		if (ch === ")") depth++;
		else if (ch === "(" && --depth === 0) return i > 0 ? trimmed.slice(0, i).trim() : trimmed;
	}
	return trimmed;
}

/** Split at the last "." outside brackets/angles: "A.B.C[T]" → ["A.B", "C[T]"]. */
function splitLastDot(name: string): [string | null, string] {
	let depth = 0;
	for (let i = name.length - 1; i > 0; i--) {
		const ch = name[i]!;
		if (ch === "]" || ch === ">" || ch === ")") depth++;
		else if (ch === "[" || ch === "<" || ch === "(") depth = Math.max(0, depth - 1);
		else if (ch === "." && depth === 0) {
			// ".ctor" / ".cctor": the dot belongs to the method name.
			if (name[i - 1] === ".") return [name.slice(0, i - 1), name.slice(i)];
			return [name.slice(0, i), name.slice(i + 1)];
		}
	}
	return [null, name];
}

// ── JavaScript ────────────────────────────────────────────────────────────

const V8_LINE_RE = /^\s*at\s+(.*)$/;
const V8_WITH_FN_RE = /^(.*?)\s+\((.*)\)$/;
const LOCATION_RE = /^(.*?):(\d+)(?::(\d+))?$/;
const GECKO_LINE_RE = /^\s*(.*?)@(.*?)\s*$/;

/** "file:line:col" (or a bare non-path marker) → location parts. */
function jsLocation(raw: string): { filename: string | null; lineno: number | null; colno: number | null } {
	let location = raw.trim();
	// eval frames: "eval at fn (file:1:2), <anonymous>:3:4" — use the
	// evaluating script's position.
	if (location.startsWith("eval at ")) {
		const inner = /\(([^()]+?):(\d+):(\d+)\)/.exec(location);
		if (inner) return { filename: inner[1]!, lineno: toInt(inner[2]), colno: toInt(inner[3]) };
	}
	if (/^(?:native|<anonymous>|\[native code\]|index \d+|unknown location)$/i.test(location)) {
		return { filename: null, lineno: null, colno: null };
	}
	const m = LOCATION_RE.exec(location);
	if (m && m[1]) return { filename: m[1], lineno: toInt(m[2]), colno: toInt(m[3]) };
	location = location.replace(/^address at /, "");
	return { filename: location || null, lineno: null, colno: null };
}

function parseV8(lines: string[]): StackFrame[] {
	const frames: StackFrame[] = [];
	for (const line of lines) {
		const m = V8_LINE_RE.exec(line);
		if (!m) continue;
		const body = m[1]!.trim();
		const withFn = V8_WITH_FN_RE.exec(body);
		if (withFn) {
			frames.push(frame("javascript", { function: withFn[1], ...jsLocation(withFn[2]!) }));
		} else {
			// "at async file:1:2" is an anonymous async function: the location
			// is what follows "async " (the platform parser mirrors this).
			frames.push(frame("javascript", jsLocation(body.replace(/^async /, ""))));
		}
		if (frames.length >= MAX_FRAMES) break;
	}
	return frames;
}

/** A Firefox/Safari location: something with :line(:col), or [native code]. */
function isGeckoLocation(location: string): boolean {
	return /:\d+(?::\d+)?$/.test(location) || location === "[native code]";
}

function parseGecko(lines: string[]): StackFrame[] {
	const frames: StackFrame[] = [];
	for (const line of lines) {
		const m = GECKO_LINE_RE.exec(line);
		if (!m || !isGeckoLocation(m[2]!)) continue;
		// Firefox eval frames: "fn@url line 2 > eval:1:5" — keep the script.
		const location = m[2]!.replace(/ line (\d+) > (?:eval|Function)(?::\d+:\d+)?$/, ":$1");
		frames.push(frame("javascript", { function: m[1] || null, ...jsLocation(location) }));
		if (frames.length >= MAX_FRAMES) break;
	}
	return frames;
}

// ── Python ────────────────────────────────────────────────────────────────

const PY_FILE_RE = /^\s*File "(.+)", line (\d+)(?:, in (.+?))?\s*$/;
const PY_TRACEBACK_RE = /^\s*Traceback \(most recent call last\):\s*$/;
// 3.11+: an exception group prints its own frames behind a "| " margin,
// under this header (nested groups' headers carry the margin instead of "+"),
// then its sub-exceptions after a "+-+---- 1 ----" separator.
const PY_GROUP_TRACEBACK_RE = /^\s*\+ Exception Group Traceback \(most recent call last\):\s*$/;
const PY_GROUP_MARGIN_RE = /^\s*\|/;
const PY_GROUP_SUBEXCEPTIONS_RE = /^\s*\+-/;

function isPythonFrameLine(line: string): boolean {
	return PY_FILE_RE.test(line) || PY_FILE_RE.test(line.replace(PY_GROUP_MARGIN_RE, ""));
}

function parsePython(lines: string[]): StackFrame[] {
	// A chained exception prints one block per exception, the reported
	// (final) one last, whether the chain says "During handling of the above
	// exception" or "The above exception was the direct cause". Blocks of
	// sub-exceptions and of groups in the chain carry a margin, so the last
	// unmargined header starts the reported exception's own frames.
	let start = -1;
	let group = false;
	for (let i = 0; i < lines.length; i++) {
		if (PY_TRACEBACK_RE.test(lines[i]!)) {
			start = i;
			group = false;
		} else if (PY_GROUP_TRACEBACK_RE.test(lines[i]!)) {
			start = i;
			group = true;
		}
	}
	const outermostFirst: StackFrame[] = [];
	for (const raw of lines.slice(start + 1)) {
		let line = raw;
		if (group) {
			if (PY_GROUP_SUBEXCEPTIONS_RE.test(line)) break;
			line = line.replace(PY_GROUP_MARGIN_RE, "");
		}
		const m = PY_FILE_RE.exec(line);
		if (!m) continue;
		outermostFirst.push(frame("python", { function: m[3] ?? null, filename: m[1], lineno: toInt(m[2]) }));
	}
	return outermostFirst.reverse().slice(0, MAX_FRAMES);
}

// ── Go ────────────────────────────────────────────────────────────────────

const GO_LOCATION_RE = /^\s*(.+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/;
const GO_GOROUTINE_RE = /\bgoroutine \d+ \[/;

/** "net/http.(*conn).serve" → module "net/http", function "(*conn).serve". */
function splitGoName(qualified: string): { module: string | null; function: string } {
	const slash = qualified.lastIndexOf("/", qualified.indexOf("(") === -1 ? qualified.length : qualified.indexOf("("));
	const dot = qualified.indexOf(".", slash + 1);
	if (dot <= 0) return { module: null, function: qualified };
	return { module: qualified.slice(0, dot), function: qualified.slice(dot + 1) };
}

function parseGo(lines: string[]): StackFrame[] {
	const frames: StackFrame[] = [];
	let fn = "";
	let goroutines = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (GO_GOROUTINE_RE.test(trimmed)) {
			// Only the first goroutine is the one that failed.
			if (++goroutines > 1 && frames.length > 0) break;
			fn = "";
			continue;
		}
		const loc = GO_LOCATION_RE.exec(line);
		if (loc && fn) {
			const name = stripTrailingArgs(fn.replace(/^created by\s+/, "").replace(/\s+in goroutine \d+\s*$/, ""));
			const { module, function: func } = splitGoName(name);
			frames.push(frame("go", { function: func, module, filename: loc[1]!.trim(), lineno: toInt(loc[2]) }));
			if (frames.length >= MAX_FRAMES) break;
			fn = "";
			continue;
		}
		if (trimmed && !loc) fn = trimmed;
	}
	return frames;
}

// ── JVM ───────────────────────────────────────────────────────────────────

function parseJvm(lines: string[]): StackFrame[] {
	const frames: StackFrame[] = [];
	for (const line of lines) {
		// The reported exception's frames come first; causes follow.
		if (/^\s*(?:Caused by|Suppressed):/.test(line) && frames.length > 0) break;
		const m = /^\s*at\s+(.+?)\((.*)\)\s*$/.exec(line);
		if (!m) continue;
		// "java.base/java.lang.Thread.run", "app//com.example.Foo.bar"
		const qualified = m[1]!.trim().replace(/^.*\//, "");
		const [module, method] = splitLastDot(qualified);
		const location = m[2]!.trim();
		let filename: string | null = null;
		let lineno: number | null = null;
		if (!/^(?:Native Method|Unknown Source)$/.test(location)) {
			const loc = /^(.*?)(?::(\d+))?$/.exec(location)!;
			filename = loc[1] || null;
			lineno = toInt(loc[2]);
		}
		frames.push(frame("jvm", { function: method, module, filename, lineno }));
		if (frames.length >= MAX_FRAMES) break;
	}
	return frames;
}

// ── .NET ──────────────────────────────────────────────────────────────────

function parseDotnet(lines: string[]): StackFrame[] {
	let frames: StackFrame[] = [];
	for (const line of lines) {
		// "Outer ---> Inner\n at inner…\n --- End of inner exception stack
		// trace ---\n at outer…": the reported (outer) frames come last.
		if (/---\s*End of inner exception stack trace\s*---/i.test(line)) {
			frames = [];
			continue;
		}
		const m = /^\s*at\s+(.+?)(?:\s+in\s+(.+?):line\s+(\d+))?\s*$/.exec(line);
		if (!m) continue;
		const [module, method] = splitLastDot(stripTrailingArgs(m[1]!));
		frames.push(frame("dotnet", { function: method, module, filename: m[2] ?? null, lineno: toInt(m[3]) }));
	}
	return frames.slice(0, MAX_FRAMES);
}

// ── Rust ──────────────────────────────────────────────────────────────────

function parseRust(lines: string[]): StackFrame[] {
	const frames: StackFrame[] = [];
	for (let i = 0; i < lines.length && frames.length < MAX_FRAMES; i++) {
		const m = /^\s*\d+:\s+(?:0x[0-9a-f]+\s+-\s+)?(.+?)\s*$/.exec(lines[i]!);
		if (!m) continue;
		const fn = m[1]!.replace(/::h[0-9a-f]{6,}$/, "").trim();
		if (!fn) continue;
		const at = /^\s*at\s+(.+?):(\d+)(?::(\d+))?\s*$/.exec(lines[i + 1] ?? "");
		if (at) i++;
		frames.push(frame("rust", {
			function: fn,
			filename: at?.[1] ?? null,
			lineno: toInt(at?.[2]),
			colno: toInt(at?.[3]),
		}));
	}
	return frames;
}

// ── Ruby / PHP (best effort) ──────────────────────────────────────────────

// A .NET frame without source locations: "at Ns.Type.Method(Type arg)".
// V8 always puts a space before "(" or has no parentheses at all.
const DOTNET_BARE_RE = /^\s*at\s+[\w.`<>\[\],+|]+\([\w.`<>\[\],&*\s]*\)\s*$/;
const RUBY_RE = /^\s*(?:from\s+)?(.+?):(\d+)(?::in\s+[`'](?:[\w:#.]+[#.])?(.+?)')?\s*$/;
const PHP_RE = /^\s*#\d+\s+(.+?)\((\d+)\):\s+(.+?)\s*$/;

function parseRuby(lines: string[]): StackFrame[] {
	const frames: StackFrame[] = [];
	for (const line of lines) {
		const m = RUBY_RE.exec(line);
		if (!m || !/\.(?:rb|erb|rake)$/.test(m[1]!)) continue;
		frames.push(frame("ruby", { function: m[3] ?? null, filename: m[1], lineno: toInt(m[2]) }));
		if (frames.length >= MAX_FRAMES) break;
	}
	return frames;
}

function parsePhp(lines: string[]): StackFrame[] {
	const frames: StackFrame[] = [];
	for (const line of lines) {
		const m = PHP_RE.exec(line);
		if (!m) continue;
		frames.push(frame("php", { function: stripTrailingArgs(m[3]!), filename: m[1], lineno: toInt(m[2]) }));
		if (frames.length >= MAX_FRAMES) break;
	}
	return frames;
}

// ── Entry point ───────────────────────────────────────────────────────────

/** The language of a raw stack, or null when it has no recognisable frames. */
export function detectFrameLanguage(lines: string[]): FrameLanguage | null {
	switch (detectStackLanguage(lines)) {
		case "go":
			return "go";
		case "rust":
			return "rust";
		case "jvm":
			return "jvm";
		case "dotnet":
			return "dotnet";
		default:
	}
	if (lines.some(isPythonFrameLine)) return "python";
	if (
		lines.some((line) => DOTNET_BARE_RE.test(line)) &&
		!lines.some((line) => /:\d+(?::\d+)?\)?\s*$/.test(line))
	) {
		return "dotnet";
	}
	if (lines.some((line) => V8_LINE_RE.test(line))) return "javascript";
	if (lines.some((line) => {
		const m = GECKO_LINE_RE.exec(line);
		return Boolean(m && isGeckoLocation(m[2]!));
	})) return "javascript";
	if (lines.some((line) => PHP_RE.test(line))) return "php";
	if (lines.some((line) => {
		const m = RUBY_RE.exec(line);
		return Boolean(m && /\.(?:rb|erb|rake)$/.test(m[1]!));
	})) return "ruby";
	return null;
}

/** Parse a raw stack into frames, innermost first (≤ MAX_FRAMES). */
export function parseStackFrames(stack: string | null | undefined): StackFrame[] {
	if (!stack) return [];
	const lines = stack.split(/\r?\n/);
	switch (detectFrameLanguage(lines)) {
		case "go":
			return parseGo(lines);
		case "rust":
			return parseRust(lines);
		case "jvm":
			return parseJvm(lines);
		case "dotnet":
			return parseDotnet(lines);
		case "python":
			return parsePython(lines);
		case "javascript":
			return lines.some((line) => V8_LINE_RE.test(line)) ? parseV8(lines) : parseGecko(lines);
		case "php":
			return parsePhp(lines);
		case "ruby":
			return parseRuby(lines);
		default:
			return [];
	}
}
