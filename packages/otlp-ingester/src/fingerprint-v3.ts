import { createHash } from "node:crypto";
import { normalizeMessage, occurrenceFingerprint } from "./fingerprint.js";
import { manualFingerprint } from "./fingerprint-override.js";
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

export interface OccurrenceIdentity {
	/** Legacy identity, unchanged: what `fingerprint`/`fingerprintScheme` carry. */
	legacy: { fingerprint: string; scheme: "message-v1" | "code-v1" };
	/** Every applicable scheme, highest precedence first; ends with the legacy one. */
	candidates: FingerprintCandidate[];
	/** What went into the frames-v3 fingerprint, when one was computed. */
	record: FingerprintRecord | null;
}

/**
 * The candidate list the sink carries (contract §1/§4), highest precedence
 * first:
 *   manual-v1 (SDK override) → code-v1 (valid error code) → frames-v3 →
 *   message-v1 (legacy).
 * A coded error's legacy identity IS code-v1, which outranks every auto
 * scheme, so its list is [manual-v1?, code-v1]; an uncoded one is
 * [manual-v1?, frames-v3, message-v1]. Either way the list ends with the
 * legacy fingerprint, so the platform can always fall back to it.
 */
export function occurrenceIdentity(
	input: RuntimeOccurrenceInput,
	frames: StackFrame[],
): OccurrenceIdentity {
	const legacy = occurrenceFingerprint(input);
	const candidates: FingerprintCandidate[] = [];
	const manual = manualFingerprint(input);
	if (manual) candidates.push({ scheme: "manual-v1", fingerprint: manual });
	let record: FingerprintRecord | null = null;
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
	}
	return { legacy, candidates, record };
}
