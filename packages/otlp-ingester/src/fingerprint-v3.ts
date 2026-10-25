import { createHash } from "node:crypto";
import { causeTexts } from "./cause-chain.js";
import { normalizeMessage, occurrenceFingerprint } from "./fingerprint.js";
import { manualFingerprint } from "./fingerprint-override.js";
import { parseStackFrames } from "./stack-frames.js";
import type {
	FingerprintCandidate,
	FingerprintRecord,
	RuntimeOccurrenceInput,
	StackFrame,
} from "./types.js";

/**
 * `frames-v3` — the structural issue identity (contract §2). Byte-for-byte
 * shared with the platform mirror (`runtime-frames-fingerprint.ts`); the
 * vectors in fingerprint-v3-vectors.json pin both.
 *
 * It hashes service + error type + up to five in-app frames reduced to
 * `function@file`, where file is a lowercased basename with build hashes
 * (`index-5f3a9c1e.js` → `index-*.js`) templated out. Line and column
 * numbers, route, source (browser vs server) and release are never part of
 * it, so one bug stays one issue across deploys, pages, preview domains and
 * tiers. The normalised message is hashed only when no frame was picked.
 */

export const FRAMES_V3 = "frames-v3";
const MAX_PICKED_FRAMES = 5;

/** §2.3 — the function half of a frame token. */
export function frameTokenFunction(frame: Pick<StackFrame, "function" | "resolved">): string {
	let fn = frame.function ?? "";
	fn = fn.replace(/^async /, "");
	fn = fn.replace(/^new /, "");
	fn = fn.replace(/^(?:Object|Module)\./, "");
	if (frame.resolved === false && fn.length <= 2) fn = "";
	if (fn === "<anonymous>" || fn === "anonymous") fn = "";
	return fn;
}

