import { execFileSync } from "node:child_process";
// One list of commit variables for the SDK and this CLI: the file is
// dependency-free and bundled into the CLI at build time (tsup), so the
// published package gains no dependency. Maps uploaded under the default
// release then match the release @autter/runtime-node reports by default.
import { COMMIT_ENV_VARS, detectCommitFrom } from "../../runtime-node/src/deployment.js";

/** What the ingester accepts as a release. */
export const RELEASE_RE = /^[a-zA-Z0-9._-]{1,200}$/;

/**
 * Variables that carry the commit being built, in the order they are tried
 * (after AUTTER_RELEASE): the same list, in the same order, as
 * @autter/runtime-node. Only a 7-40 character hexadecimal value counts as a
 * commit; a variable set to anything else is skipped.
 */
export const RELEASE_ENV_VARS = COMMIT_ENV_VARS;

export interface ResolvedRelease {
	release: string;
	/** Where it came from: "--release", "AUTTER_RELEASE", a commit variable's name, or "git". */
	source: string;
}

/** The commit at `cwd`, or null outside a git checkout / without git. */
export function gitHead(cwd: string = process.cwd()): string | null {
	try {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		}).trim();
		return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}

function checked(release: string, source: string): ResolvedRelease {
	if (!RELEASE_RE.test(release)) {
		throw new Error(
			`release "${release}" (from ${source}) is not valid: use 1-200 letters, digits, ".", "_" or "-" (a commit SHA works)`,
		);
	}
	return { release, source };
}

/**
 * The release to upload under, resolved like @autter/runtime-node's default
 * release so the two agree: the explicit value, else AUTTER_RELEASE, else the
 * first commit variable holding a commit (RELEASE_ENV_VARS: AUTTER_COMMIT,
 * GIT_SHA, ..., GITHUB_SHA, ...), else `git rev-parse HEAD` (build time only;
 * the SDK never runs git). Throws with a usable message when none is
 * available or the value has characters the ingester rejects.
 */
export function resolveRelease(
	explicit?: string | null,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): ResolvedRelease {
	const flag = explicit?.trim();
	if (flag) return checked(flag, "--release");
	const named = env.AUTTER_RELEASE?.trim();
	if (named) return checked(named, "AUTTER_RELEASE");
	const detected = detectCommitFrom(env);
	if (detected) return { release: detected.commit, source: detected.source };
	const head = gitHead(cwd);
	if (head) return { release: head, source: "git" };
	throw new Error(
		`no release: pass --release <release>, or set AUTTER_RELEASE or one of ${RELEASE_ENV_VARS.join(", ")} to the commit, or run inside a git checkout`,
	);
}
