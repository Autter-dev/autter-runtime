import { createHash } from "node:crypto";
import type { RuntimeOccurrenceInput } from "./types.js";

/**
 * Deterministic error grouping. Two occurrences share an issue when they
 * share source + service + error type + normalised message + top stack
 * frames + normalised route. Volatile fragments (ids, numbers, minified
 * line/column offsets) are stripped so re-deploys and per-user values don't
 * fragment issues. This algorithm must stay in sync with the Autter backend
 * so browser-relay and OTLP occurrences group identically.
 */

const UUID_RE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_RE = /\b[0-9a-f]{8,}\b/gi;
// No trailing \b: numbers glued to units ("4200ms", "3.5s", "512kb") must
// template too, or per-value messages fragment into separate fingerprints.
const NUMBER_RE = /\b\d+(\.\d+)?/g;
const QUOTED_RE = /(["'`])(?:\\.|(?!\1).)*\1/g;
// `\b` never fires between `_` and a digit (both are word chars), so
// underscore-glued ids — "prj_1013", "user_42", "order_9f3ac2d144" — escape
// NUMBER_RE/LONG_HEX_RE entirely and fragment one defect into an issue per
// id. Template the value after the underscore explicitly. (Letter-glued
// digits like "sha256"/"utf8" stay literal on purpose — those are usually
// meaningful tokens, not per-entity ids.)
const UNDERSCORE_HEX_RE = /_[0-9a-f]{8,}\b/gi;
const UNDERSCORE_NUMBER_RE = /_\d+(\.\d+)?\b/g;

export function normalizeMessage(message: string): string {
	return message
		.slice(0, 500)
		.replace(QUOTED_RE, "<str>")
		.replace(UUID_RE, "<uuid>")
		.replace(LONG_HEX_RE, "<hex>")
		.replace(UNDERSCORE_HEX_RE, "_<hex>")
		.replace(UNDERSCORE_NUMBER_RE, "_<n>")
		.replace(NUMBER_RE, "<n>")
		.replace(/\s+/g, " ")
		.trim();
}

/** Replace id-like path segments so /orders/812 and /orders/44 group. */
export function normalizeRoute(route: string | null): string {
	if (!route) return "";
	const path = route.split("?")[0] ?? "";
	return path
		.split("/")
		.map((segment) => {
			if (!segment) return segment;
			if (
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
					segment,
				)
			)
				return ":id";
			if (/^\d+$/.test(segment)) return ":id";
			if (/^[0-9a-f]{8,}$/i.test(segment)) return ":id";
			return segment;
		})
		.join("/");
}

const FRAME_LOCATION_RE = /:\d+(:\d+)?\)?$/;

/**
 * Backend exceptions reach us in many native stack formats. The fingerprint
 * groups by the top stack frames, so a format we cannot parse yields an EMPTY
 * frame list — and then every error sharing a message collapses into one
 * issue (two unrelated Go panics, say, become a single group). To keep
 * unrelated defects apart, each officially-supported language is parsed and
 * every frame reduced to a stable `function (file)` token that preserves the
 * function, module and file.
 *
 * Volatile parts are stripped: line/column numbers, `+0x` offsets, pointer
 * arguments and memory addresses. Line numbers are parsed but deliberately
 * left OUT of the token — they shift on every re-deploy, and the JS path has
 * always dropped them for exactly this reason, so the same defect stays one
 * issue across rebuilds. The raw stack is retained verbatim on its own column.
 *
 * JavaScript/TypeScript, Firefox `@` frames and Python `File` frames keep
 * their historical normalisation byte-for-byte (parseScriptFrames) so existing
 * issues never regroup.
 */
type StackLanguage = "go" | "rust" | "jvm" | "dotnet" | "script";

// A Go location line: "\t<file>.go:<line> +0x<off>" (offset optional).
const GO_LOCATION_RE = /^\s*(.+\.go):\d+(?:\s+\+0x[0-9a-f]+)?\s*$/;
const GO_GOROUTINE_RE = /\bgoroutine \d+ \[/;
// A .NET frame with a source location: "at <method>(...) in <file>:line <n>".
const DOTNET_FRAME_RE = /^\s*at\s+.+\)\s+in\s+.+:line\s+\d+\s*$/i;
const DOTNET_CS_RE = /\.cs:line\s+\d+/i;
// A JVM frame: "at <fqmethod>(<File>.java:<line>)" / "(Native Method)".
const JVM_FRAME_RE =
	/^\s*at\s+[\w$.]+(?:\/[\w$.]+)?\(.*\.(?:java|kt|scala|groovy):\d+\)\s*$/;
