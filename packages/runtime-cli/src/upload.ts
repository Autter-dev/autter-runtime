import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { normalizeDebugId, readDebugIdComment } from "./debug-id.js";
import { findBundles, stripSourceMappingUrl, type BundleWithMap } from "./files.js";
import { resolveRelease } from "./release.js";

export const DEFAULT_ENDPOINT = "https://otlp.autter.dev";
/** The ingester's `/v1/sourcemaps` body limit. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CHECK_BATCH = 500;
const MAX_ATTEMPTS = 3;

export interface UploadOptions {
	/** Only these bundles (absolute, or relative to the directory). */
	files?: string[];
	/** Default: --release resolution (see resolveRelease). */
	release?: string;
	/** Where the directory is served from: "/" (default), "/static/", or
	 * "https://cdn.example.com/app/". Each map is stored under prefix + path. */
	urlPrefix?: string;
	/** Ingester base URL. Default: $AUTTER_ENDPOINT, $AUTTER_RUNTIME_ENDPOINT,
	 * $OTEL_EXPORTER_OTLP_ENDPOINT, else https://otlp.autter.dev. */
	endpoint?: string;
	/** Server ingest key. Default: $AUTTER_RUNTIME_KEY. */
	key?: string;
	/** List what would be uploaded; no network, no key needed. */
	dryRun?: boolean;
	/** Parallel uploads (default 8). */
	concurrency?: number;
	/** Delete each `.map` (and its `sourceMappingURL` comment) once the
	 * ingester has it, so maps are never deployed. */
	deleteAfterUpload?: boolean;
	log?: (line: string) => void;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	fetch?: typeof fetch;
}

export interface UploadItem {
	/** Bundle path relative to the directory. */
	path: string;
	/** Stored filename: urlPrefix + path. */
	filename: string;
	debugId: string | null;
	/** sha256 of the uploaded map JSON (what the ingester stores). */
	hash: string;
	bytes: number;
}

export interface UploadSummary {
	release: string;
	releaseSource: string;
	endpoint: string;
	dryRun: boolean;
	uploaded: UploadItem[];
	/** Already on the ingester with the same content: not sent again. */
	skipped: UploadItem[];
	failed: Array<{ path: string; filename: string; error: string }>;
	/** True when the ingester predates 1.6.0 (no `/v1/sourcemaps/check`). */
	legacyIngester: boolean;
	deletedMaps: string[];
}

/** Ingester base URL from a flag or the environment, without a trailing
 * slash or a `/v1/...` route someone pasted in. */
export function resolveEndpoint(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
	const raw = flag || env.AUTTER_ENDPOINT || env.AUTTER_RUNTIME_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_ENDPOINT;
	return raw.trim().replace(/\/+$/, "").replace(/\/v1\/[a-z-]+$/, "");
}

