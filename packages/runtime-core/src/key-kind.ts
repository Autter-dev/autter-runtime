/**
 * Which of the four Autter key types a string is, and what to say when it is
 * the wrong one. Pure string work: runs on every runtime.
 *
 * COPIED (not imported) into packages/otlp-ingester/src/key-kind.ts, because
 * the ingester's Dockerfile builds from that one package. Both are checked
 * against test-vectors/key-kinds.json; change them together.
 *
 *   autter_pat_  personal access token  (CLI, MCP)
 *   autter_rt_   runtime server key     (backend telemetry)
 *   autter_rtc_  runtime client key     (browser errors, publishable)
 *   autter_rtu_  source map upload key  (CI)
 */
export type KeyKind = "pat" | "server" | "client" | "upload" | "unknown";
export type KeyProblem = "quoted" | "bearer" | "assignment" | "masked" | "whitespace";
export type KnownKeyKind = Exclude<KeyKind, "unknown">;

export interface KeyClassification {
	kind: KeyKind;
	/** The key with quotes, "Bearer ", "NAME=" and outer whitespace removed. */
	key: string;
	/** The first thing that was wrong with the raw value, if anything. */
	problem?: KeyProblem;
}

/** Longest prefix first: `autter_rt_` is not a prefix of `autter_rtc_`, but keep the order explicit. */
const PREFIXES: ReadonlyArray<readonly [string, KnownKeyKind]> = [
	["autter_rtc_", "client"],
	["autter_rtu_", "upload"],
	["autter_rt_", "server"],
	["autter_pat_", "pat"],
];

export function keyKindOfPrefix(key: string): KeyKind {
	for (const [prefix, kind] of PREFIXES) if (key.startsWith(prefix)) return kind;
	return "unknown";
}

const QUOTES = new Set(['"', "'", "`"]);
const MASK_RE = /…|\.\.\.|\*|•/;

export function classifyKey(raw: string): KeyClassification {
	let key = String(raw ?? "").trim();
	let bearer = false;
	let assignment = false;
	let quoted = false;
	if (/^bearer\s+/i.test(key)) {
		key = key.replace(/^bearer\s+/i, "").trim();
		bearer = true;
	}
	const named = /^[A-Z][A-Z0-9_]*=/.exec(key);
	if (named) {
		key = key.slice(named[0].length);
		assignment = true;
	}
	if (key.length >= 2 && QUOTES.has(key[0]!) && key[key.length - 1] === key[0]) {
		key = key.slice(1, -1);
		quoted = true;
	}
	key = key.trim();
	const kind = keyKindOfPrefix(key);
	let problem: KeyProblem | undefined;
	if (quoted) problem = "quoted";
	else if (bearer) problem = "bearer";
	else if (assignment) problem = "assignment";
	else if (MASK_RE.test(key)) problem = "masked";
	else if (/\s/.test(key)) problem = "whitespace";
	return problem ? { kind, key, problem } : { kind, key };
}

/** prefix + … + last 4, at most: never enough to use the key. */
export function maskKey(key: string): string {
	const k = key.trim();
	for (const [prefix] of PREFIXES) {
		if (k.startsWith(prefix)) return `${prefix}…${k.length > prefix.length + 4 ? k.slice(-4) : ""}`;
	}
	return "(unrecognised key)";
}

const GOT: Record<KnownKeyKind, string> = {
	pat: "This is a personal access token (autter_pat_…), for signing in the Autter CLI and MCP.",
	server: "This is a runtime server key (autter_rt_…), for backend telemetry.",
	client: "This is a runtime client key (autter_rtc_…), for browser errors.",
	upload: "This is a source map upload key (autter_rtu_…), for CI source map uploads.",
};

const USE: Record<KnownKeyKind, string> = {
	pat: "To sign in the CLI, use a personal access token (autter_pat_…) with `autter login --token <token>`, or run `autter login` to sign in in the browser.",
	server: "Backend telemetry needs a runtime server key (autter_rt_…) in AUTTER_RUNTIME_KEY.",
	client: "Browser errors need a runtime client key (autter_rtc_…) in initAutterBrowser({ clientKey }).",
	upload:
		"Source map uploads need a source map upload key (autter_rtu_…) as the AUTTER_RUNTIME_KEY CI secret (a runtime server key also works).",
};

export const KEY_WHERE = "Create one in the Autter dashboard at Settings > Keys and tokens.";

/** A server key where a client key was expected. */
export const SERVER_KEY_IS_SECRET = "A server key is secret: never put it in browser code, and rotate this one.";
/** A personal access token that has been in a URL. */
export const PAT_IN_URL = "This token has been in a URL, which proxies log: revoke it.";

const PROBLEM: Record<KeyProblem, string> = {
	quoted: "The key is wrapped in quotes. Remove them: env files and CI secrets keep quotes as part of the value.",
	bearer: 'The key starts with "Bearer ". Set only the key; the SDK adds the Bearer prefix.',
	assignment: "The value includes a variable name (NAME=). Set only the key.",
	masked:
		"This is the shortened key shown in the dashboard list, not the key. A key is shown in full only once, when it is created: create a new one at Settings > Keys and tokens.",
	whitespace: "The key contains spaces or line breaks. Copy it again as one line.",
};

/** "got" sentence + "use" sentence + "where" sentence. */
export function wrongKeyMessage(expected: KnownKeyKind, got: KeyKind): string {
	const parts: string[] = [];
	if (got !== "unknown") parts.push(GOT[got]);
	parts.push(USE[expected], KEY_WHERE);
	return parts.join(" ");
}

export function keyProblemMessage(problem: KeyProblem): string {
	return PROBLEM[problem];
}
