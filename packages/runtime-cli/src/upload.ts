import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { normalizeDebugId, readDebugIdComment } from "./debug-id.js";
import { findBundles, stripSourceMappingUrl, type BundleWithMap } from "./files.js";
import { resolveRelease } from "./release.js";
import { computeScopes, SCOPES_KEY } from "./scopes.js";

export const DEFAULT_ENDPOINT = "https://otlp.autter.dev";
/** Largest map the ingester stores: characters of JSON without
 * `sourcesContent` (otlp-ingester's SOURCE_MAP_MAX_CHARS). */
export const MAX_MAP_CHARS = 32 * 1024 * 1024;
/** The ingester's `/v1/sourcemaps` body limit, counted after the gzip body
 * is inflated: the map plus room for the rest of the request. */
export const MAX_UPLOAD_BYTES = MAX_MAP_CHARS + 1024 * 1024;
/** What ingester 1.6.0 and older accept (the CLI can't tell which it talks to). */
const LEGACY_MAX_BYTES = 5 * 1024 * 1024;

const gzip = promisify(gzipCallback);
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
	/** The gzipped request body (empty in a dry run). */
	body: Uint8Array<ArrayBuffer>;
	/** Characters of the stored map JSON. */
	mapChars: number;
}

/** A Buffer as the plain Uint8Array `fetch` takes (no copy). */
function bytesOf(buffer: Buffer): Uint8Array<ArrayBuffer> {
	return new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}

/** Fits the ingester's limits: the stored map and the inflated body. */
function fits(json: string, body: string): boolean {
	return json.length <= MAX_MAP_CHARS && Buffer.byteLength(body) <= MAX_UPLOAD_BYTES;
}

/** The `/v1/sourcemaps` request body for one map. */
function uploadBody(release: string, filename: string, debugId: string | null, json: string): string {
	// The map goes in as a JSON object, not an escaped string, so a map close
	// to the limit still fits the request.
	return `{"release":${JSON.stringify(release)},"filename":${JSON.stringify(filename)},${
		debugId ? `"debugId":${JSON.stringify(debugId)},` : ""
	}"map":${json}}`;
}

async function prepare(
	bundle: BundleWithMap,
	urlPrefix: string | undefined,
	release: string,
	log: (line: string) => void,
	compress: boolean,
): Promise<Prepared | { error: string }> {
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
	const filename = servedFilename(urlPrefix, bundle.path);
	// Function scopes, computed on the bundle as it is served (after inject),
	// so their positions match browser stacks. Never sent stale: any scopes
	// already in the map are replaced or dropped.
	const { [SCOPES_KEY]: _stale, ...plain } = map;
	const scopes = computeScopes(code, map);
	let json = storedMapJson(plain);
	if ("scopes" in scopes) {
		const scoped = storedMapJson({ ...plain, [SCOPES_KEY]: scopes.scopes });
		if (fits(scoped, uploadBody(release, filename, debugId, scoped))) json = scoped;
		else if (fits(json, uploadBody(release, filename, debugId, json))) {
			log(`warning: ${bundle.path}: its map is over 32 MB with function scopes, so it is uploaded without them (frames keep call-site names)`);
		}
	} else {
		log(`warning: ${bundle.path}: no function scopes (${scopes.error}); its map is uploaded without them (frames keep call-site names)`);
	}
	const body = uploadBody(release, filename, debugId, json);
	return {
		bundle,
		// Maps are text that compresses several times over; the ingester
		// inflates the body (Content-Encoding: gzip).
		body: compress && fits(json, body) ? bytesOf(await gzip(body)) : new Uint8Array(0),
		path: bundle.path,
		filename,
		debugId,
		hash: createHash("sha256").update(json).digest("hex"),
		bytes: Buffer.byteLength(body),
		mapChars: json.length,
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
		const prepared = await prepare(bundle, options.urlPrefix, release, log, !options.dryRun);
		if ("error" in prepared) {
			summary.failed.push({ path: bundle.path, filename: servedFilename(options.urlPrefix, bundle.path), error: prepared.error });
		} else if (prepared.mapChars > MAX_MAP_CHARS || prepared.bytes > MAX_UPLOAD_BYTES) {
			summary.failed.push({
				path: prepared.path,
				filename: prepared.filename,
				error: `map is ${(prepared.mapChars / 1048576).toFixed(1)} MB without sourcesContent; the ingester accepts up to 32 MB`,
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
	const uploadHeaders = { ...headers, "content-encoding": "gzip" };

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
				const res = await doFetch(`${endpoint}/v1/sourcemaps`, { method: "POST", headers: uploadHeaders, body: item.body });
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
				let error = status ? `HTTP ${status}: ${detail}` : detail;
				if (status === 413 && item.bytes > LEGACY_MAX_BYTES) {
					error += ` (this map is ${(item.bytes / 1048576).toFixed(1)} MB; ingester 1.6.0 and older accept up to 5 MB, newer ones 32 MB)`;
				}
				summary.failed.push({ path: item.path, filename: item.filename, error });
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
