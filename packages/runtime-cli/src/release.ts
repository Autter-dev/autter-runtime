import { execFileSync } from "node:child_process";
// The commit variables are shared with the SDK: the file is dependency-free
// and bundled into the CLI at build time (tsup), so the published package
// gains no dependency.
import { COMMIT_ENV_VARS, COMMIT_RE, LEGACY_RELEASE_ENV_VARS } from "../../runtime-node/src/deployment.js";

/** What the ingester accepts as a release. */
export const RELEASE_RE = /^[a-zA-Z0-9._-]{1,200}$/;

/**
 * CI variables the release is named after, any value, in the order they are
 * tried (after --release and AUTTER_RELEASE): unchanged, so existing builds
 * keep uploading under the release their bundles report (the browser
 * snippets `autter-runtime setup` prints read GITHUB_SHA first too).
 */
export const RELEASE_ENV_VARS = LEGACY_RELEASE_ENV_VARS;

/**
 * The rest of @autter/runtime-node's commit variables, tried after
 * RELEASE_ENV_VARS: only a 7-40 character hexadecimal value counts.
 */
const OTHER_COMMIT_ENV_VARS = COMMIT_ENV_VARS.filter(
	(name) => !(LEGACY_RELEASE_ENV_VARS as readonly string[]).includes(name),
);

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
 * The release to upload under: `--release`, else AUTTER_RELEASE, else the
 * first non-empty RELEASE_ENV_VARS value (GITHUB_SHA, VERCEL_GIT_COMMIT_SHA,
 * CF_PAGES_COMMIT_SHA, GIT_SHA; any value, as before), else the first commit
 * (7-40 hexadecimal characters) among the SDK's other commit variables
 * (AUTTER_COMMIT, GIT_COMMIT, COMMIT_SHA, SOURCE_COMMIT, RENDER_GIT_COMMIT,
 * RAILWAY_GIT_COMMIT_SHA, HEROKU_SLUG_COMMIT, SOURCE_VERSION), else
 * `git rev-parse HEAD` (build time only; the SDK never runs git). Throws with
 * a usable message when none is available or the value has characters the
 * ingester rejects.
 */
export function resolveRelease(
	explicit?: string | null,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): ResolvedRelease {
	const named: Array<[string, string | undefined | null]> = [
		["--release", explicit],
		["AUTTER_RELEASE", env.AUTTER_RELEASE],
		...RELEASE_ENV_VARS.map((name): [string, string | undefined] => [name, env[name]]),
	];
	for (const [source, value] of named) {
		const release = value?.trim();
		if (release) return checked(release, source);
	}
	for (const source of OTHER_COMMIT_ENV_VARS) {
		const value = env[source]?.trim();
		if (value && COMMIT_RE.test(value)) return { release: value, source };
	}
	const head = gitHead(cwd);
	if (head) return { release: head, source: "git" };
	throw new Error(
		`no release: pass --release <release>, or set AUTTER_RELEASE, one of ${RELEASE_ENV_VARS.join(", ")}, or a commit in one of ${OTHER_COMMIT_ENV_VARS.join(", ")}, or run inside a git checkout`,
	);
}