/** prefix + path, with exactly one "/" between. "~/" (Sentry's spelling) means "/". */
export function servedFilename(urlPrefix: string | undefined, path: string): string {
	let prefix = (urlPrefix ?? "/").trim() || "/";
	if (prefix.startsWith("~/")) prefix = prefix.slice(1);
	if (!/^[a-z][\w+.-]*:\/\//i.test(prefix) && !prefix.startsWith("/")) prefix = `/${prefix}`;
	return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The map as the ingester stores it: `sourcesContent` removed, compact JSON. */
export function storedMapJson(map: Record<string, unknown>): string {
	const { sourcesContent: _omitted, ...safe } = map;
	return JSON.stringify(safe);
}

interface Prepared extends UploadItem {
	bundle: BundleWithMap;
	body: string;
}

async function prepare(bundle: BundleWithMap, urlPrefix: string | undefined, release: string): Promise<Prepared | { error: string }> {
	let map: Record<string, unknown>;
	try {
		map = JSON.parse(await readFile(bundle.map, "utf8")) as Record<string, unknown>;
	} catch {
		return { error: "map is not valid JSON" };
	}
	if (!map || map.version !== 3 || typeof map.mappings !== "string" || !Array.isArray(map.sources)) {
		return { error: "not a version 3 source map with mappings and sources" };
	}
	const code = await readFile(bundle.js, "utf8");
	const debugId = readDebugIdComment(code) ?? normalizeDebugId(map.debugId);
	const json = storedMapJson(map);
	const filename = servedFilename(urlPrefix, bundle.path);
	// The map goes in as a JSON object, not an escaped string, so a map close
	// to the limit still fits the request.
	const body = `{"release":${JSON.stringify(release)},"filename":${JSON.stringify(filename)},${
		debugId ? `"debugId":${JSON.stringify(debugId)},` : ""
	}"map":${json}}`;
	return {
		bundle,
		body,
		path: bundle.path,
		filename,
		debugId,
		hash: createHash("sha256").update(json).digest("hex"),
		bytes: Buffer.byteLength(body),
	};
}

class FatalUploadError extends Error {}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Upload every source map under `dir` to the ingester's `/v1/sourcemaps`. */
export async function uploadDir(dir: string, options: UploadOptions = {}): Promise<UploadSummary> {
	const env = options.env ?? process.env;
	const log = options.log ?? (() => {});
	const doFetch = options.fetch ?? fetch;
	const { release, source: releaseSource } = resolveRelease(options.release, env, options.cwd);
	const endpoint = resolveEndpoint(options.endpoint, env);
	const summary: UploadSummary = {
		release, releaseSource, endpoint, dryRun: Boolean(options.dryRun),
		uploaded: [], skipped: [], failed: [], legacyIngester: false, deletedMaps: [],
	};

	const items: Prepared[] = [];
	for (const bundle of await findBundles(dir, options.files)) {
		const prepared = await prepare(bundle, options.urlPrefix, release);
		if ("error" in prepared) {
			summary.failed.push({ path: bundle.path, filename: servedFilename(options.urlPrefix, bundle.path), error: prepared.error });
		} else if (prepared.bytes > MAX_UPLOAD_BYTES) {
			summary.failed.push({
				path: prepared.path,
				filename: prepared.filename,
				error: `map is ${(prepared.bytes / 1048576).toFixed(1)} MB without sourcesContent; the ingester accepts up to 5 MB`,
			});
		} else {
			items.push(prepared);
		}
	}

	if (options.dryRun) {
		summary.uploaded = items.map(strip);
		return summary;
	}

	const key = (options.key ?? env.AUTTER_RUNTIME_KEY ?? "").trim();
	if (!key) throw new FatalUploadError("no ingest key: set AUTTER_RUNTIME_KEY to a server key (autter_rt_…)");
	if (key.startsWith("autter_rtc_")) {
		throw new FatalUploadError("AUTTER_RUNTIME_KEY is a publishable client key (autter_rtc_…); uploads need a server key (autter_rt_…)");
	}
	const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };

	// Skip maps the ingester already has (same release, path, debug id and
	// content). Older ingesters have no check route: upload everything.
	const skipped = new Set<Prepared>();
	for (let start = 0; start < items.length && !summary.legacyIngester; start += CHECK_BATCH) {
		const batch = items.slice(start, start + CHECK_BATCH);
		try {
			const res = await doFetch(`${endpoint}/v1/sourcemaps/check`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					release,
					files: batch.map((item) => ({ filename: item.filename, ...(item.debugId ? { debugId: item.debugId } : {}), hash: item.hash })),
				}),
			});
			if (res.status === 404) {
				summary.legacyIngester = true;
				log(
					"warning: this ingester predates 1.6.0, so it stores no debug ids and rejects .mjs/.cjs maps. " +
						"Upgrade it: docker pull ghcr.io/autter-dev/otlp-ingester:latest",
				);
				break;
			}
			if (res.status === 401 || res.status === 403) {
				throw new FatalUploadError(`the ingester rejected the key (${res.status}): ${(await res.text()).slice(0, 300)}`);
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { present?: unknown };
			const present = new Set(Array.isArray(body.present) ? body.present : []);
			batch.forEach((item, index) => {
				if (present.has(index)) skipped.add(item);
			});
		} catch (err) {
			if (err instanceof FatalUploadError) throw err;
			log(`warning: could not check which maps the ingester already has (${(err as Error).message}); uploading all`);
		}
	}

	const uploaded: Prepared[] = [];
	let fatal = null as FatalUploadError | null;
	const uploadOne = async (item: Prepared): Promise<void> => {
		for (let attempt = 1; ; attempt++) {
			if (fatal) return;
			let status = 0;
			let detail = "";
			try {
				const res = await doFetch(`${endpoint}/v1/sourcemaps`, { method: "POST", headers, body: item.body });
				status = res.status;
				if (res.ok) {
					uploaded.push(item);
					return;
				}
				detail = (await res.text()).slice(0, 300);
			} catch (err) {
				detail = (err as Error).message;
			}
			if (status === 401 || status === 403) {
				fatal = new FatalUploadError(`the ingester rejected the key (${status}): ${detail}`);
				return;
			}
			const retryable = status === 0 || status === 429 || status >= 500;
			if (!retryable || attempt >= MAX_ATTEMPTS) {
				summary.failed.push({ path: item.path, filename: item.filename, error: status ? `HTTP ${status}: ${detail}` : detail });
				return;
			}
			await sleep(500 * 2 ** (attempt - 1));
		}
	};
	const queue = items.filter((item) => !skipped.has(item));
	const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, queue.length)) }, async () => {
		for (let item = queue.shift(); item; item = queue.shift()) await uploadOne(item);
	});
	await Promise.all(workers);
	if (fatal) throw fatal;

	// Keep the summary in directory order whatever order uploads finished in.
	const order = (a: Prepared, b: Prepared) => items.indexOf(a) - items.indexOf(b);
	uploaded.sort(order);
	if (options.deleteAfterUpload) {
		for (const item of [...uploaded, ...skipped]) {
			await rm(item.bundle.map, { force: true });
			const code = await readFile(item.bundle.js, "utf8");
			const stripped = stripSourceMappingUrl(code);
			if (stripped !== code) await writeFile(item.bundle.js, stripped);
			summary.deletedMaps.push(item.bundle.map);
		}
	}
	summary.uploaded = uploaded.map(strip);
	summary.skipped = [...skipped].sort(order).map(strip);
	return summary;
}

function strip(item: UploadItem): UploadItem {
	const { path, filename, debugId, hash, bytes } = item;
	return { path, filename, debugId, hash, bytes };
}

export { FatalUploadError };