/** §2.3 — the file half of a frame token. */
export function frameTokenFile(frame: Pick<StackFrame, "filename" | "module">): string {
	let file = frame.filename ?? frame.module ?? "";
	const cut = file.search(/[?#]/);
	if (cut !== -1) file = file.slice(0, cut);
	file = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
	file = file.replace(/[A-Za-z0-9]{8,}/g, (run) =>
		/[0-9]/.test(run) || run === run.toUpperCase() ? "*" : run,
	);
	return file.toLowerCase();
}

export function frameToken(frame: StackFrame): string {
	return `${frameTokenFunction(frame)}@${frameTokenFile(frame)}`;
}

/** §2.1–2.2 — in-app frames in order, else only the first frame; at most 5. */
export function pickFrames(frames: StackFrame[]): StackFrame[] {
	const inApp = frames.filter((frame) => frame.inApp === true);
	const picked = inApp.length > 0 ? inApp : frames.slice(0, 1);
	return picked.slice(0, MAX_PICKED_FRAMES);
}

export interface FramesV3Input {
	service: string;
	errorType: string;
	message: string;
	frames: StackFrame[];
}

export interface FramesV3Result {
	fingerprint: string;
	record: FingerprintRecord;
}

export function framesV3Fingerprint(input: FramesV3Input): FramesV3Result {
	const tokens = pickFrames(input.frames).map(frameToken);
	const message = tokens.length === 0 ? normalizeMessage(input.message) : "";
	const fingerprint = createHash("sha256")
		.update([FRAMES_V3, input.service, input.errorType, tokens.join("\u0001"), message].join("\u0000"))
		.digest("hex")
		.slice(0, 32);
	return {
		fingerprint,
		record: {
			scheme: FRAMES_V3,
			parts: [input.errorType, ...tokens, message].filter((part) => part !== ""),
		},
	};
}

// ── cause-v1: a wrapped error groups with its root cause (RF-06) ──────────

/**
 * `cause-v1` — the root-cause identity (RF-06). Byte-for-byte shared with
 * the platform mirror (`runtime-frames-fingerprint.ts`); the `cause` of the
 * entries in fingerprint-v3-vectors.json pins both.
 *
 * It hashes service + the root cause's error type + ONE frame: the
 * innermost in-app frame across the cause chain, looked for from the root
 * cause outward (the root's own innermost in-app frame when it has one,
 * else its nearest wrapper's, …). So `new Error("checkout failed", { cause:
 * fetchError })` and the unwrapped `TypeError: fetch failed` hash alike, as
 * do JVM `Caused by:` chains, .NET inner exceptions and Python chained
 * exceptions with their root. An error without a cause is its own root, so
 * the raw form carries the same candidate. No in-app frame anywhere in the
 * chain: no candidate.
 *
 * It is a lookup candidate only: frames-v3 stays the identity issues are
 * created under (see occurrenceIdentity), and frames-v3 itself is unchanged,
 * so no existing issue regroups.
 */
export const CAUSE_V1 = "cause-v1";

/** One exception of a chain: its error type and frames, innermost first. */
export interface CauseLink {
	type: string;
	frames: StackFrame[];
}

export interface CauseV1Input {
	service: string;
	/** The reported exception first, then its cause, …, the root cause last. */
	chain: CauseLink[];
}

/**
 * The type half of cause-v1: the last segment of a qualified name, so the
 * same class written `java.lang.IllegalStateException` in a JVM `Caused by:`
 * line and in `exception.type`, or `requests.exceptions.ConnectionError` in a
 * Python traceback and `ConnectionError` in OTel's `exception.type`, match.
 */
export function causeTypeToken(type: string): string {
	const segments = type.trim().split(/::|\./);
	return segments[segments.length - 1] ?? "";
}

export function causeV1Fingerprint(input: CauseV1Input): FramesV3Result | null {
	const root = input.chain[input.chain.length - 1];
	if (!root) return null;
	let token = "";
	for (let i = input.chain.length - 1; i >= 0 && !token; i--) {
		for (const frame of input.chain[i]!.frames) {
			if (frame.inApp !== true) continue;
			const candidate = frameToken(frame);
			// A frame with neither a function nor a file says nothing.
			if (candidate !== "@") {
				token = candidate;
				break;
			}
		}
	}
	if (!token) return null;
	const type = causeTypeToken(root.type);
	const fingerprint = createHash("sha256")
		.update([CAUSE_V1, input.service, type, token].join("\u0000"))
		.digest("hex")
		.slice(0, 32);
	return { fingerprint, record: { scheme: CAUSE_V1, parts: [type, token].filter((part) => part !== "") } };
}

/** The causes of an occurrence with their frames as parsed (not symbolicated). */
export function parsedCauseLinks(input: Pick<RuntimeOccurrenceInput, "stack" | "attributes">): CauseLink[] {
	return causeTexts(input.stack, input.attributes).map((cause) => ({
		type: cause.type,
		frames: parseStackFrames(cause.stack),
	}));
}

export interface OccurrenceIdentity {
	/** Legacy identity, unchanged: what `fingerprint`/`fingerprintScheme` carry. */
	legacy: { fingerprint: string; scheme: "message-v1" | "code-v1" };
	/** Every applicable scheme, in precedence order (see occurrenceIdentity). */
	candidates: FingerprintCandidate[];
	/** What went into the frames-v3 fingerprint, when one was computed. */
	record: FingerprintRecord | null;
	/** What went into the cause-v1 fingerprint, when one was computed. */
	causeRecord: FingerprintRecord | null;
}

/**
 * The candidate list the sink carries (contract §1/§4), in precedence order:
 *   manual-v1 (SDK override) → code-v1 (valid error code) → frames-v3 →
 *   message-v1 (legacy) → cause-v1 (RF-06).
 * A coded error's legacy identity IS code-v1, which outranks every auto
 * scheme, so its list is [manual-v1?, code-v1]; an uncoded one is
 * [manual-v1?, frames-v3, message-v1, cause-v1?].
 *
 * The consumer takes, among the auto schemes, the first one that already
 * has an issue, else creates the issue under the highest. cause-v1 comes
 * after every existing scheme, so an occurrence of an issue that already
 * exists keeps finding it by frames-v3 or message-v1 first and nothing
 * regroups; cause-v1 is only reached when neither has an issue — which, for
 * a wrapped error whose root cause already has an issue, is exactly when it
 * should join that issue. (Issues are still created under frames-v3: the
 * platform must also key new issues by their cause-v1 fingerprint, or merge
 * it as an alias, for that lookup to find anything. Until it does, cause-v1
 * is carried in shadow and changes no grouping.) The legacy fingerprint is
 * still always in the list, so the platform can fall back to it.
 *
 * `causes` are the reported exception's causes with their (symbolicated)
 * frames, nearest first; omitted, they are read from the stack and
 * attributes and parsed without symbolication.
 */
export function occurrenceIdentity(
	input: RuntimeOccurrenceInput,
	frames: StackFrame[],
	causes?: CauseLink[],
): OccurrenceIdentity {
	const legacy = occurrenceFingerprint(input);
	const candidates: FingerprintCandidate[] = [];
	const manual = manualFingerprint(input);
	if (manual) candidates.push({ scheme: "manual-v1", fingerprint: manual });
	let record: FingerprintRecord | null = null;
	let causeRecord: FingerprintRecord | null = null;
	if (legacy.scheme === "code-v1") {
		candidates.push({ scheme: "code-v1", fingerprint: legacy.fingerprint });
	} else {
		const v3 = framesV3Fingerprint({
			service: input.service,
			errorType: input.errorType,
			message: input.message,
			frames,
		});
		record = v3.record;
		candidates.push({ scheme: FRAMES_V3, fingerprint: v3.fingerprint });
		candidates.push({ scheme: "message-v1", fingerprint: legacy.fingerprint });
		const cause = causeV1Fingerprint({
			service: input.service,
			chain: [{ type: input.errorType, frames }, ...(causes ?? parsedCauseLinks(input))],
		});
		if (cause) {
			causeRecord = cause.record;
			candidates.push({ scheme: CAUSE_V1, fingerprint: cause.fingerprint });
		}
	}
	return { legacy, candidates, record, causeRecord };
}
