/**
 * What this process is running: its commit, its default release and its
 * default environment, read from environment variables only. Never runs git
 * or any other subprocess: the SDK reads what the platform or the build put
 * in the environment, nothing else.
 *
 * Dependency-free on purpose: `@autter/runtime-cli` (src/release.ts) imports
 * this file by path and bundles it, so the source-map upload picks the same
 * commit variables, in the same order, as the SDK that reports the errors.
 * `runtime-core` is not an option there: it is a private package the CLI
 * does not depend on.
 */

/**
 * Environment variables that carry the commit being built or run, in the
 * order they are tried: Autter's own, then the four the source-map upload
 * CLI has always read, in its order (LEGACY_RELEASE_ENV_VARS), then the
 * other generic names and hosting platforms. One list for
 * `initAutterServer` / `initAutterLogging`, `enrichDeployment`,
 * `autter-runtime verify` and the source-map upload CLI (and the same list
 * as the Python adapter). With a commit in any one of the CLI's four, the
 * SDK's default release is the release the CLI uploads maps under.
 */
export const COMMIT_ENV_VARS = [
	"AUTTER_COMMIT",
	"GITHUB_SHA",
	"VERCEL_GIT_COMMIT_SHA",
	"CF_PAGES_COMMIT_SHA",
	"GIT_SHA",
	"GIT_COMMIT",
	"COMMIT_SHA",
	"SOURCE_COMMIT",
	"RENDER_GIT_COMMIT",
	"RAILWAY_GIT_COMMIT_SHA",
	"HEROKU_SLUG_COMMIT",
	"SOURCE_VERSION",
] as const;

/**
 * The variables @autter/runtime-cli named its upload release after before
 * the shared list, in its order. The CLI still takes any value from these
 * (a release is a name there), so existing builds keep uploading under the
 * release their bundles report.
 */
export const LEGACY_RELEASE_ENV_VARS = ["GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA", "CF_PAGES_COMMIT_SHA", "GIT_SHA"] as const;

/** A commit: 7 to 40 hexadecimal characters (an abbreviated or full git SHA-1). */
export const COMMIT_RE = /^[0-9a-fA-F]{7,40}$/;

type Env = Record<string, string | undefined>;

export interface DetectedCommit {
	commit: string;
	/** The variable it came from. */
	source: (typeof COMMIT_ENV_VARS)[number];
}

/**
 * The first commit variable whose (trimmed) value is a commit. A variable set
 * to anything else (a branch, a tag, `refs/heads/main`) is skipped, so the
 * next one can still answer.
 */
export function detectCommitFrom(env: Env = process.env): DetectedCommit | null {
	for (const source of COMMIT_ENV_VARS) {
		const value = env[source]?.trim();
		if (value && COMMIT_RE.test(value)) return { commit: value, source };
	}
	return null;
}

/** The running commit, or undefined. See {@link detectCommitFrom}. */
export function detectCommit(env: Env = process.env): string | undefined {
	return detectCommitFrom(env)?.commit;
}

const OFF = new Set(["false", "0", "no", "off"]);

/** `AUTTER_DETECT_RELEASE=false` (or 0 / no / off) turns the default release off. */
export function releaseDetectionDisabled(env: Env = process.env): boolean {
	const value = env.AUTTER_DETECT_RELEASE?.trim().toLowerCase();
	return value !== undefined && OFF.has(value);
}

/**
 * The release when the app passed none: `AUTTER_RELEASE`, else the detected
 * commit (the full value, so Autter can resolve it to the commit and its
 * pull request). Undefined when `AUTTER_DETECT_RELEASE=false`.
 */
export function defaultRelease(env: Env = process.env): string | undefined {
	if (releaseDetectionDisabled(env)) return undefined;
	return env.AUTTER_RELEASE?.trim() || detectCommit(env);
}

/**
 * The release an SDK reports: an explicit non-empty `release` always wins;
 * `release: false` means none; unset (or empty) falls back to
 * {@link defaultRelease}.
 */
export function resolveRelease(release: string | false | null | undefined, env: Env = process.env): string | undefined {
	if (release === false) return undefined;
	if (typeof release === "string" && release) return release;
	return defaultRelease(env);
}

/** Variables test runners set in the processes that run tests. */
export const TEST_RUNNER_ENV_VARS = ["JEST_WORKER_ID", "VITEST", "NODE_TEST_CONTEXT"] as const;

/** True inside Jest, Vitest or `node --test`. */
export function testRunnerDetected(env: Env = process.env): boolean {
	return TEST_RUNNER_ENV_VARS.some((name) => !!env[name]);
}

/**
 * The environment an SDK reports: the explicit option, else `NODE_ENV`, else
 * `test` under a test runner (Jest, Vitest, `node --test`), else
 * `production`. An explicit value (option or `NODE_ENV`) always wins.
 */
export function resolveEnvironment(environment: string | undefined, env: Env = process.env): string {
	return environment ?? env.NODE_ENV ?? (testRunnerDetected(env) ? "test" : "production");
}
