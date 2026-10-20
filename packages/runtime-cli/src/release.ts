import { execFileSync } from "node:child_process";

/** What the ingester accepts as a release. */
export const RELEASE_RE = /^[a-zA-Z0-9._-]{1,200}$/;

/** CI variables that carry the commit being built, in the order they are tried. */
export const RELEASE_ENV_VARS = [
	"GITHUB_SHA",
	"VERCEL_GIT_COMMIT_SHA",
	"CF_PAGES_COMMIT_SHA",
	"GIT_SHA",
] as const;

export interface ResolvedRelease {
	release: string;
	/** Where it came from: "--release", an env var name, or "git". */
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

/**
 * The release to upload under: the explicit value, else the first CI commit
 * variable that is set (GITHUB_SHA, VERCEL_GIT_COMMIT_SHA, CF_PAGES_COMMIT_SHA,
 * GIT_SHA), else `git rev-parse HEAD`. Throws with a usable message when none
 * is available or the value has characters the ingester rejects.
 */
export function resolveRelease(
	explicit?: string | null,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): ResolvedRelease {
	const candidates: Array<[string, string | undefined | null]> = [
		["--release", explicit],
		...RELEASE_ENV_VARS.map((name): [string, string | undefined] => [name, env[name]]),
	];
	for (const [source, value] of candidates) {
		const release = value?.trim();
		if (!release) continue;
		if (!RELEASE_RE.test(release)) {
			throw new Error(
				`release "${release}" (from ${source}) is not valid: use 1-200 letters, digits, ".", "_" or "-" (a commit SHA works)`,
			);
		}
		return { release, source };
	}
	const head = gitHead(cwd);
	if (head) return { release: head, source: "git" };
	throw new Error(
		`no release: pass --release <release>, or set one of ${RELEASE_ENV_VARS.join(", ")}, or run inside a git checkout`,
	);
}
