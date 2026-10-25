/**
 * `autter-runtime sourcemaps verify <dir>`: check a production build before
 * it is deployed. Every JS bundle must carry a debug id (the `//# debugId=`
 * comment and the registration snippet), no `.map` file may be left in the
 * output (it exposes the original source), no `sourceMappingURL` may point at
 * a map that isn't there, and, with a key, every bundle's map must be on the
 * ingester (`/v1/sourcemaps/check` by debug id, ingester 1.7.0+). Without a
 * key the upload state is reported as unverified. `server` checks a server
 * bundle directory (RF-05): the same, except leftover maps are reported
 * without failing, since server output is not served to browsers.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hasDebugIdSnippet, readDebugIdComment } from "./debug-id.js";
import { BUNDLE_RE, readSourceMappingUrl } from "./files.js";
import { resolveRelease } from "./release.js";
import { CLIENT_KEY_PREFIX, resolveEndpoint, servedFilename, UPLOAD_KEY_PREFIX } from "./upload.js";

export interface VerifyOptions {
	/** Ingester base URL (default as for upload). */
	endpoint?: string;
	/** Default: $AUTTER_RUNTIME_KEY. */
	key?: string;
	/** Sent with the check (a debug id check ignores it). */
	release?: string;
	urlPrefix?: string;
	/** Globs (relative to the directory) of JS files that are not bundles. */
	ignore?: string[];
	/** Report leftover .map files without failing (a step that runs before they are removed). */
	allowMaps?: boolean;
	/** A server bundle directory (tsup, esbuild, webpack or Next server
	 * output): leftover maps are reported, not failures — browsers never load
	 * them, and Node's own `--enable-source-maps` may use them. */
	server?: boolean;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	fetch?: typeof fetch;
}

export interface VerifyBundle {
	/** Relative to the directory. */
	path: string;
	status: "ok" | "failed" | "skipped";
	debugId: string | null;
	/** Why it failed, or why it was skipped. */
	reasons: string[];
	/** Whether the ingester has a map for its debug id (null: not checked). */
	uploaded: boolean | null;
}

export interface VerifyResult {
	dir: string;
	ok: boolean;
	bundles: VerifyBundle[];
	/** `.map` files in the directory (deploy risks unless allowMaps or server). */
	maps: string[];
	/** True when checked as server output (`--server`). */
	server?: boolean;
	upload: {
		/** verified: every checked bundle's map is on the ingester; missing: some are not;
		 * unverified: not checked (no key, or an ingester that can't answer); error: the check failed. */
		status: "verified" | "missing" | "unverified" | "error";
		endpoint: string | null;
		reason: string | null;
		checked: number;
		missing: number;
	};
	/** Every failure, one per file and reason. */
	failures: Array<{ path: string; reason: string }>;
}

const CHECK_BATCH = 500;
const SNIPPET_ID_RE = /\(g\._autterDebugIds=g\._autterDebugIds\|\|\{\}\)\[s\]="([0-9a-f-]{36})"/;

/** JS files that are generated or copied, never a bundle an SDK reports from. */
const NOT_BUNDLES: Array<[RegExp, string]> = [
	[/(^|\/)_(build|ssg|middleware|clientMiddleware)Manifest\.js$/, "Next.js build manifest"],
	// .next/server: middleware-build-manifest.js, next-font-manifest.js,
	// server-reference-manifest.js, page_client-reference-manifest.js, …
	[/(^|\/)[\w.-]*[-_]manifest\.js$/, "Next.js server manifest"],
	[/(^|\/)chunks\/polyfills-[\w-]+\.js$/, "Next.js polyfills, copied prebuilt without a source map"],
	[/(^|\/)(sw|service-worker|serviceWorker|firebase-messaging-sw|mockServiceWorker)\.js$/, "service worker (the browser SDK doesn't run there)"],
	[/(^|\/)workbox-[\w-]+\.js$/, "service worker runtime (the browser SDK doesn't run there)"],
];

/** A tiny glob: `**` any path, `*` any name part, `?` one character. A
 * pattern without "/" matches the file name anywhere. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!;
		if (ch === "*" && glob[i + 1] === "*") {
			re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
			i += glob[i + 2] === "/" ? 2 : 1;
		} else if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(glob.includes("/") ? `^${re.replace(/^\.\//, "")}$` : `(^|/)${re}$`);
}

async function walk(dir: string, out: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) await walk(full, out);
		else if (entry.isFile()) out.push(full);
	}
}

/** Directories static files are copied from verbatim: public/, static/ (SvelteKit), src/ (Angular assets). */
function staticRoots(dir: string): string[] {
	for (let current = dirname(dir); dirname(current) !== current; current = dirname(current)) {
		if (existsSync(join(current, "package.json"))) return ["public", "static", "src"].map((name) => join(current, name));
	}
	return [];
}