const JVM_NATIVE_RE = /\((?:Native Method|Unknown Source)\)\s*$/;
// A Rust backtrace frame ("   3: my::mod::func") or its "at <file>.rs:<n>" line.
const RUST_FRAME_RE = /^\s*\d+:\s+(?:0x[0-9a-f]+\s+-\s+)?\S+::\S/;
const RUST_AT_RS_RE = /^\s*at\s+\S+\.rs:\d+/;

/**
 * Classify a whole stack by language. Signatures are chosen to be unique to
 * each runtime so a JS or Python stack always falls through to "script".
 */
function detectStackLanguage(lines: string[]): StackLanguage {
	let hasDotnet = false;
	let hasJvm = false;
	let hasRust = false;
	for (const line of lines) {
		if (GO_LOCATION_RE.test(line) || GO_GOROUTINE_RE.test(line)) return "go";
		if (DOTNET_FRAME_RE.test(line) || DOTNET_CS_RE.test(line)) hasDotnet = true;
		if (JVM_FRAME_RE.test(line) || JVM_NATIVE_RE.test(line)) hasJvm = true;
		if (
			RUST_FRAME_RE.test(line) ||
			RUST_AT_RS_RE.test(line) ||
			line.trim() === "stack backtrace:"
		)
			hasRust = true;
	}
	// .NET and JVM frames both start with "at"; decide by the location marker
	// each detector matched (`.cs`/`:line` vs `.java`/Native Method).
	if (hasDotnet) return "dotnet";
	if (hasJvm) return "jvm";
	if (hasRust) return "rust";
	return "script";
}

/** Drop the trailing call-argument group, e.g. "f(0x1, 0x2)" → "f". */
function stripTrailingArgs(fn: string): string {
	return fn.replace(/\([^()]*\)\s*$/, "").trim();
}

function cleanGoFunc(fn: string): string {
	return stripTrailingArgs(
		fn.replace(/^created by\s+/, "").replace(/\s+in goroutine \d+\s*$/, ""),
	);
}

/** Go: a function line followed by a "\t<file>.go:<line> +0x<off>" location. */
function parseGoFrames(lines: string[], topN: number): string[] {
	const frames: string[] = [];
	let prevFunc = "";
	for (const line of lines) {
		const loc = GO_LOCATION_RE.exec(line);
		if (loc && prevFunc) {
			frames.push(`${cleanGoFunc(prevFunc)} (${loc[1].trim()})`);
			if (frames.length >= topN) break;
			prevFunc = "";
			continue;
		}
		const trimmed = line.trim();
		if (trimmed && !GO_GOROUTINE_RE.test(trimmed)) prevFunc = trimmed;
	}
	return frames;
}

/** Rust: "   N: module::func" optionally followed by "  at <file>:<line>:<col>". */
function parseRustFrames(lines: string[], topN: number): string[] {
	const frames: string[] = [];
	for (let i = 0; i < lines.length && frames.length < topN; i++) {
		const m = /^\s*\d+:\s+(?:0x[0-9a-f]+\s+-\s+)?(.+?)\s*$/.exec(lines[i]!);
		if (!m) continue;
		const fn = m[1]!.replace(/::h[0-9a-f]{6,}$/, "").trim();
		if (!fn) continue;
		const at = /^\s*at\s+(\S+?):\d+(?::\d+)?\s*$/.exec(lines[i + 1] ?? "");
		if (at) i++;
		frames.push(at ? `${fn} (${at[1]})` : fn);
	}
	return frames;
}

/** JVM (Java/Kotlin/Scala): "\tat <fqmethod>(<File>:<line>)". */
function parseJvmFrames(lines: string[], topN: number): string[] {
	const frames: string[] = [];
	for (const line of lines) {
		const m = /^\s*at\s+(.+?)\((.*)\)\s*$/.exec(line);
		if (!m) continue;
		frames.push(`${m[1]!.trim()}(${m[2]!.trim().replace(/:\d+$/, "")})`);
		if (frames.length >= topN) break;
	}
	return frames;
}

/** .NET: "   at <method>(<params>) in <file>:line <n>" (location optional). */
function parseDotnetFrames(lines: string[], topN: number): string[] {
	const frames: string[] = [];
	for (const line of lines) {
		const m = /^\s*at\s+(.+?)(?:\s+in\s+(.+?):line\s+\d+)?\s*$/.exec(line);
		if (!m) continue;
		const method = stripTrailingArgs(m[1]!);
		const file = m[2]?.trim() ?? "";
		frames.push(file ? `${method} (${file})` : method);
		if (frames.length >= topN) break;
	}
	return frames;
}

/**
 * Historical JS/TS/Firefox/Python normalisation — output is intentionally
 * unchanged so pre-existing issues in those runtimes keep their fingerprints.
 */
function parseScriptFrames(lines: string[], topN: number): string[] {
	return lines
		.map((line) => line.trim())
		.filter((line) => /^at\s|@|^\s*File\s/.test(line) || /\.[jt]sx?/.test(line))
		.slice(0, topN)
		.map((line) =>
			line
				.replace(/\?[^:\s)]*/g, "")
				.replace(FRAME_LOCATION_RE, "")
				.replace(/\s+/g, " ")
				.trim(),
		);
}

/**
 * Safe fallback for a non-empty stack we could not parse into frames (an
 * unsupported runtime, or a malformed one). Rather than discard everything —
 * which collapses every same-message error into one issue — derive a stable
 * signature from any structurally frame-like lines, with volatile tokens
 * (addresses, offsets, line/column numbers) templated out so the SAME defect
 * still groups across occurrences. When there is no frame-like structure at
 * all we return nothing, exactly as before, and grouping falls back to the
 * message + service + error type.
 */
function fallbackFrames(lines: string[], topN: number): string[] {
	const framey = lines
		.map((line) => line.trim())
		.filter(
			(line) =>
				/(?:[/\\]|\.\w+)\S*[:(]\d+/.test(line) ||
				/\b0x[0-9a-f]+/i.test(line) ||
				/^(?:at|from)\b/.test(line) ||
				/^\d+:\s/.test(line),
		);
	if (framey.length === 0) return [];
	return framey
		.map((line) =>
			line
				.replace(/0x[0-9a-f]+/gi, "0x")
				.replace(/:\d+(:\d+)?\b/g, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter(Boolean)
		.slice(0, topN);
}

export function normalizeStackFrames(
	stack: string | null,
	topN = 5,
): string[] {
	if (!stack) return [];
	const lines = stack.split("\n");
	let frames: string[];
	switch (detectStackLanguage(lines)) {
		case "go":
			frames = parseGoFrames(lines, topN);
			break;
		case "rust":
			frames = parseRustFrames(lines, topN);
			break;
		case "jvm":
			frames = parseJvmFrames(lines, topN);
			break;
		case "dotnet":
			frames = parseDotnetFrames(lines, topN);
			break;
		default:
			frames = parseScriptFrames(lines, topN);
	}
	return frames.length > 0 ? frames : fallbackFrames(lines, topN);
}

export function fingerprintOccurrence(input: RuntimeOccurrenceInput): string {
	const parts = [
		input.source,
		input.service,
		input.errorType,
		normalizeMessage(input.message),
		...normalizeStackFrames(input.stack),
		normalizeRoute(input.route),
	];
	return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
}

/**
 * Deterministic per-occurrence identity (as opposed to the fingerprint,
 * which is the per-ISSUE identity shared by every occurrence of a defect).
 *
 * The id must be a pure function of the signal, not a fresh UUID per
 * request: OTLP exporters retry whole batches (after a 503 from a partial
 * ClickHouse write, or when only the 2xx was lost), and both the ClickHouse
 * rows and the sink consumer's dedupe ledger key on this id — random ids
 * would turn every transport retry into a duplicate error downstream.
 *
 * Identical signals within one batch stay distinct through their batch
 * position, which is stable across retries because exporters re-send the
 * same serialized batch. Residual coalescing risk: two occurrences from
 * DIFFERENT requests that share the same millisecond, message, and batch
 * position while carrying neither a traceId nor a sessionId — accepted, as
 * server signals virtually always carry a traceId and browser signals a
 * sessionId.
 */
export function occurrenceIdFor(
	scope: { orgId: string; repositoryId: string },
	input: RuntimeOccurrenceInput,
	fingerprint: string,
	batchIndex: number,
): string {
	const parts = [
		"v1",
		scope.orgId,
		scope.repositoryId,
		fingerprint,
		String(input.occurredAt.getTime()),
		input.traceId ?? "",
		input.sessionId ?? "",
		input.message.slice(0, 1000),
		String(batchIndex),
	];
	// NUL-joined so a free-text field can never bleed into its neighbour.
	return createHash("sha256")
		.update(parts.join("\u0000"))
		.digest("hex")
		.slice(0, 32);
}

/**
 * Derived, aggregation-ready fields, computed from the SAME normalisers the
 * fingerprint hashes — so a stored fingerprint can always be explained by
 * the stored columns next to it. Severity is deliberately excluded from
 * the fingerprint (a warning that escalates to an error stays one group).
 */
export interface DerivedFields {
	routeNormalized: string;
	messageNormalized: string;
	topFrames: string[];
	firstFrame: string;
}

export function deriveFields(input: RuntimeOccurrenceInput): DerivedFields {
	const topFrames = normalizeStackFrames(input.stack);
	return {
		routeNormalized: normalizeRoute(input.route),
		messageNormalized: normalizeMessage(input.message),
		topFrames,
		firstFrame: topFrames[0] ?? "",
	};
}