export async function verifyDir(dir: string, options: VerifyOptions = {}): Promise<VerifyResult> {
	const root = resolve(dir);
	const env = options.env ?? process.env;
	const files: string[] = [];
	await walk(root, files);
	files.sort();
	const relPath = (path: string) => relative(root, path).split(sep).join("/");
	const ignore = (options.ignore ?? []).map(globToRegExp);
	const roots = staticRoots(root);
	const result: VerifyResult = {
		dir: root,
		ok: true,
		bundles: [],
		maps: [],
		...(options.server ? { server: true } : {}),
		upload: { status: "unverified", endpoint: null, reason: null, checked: 0, missing: 0 },
		failures: [],
	};
	const fail = (path: string, reason: string) => result.failures.push({ path, reason });

	for (const file of files) {
		const path = relPath(file);
		if (file.endsWith(".map")) {
			result.maps.push(path);
			if (!options.allowMaps && !options.server) {
				fail(path, "source map in the deploy output: it exposes your original source. Delete it after upload (upload --delete-after-upload, or the bundler plugin) or keep it out of the deploy");
			}
			continue;
		}
		if (!BUNDLE_RE.test(file)) continue;
		const bytes = await readFile(file);
		const bundle: VerifyBundle = { path, status: "ok", debugId: null, reasons: [], uploaded: null };
		result.bundles.push(bundle);
		const skip = (reason: string) => {
			bundle.status = "skipped";
			bundle.reasons.push(reason);
		};
		if (ignore.some((re) => re.test(path))) {
			skip("matches --ignore");
			continue;
		}
		const known = NOT_BUNDLES.find(([re]) => re.test(path));
		if (known) {
			skip(known[1]);
			continue;
		}
		let copied: string | null = null;
		for (const staticRoot of roots) {
			const candidate = join(staticRoot, path);
			if (existsSync(candidate) && (await readFile(candidate)).equals(bytes)) copied = relative(dirname(staticRoot), candidate).split(sep).join("/");
		}
		if (copied) {
			skip(`copied unchanged from ${copied}, not built`);
			continue;
		}
		const code = bytes.toString("utf8");
		const commentId = readDebugIdComment(code);
		const snippetId = SNIPPET_ID_RE.exec(code)?.[1] ?? null;
		bundle.debugId = commentId;
		if (!commentId && !hasDebugIdSnippet(code)) {
			bundle.reasons.push(
				"no debug id: its errors can't be matched to a source map. Run `autter-runtime sourcemaps inject` on the build output (or use the bundler plugin with AUTTER_RUNTIME_KEY set) before deploying",
			);
		} else if (!commentId) {
			bundle.reasons.push("has the debug id snippet but no //# debugId= comment: run `autter-runtime sourcemaps inject` on it again");
		} else if (!hasDebugIdSnippet(code)) {
			bundle.reasons.push(
				"has a //# debugId= comment but no registration snippet, so the SDK can't report its id: run `autter-runtime sourcemaps inject` on it",
			);
		} else if (snippetId && snippetId !== commentId) {
			bundle.reasons.push(`its snippet registers debug id ${snippetId} but its comment says ${commentId}: run inject on the original build output`);
		}
		const url = readSourceMappingUrl(code);
		if (url?.startsWith("data:")) {
			// On a server the inlined source never reaches a browser.
			if (!options.server) {
				bundle.reasons.push("carries an inline source map (data: URL): your original source ships with the bundle. Use hidden or external maps");
			}
		} else if (url && !/^[a-z][\w+.-]*:/i.test(url) && !url.startsWith("/")) {
			let target = url.split(/[?#]/)[0]!;
			try {
				target = decodeURIComponent(target);
			} catch {
				// keep the raw value
			}
			if (!existsSync(resolve(dirname(file), target))) {
				bundle.reasons.push(
					`its sourceMappingURL points at ${url}, which is not in the output (browsers' devtools request it and get a 404). Remove the comment: upload --delete-after-upload does`,
				);
			}
		}
		if (bundle.reasons.length) {
			bundle.status = "failed";
			for (const reason of bundle.reasons) fail(path, reason);
		}
	}
	const counted = result.bundles.filter((b) => b.status !== "skipped");
	if (!counted.length) fail(".", `no .js/.mjs/.cjs bundles under ${dir}: is this the build output?`);

	await checkUploads(result, counted, options, env);
	result.ok = result.failures.length === 0;
	return result;
}

async function checkUploads(result: VerifyResult, bundles: VerifyBundle[], options: VerifyOptions, env: NodeJS.ProcessEnv): Promise<void> {
	const upload = result.upload;
	const key = (options.key ?? env.AUTTER_RUNTIME_KEY ?? "").trim();
	if (!key) {
		upload.reason = "AUTTER_RUNTIME_KEY is not set: only the local checks ran";
		return;
	}
	upload.endpoint = resolveEndpoint(options.endpoint, env);
	if (key.startsWith(CLIENT_KEY_PREFIX)) {
		upload.status = "error";
		upload.reason = "AUTTER_RUNTIME_KEY is a publishable client key (autter_rtc_…), which can't check source maps: use an upload key (autter_rtu_…) or the server key (autter_rt_…)";
		result.failures.push({ path: ".", reason: upload.reason });
		return;
	}
	const withIds = bundles.filter((b) => b.debugId);
	if (!withIds.length) {
		upload.reason = "no bundle has a debug id to check";
		return;
	}
	let release = "verify";
	try {
		release = resolveRelease(options.release, env, options.cwd).release;
	} catch {
		// a debug id check doesn't need one
	}
	const doFetch = options.fetch ?? fetch;
	const missing: VerifyBundle[] = [];
	for (let start = 0; start < withIds.length; start += CHECK_BATCH) {
		const batch = withIds.slice(start, start + CHECK_BATCH);
		let res: Response;
		try {
			res = await doFetch(`${upload.endpoint}/v1/sourcemaps/check`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
				body: JSON.stringify({ release, files: batch.map((b) => ({ filename: servedFilename(options.urlPrefix, b.path), debugId: b.debugId })) }),
			});
		} catch (err) {
			upload.status = "error";
			upload.reason = `could not reach the ingester: ${(err as Error).message}`;
			result.failures.push({ path: ".", reason: upload.reason });
			return;
		}
		if (res.status === 404 || res.status === 400) {
			upload.status = "unverified";
			upload.reason =
				res.status === 404
					? "the ingester predates 1.6.0 (no /v1/sourcemaps/check), so uploads can't be checked: upgrade it"
					: "the ingester predates 1.7.0, which checks maps by debug id alone, so uploads can't be checked after the maps were deleted: upgrade it";
			return;
		}
		if (res.status === 401 || res.status === 403) {
			upload.status = "error";
			upload.reason =
				`the ingester rejected the key (${res.status}): ${(await res.text()).slice(0, 300)}` +
				(key.startsWith(UPLOAD_KEY_PREFIX) ? " (upload keys, autter_rtu_…, need ingester 1.7.0 or later)" : "");
			result.failures.push({ path: ".", reason: upload.reason });
			return;
		}
		if (!res.ok) {
			upload.status = "error";
			upload.reason = `the source map check failed: HTTP ${res.status}`;
			result.failures.push({ path: ".", reason: upload.reason });
			return;
		}
		const body = (await res.json()) as { present?: unknown };
		const present = new Set(Array.isArray(body.present) ? body.present : []);
		batch.forEach((bundle, index) => {
			bundle.uploaded = present.has(index);
			if (!bundle.uploaded) missing.push(bundle);
		});
	}
	upload.checked = withIds.length;
	upload.missing = missing.length;
	upload.status = missing.length ? "missing" : "verified";
	upload.reason = missing.length ? `${missing.length} of ${withIds.length} bundle(s) have no map on the ingester` : null;
	for (const bundle of missing) {
		const reason = `no map with debug id ${bundle.debugId} on the ingester for this key's repository: upload this build's maps (autter-runtime sourcemaps upload, or the bundler plugin with AUTTER_RUNTIME_KEY set)`;
		bundle.status = "failed";
		bundle.reasons.push(reason);
		result.failures.push({ path: bundle.path, reason });
	}
}

/** Human-readable report. */
export function formatVerify(result: VerifyResult): string[] {
	const lines: string[] = [];
	for (const bundle of result.bundles) {
		if (bundle.status === "ok") lines.push(`ok      ${bundle.path} (debug id ${bundle.debugId}${bundle.uploaded ? ", map uploaded" : ""})`);
		else if (bundle.status === "skipped") lines.push(`skipped ${bundle.path}: ${bundle.reasons.join("; ")}`);
		else for (const reason of bundle.reasons) lines.push(`FAILED  ${bundle.path}: ${reason}`);
	}
	for (const map of result.maps) {
		const failure = result.failures.find((f) => f.path === map);
		lines.push(
			failure
				? `FAILED  ${map}: ${failure.reason}`
				: result.server
					? `note    ${map}: source map in the server output (browsers never load it)`
					: `warning ${map}: source map in the output (allowed by --allow-maps; remove it before deploying)`,
		);
	}
	for (const failure of result.failures.filter((f) => f.path === ".")) lines.push(`FAILED  ${failure.reason}`);
	const u = result.upload;
	lines.push(
		u.status === "verified"
			? `upload: verified, ${u.checked} bundle map(s) on the ingester (${u.endpoint})`
			: u.status === "missing"
				? `upload: ${u.reason} (${u.endpoint})`
				: `upload: ${u.status}${u.reason ? `, ${u.reason}` : ""}`,
	);
	const counted = result.bundles.filter((b) => b.status !== "skipped");
	lines.push(
		result.ok
			? `ok: ${counted.length} bundle(s) with debug ids, ${result.maps.length ? `${result.maps.length} source map(s) left (${result.server ? "server output" : "--allow-maps"})` : "no source maps left"}${u.status === "unverified" ? ", upload not verified" : ""}`
			: `${result.failures.length} problem(s) in ${result.dir}`,
	);
	return lines;
}
