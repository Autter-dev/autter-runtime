import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { findBundles, removeSourceMaps } from "./files.js";
import { injectDir, type InjectResult } from "./inject.js";
import { uploadDir, type UploadSummary } from "./upload.js";

/** Options shared by the Vite/Rollup, webpack and Next.js integrations. */
export interface AutterSourceMapsOptions {
	/** Default: GITHUB_SHA, VERCEL_GIT_COMMIT_SHA, CF_PAGES_COMMIT_SHA, GIT_SHA, then `git rev-parse HEAD`. */
	release?: string;
	/** Where the build output is served from. Default: the bundler's public
	 * path (Vite `base`, webpack `output.publicPath`, Next `/_next/`), else "/". */
	urlPrefix?: string;
	/** Ingester base URL. Default: $AUTTER_ENDPOINT, $AUTTER_RUNTIME_ENDPOINT,
	 * $OTEL_EXPORTER_OTLP_ENDPOINT, else https://otlp.autter.dev. */
	endpoint?: string;
	/** Server ingest key. Default: $AUTTER_RUNTIME_KEY. Without one (and
	 * without `upload: false` or `dryRun`), the plugin generates no source
	 * maps it would have to delete again: the build is left as it was. */
	key?: string;
	/** Set false to inject debug ids only (upload later with the CLI). Maps
	 * the plugin generated are then kept for that upload: don't deploy them. */
	upload?: boolean;
	/** Maps the plugin generated itself are always deleted after the upload
	 * step, uploaded or not, so they are never deployed; set false to keep
	 * them (you must then keep them out of the deploy). Maps you configured
	 * yourself are deleted only when this is true, and only once uploaded. */
	deleteAfterUpload?: boolean;
	/** Log what would be uploaded without sending anything. */
	dryRun?: boolean;
	/** Parallel uploads (default 8). */
	concurrency?: number;
	/** Fail the build when injecting or uploading fails (default false:
	 * telemetry never breaks a deploy; the failure is logged). */
	failOnError?: boolean;
	/** No log output. */
	silent?: boolean;
}

export interface BuildOutputResult {
	injected: InjectResult[];
	upload: UploadSummary | null;
	/** Maps the plugin generated and deleted (paths relative to the directory). */
	removedMaps: string[];
}

/** The ingest key a build would upload with, or null. */
export function buildKey(options: AutterSourceMapsOptions): string | null {
	const key = (options.key ?? process.env.AUTTER_RUNTIME_KEY ?? "").trim();
	return key || null;
}

/**
 * Whether an integration should turn on source maps the user didn't ask
 * for. Only when they will go somewhere: an upload (a key is set), a dry
 * run (they are listed, then deleted), or `upload: false` (kept for a later
 * CLI upload). Without a key, generating them would only mean deleting
 * them again — and injecting debug ids no map will ever answer — so the
 * build is left exactly as it was.
 */
export function shouldGenerateMaps(options: AutterSourceMapsOptions): boolean {
	return options.upload === false || Boolean(options.dryRun) || buildKey(options) !== null;
}

/** The one line an integration prints when it leaves maps off for want of a key. */
export function logMapsNotGenerated(options: AutterSourceMapsOptions): void {
	if (!options.silent) {
		console.log("[autter-runtime] AUTTER_RUNTIME_KEY is not set: no source maps generated, nothing uploaded");
	}
}

/** Human-readable lines for an upload summary (CLI and plugins). */
export function formatUploadSummary(summary: UploadSummary): string[] {
	const lines: string[] = [];
	const verb = summary.dryRun ? "would upload" : "uploaded";
	for (const item of summary.uploaded) {
		lines.push(`${verb} ${item.filename}${item.debugId ? ` (debug id ${item.debugId})` : ""}`);
	}
	for (const item of summary.skipped) lines.push(`skipped ${item.filename} (already uploaded)`);
	for (const item of summary.failed) lines.push(`failed ${item.filename}: ${item.error}`);
	lines.push(
		`${summary.uploaded.length} ${verb}, ${summary.skipped.length} already uploaded, ${summary.failed.length} failed ` +
			`(release ${summary.release} from ${summary.releaseSource}, ${summary.endpoint})`,
	);
	return lines;
}

/**
 * What every bundler integration does after a build: inject debug ids into
 * the emitted bundles, then upload their maps when a key is present.
 * Failures are logged, and thrown only with `failOnError`. When the
 * integration turned source maps on itself (`ownMaps`), every map it made
 * is deleted afterwards whatever happened to the upload (no key, a failed
 * or partial upload, an unreachable ingester, a dry run), with the
 * sourceMappingURL comments that name them, so none is deployed.
 */
export async function processBuildOutput(input: {
	dir: string;
	files?: string[];
	urlPrefix: string;
	options: AutterSourceMapsOptions;
	/** Default for `deleteAfterUpload` (true when the plugin enabled maps). */
	deleteAfterUpload: boolean;
	stripSourceMappingUrl?: boolean;
	/** The integration turned source maps on itself: none may be deployed. */
	ownMaps?: boolean;
	/** Map files the build emitted (absolute), when the bundler lists them;
	 * the maps of `files` (or of every bundle under `dir`) are added. */
	maps?: string[];
}): Promise<BuildOutputResult> {
	const { options } = input;
	const log = (line: string) => {
		if (!options.silent) console.log(`[autter-runtime] ${line}`);
	};
	const result: BuildOutputResult = { injected: [], upload: null, removedMaps: [] };
	// Why the generated maps go, as the upload step ends.
	let outcome = "they were uploaded";
	// Listed before the upload step, which deletes the maps it uploads.
	const owners = new Map<string, string>();
	if (input.ownMaps) {
		for (const bundle of await findBundles(input.dir, input.files)) owners.set(bundle.map, bundle.js);
	}
	try {
		try {
			result.injected = await injectDir(input.dir, {
				files: input.files,
				dryRun: options.dryRun,
				stripSourceMappingUrl: input.stripSourceMappingUrl,
			});
			const changed = result.injected.filter((r) => r.status === "injected").length;
			if (result.injected.length) {
				log(`debug ids: ${changed} bundle(s) injected, ${result.injected.length - changed} already had one`);
			}
			for (const bad of result.injected.filter((r) => r.status === "invalid-map")) log(`skipped ${bad.path}: its map is not valid JSON`);
			if (options.upload === false) return result;
			const key = buildKey(options);
			if (!key && !options.dryRun) {
				outcome = "AUTTER_RUNTIME_KEY is not set";
				if (result.injected.length && !input.ownMaps) log("AUTTER_RUNTIME_KEY is not set: source maps were not uploaded");
				return result;
			}
			if (!result.injected.some((r) => r.status !== "invalid-map")) {
				outcome = "no bundle had a usable map to upload";
				return result;
			}
			result.upload = await uploadDir(input.dir, {
				files: input.files,
				release: options.release,
				urlPrefix: options.urlPrefix ?? input.urlPrefix,
				endpoint: options.endpoint,
				key: key ?? undefined,
				dryRun: options.dryRun,
				concurrency: options.concurrency,
				deleteAfterUpload: options.deleteAfterUpload ?? input.deleteAfterUpload,
				log,
			});
			for (const line of formatUploadSummary(result.upload)) log(line);
			const { failed, uploaded, skipped, dryRun } = result.upload;
			if (dryRun) outcome = "dry run, nothing was uploaded";
			else if (failed.length) {
				outcome = `${failed.length} of ${failed.length + uploaded.length + skipped.length} could not be uploaded (${failed[0]!.error})`;
			}
			if (failed.length && options.failOnError) {
				throw new Error(`${failed.length} source map upload(s) failed`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (outcome === "they were uploaded") outcome = `the upload failed (${message})`;
			if (options.failOnError) throw new Error(`[autter-runtime] source maps: ${message}`);
			if (!options.silent) console.warn(`[autter-runtime] source maps: ${message}`);
		}
	} finally {
		// Also when the step above returned early or threw.
		await cleanUp();
	}
	return result;

	async function cleanUp(): Promise<void> {
		if (!input.ownMaps) return;
		const maps = new Set([...(input.maps ?? []), ...owners.keys()]);
		const rel = (path: string) => relative(input.dir, path).split(sep).join("/");
		if (options.upload === false || options.deleteAfterUpload === false) {
			const kept = [...maps].filter((map) => existsSync(map));
			if (kept.length) {
				log(
					`kept ${kept.length} source map(s) this plugin generated (${options.upload === false ? "upload: false" : "deleteAfterUpload: false"}): ` +
						"they expose your source, so upload them with `autter-runtime sourcemaps upload --delete-after-upload` or keep them out of the deploy",
				);
			}
			return;
		}
		try {
			await removeSourceMaps(maps, owners);
		} catch (err) {
			const message = `could not delete the source maps this plugin generated (${err instanceof Error ? err.message : String(err)}): keep them out of the deploy`;
			if (options.failOnError) throw new Error(`[autter-runtime] ${message}`);
			if (!options.silent) console.warn(`[autter-runtime] ${message}`);
		}
		// Uploaded maps were already deleted by the upload step.
		result.removedMaps = [...maps].filter((map) => !existsSync(map)).map(rel).sort();
		if (result.removedMaps.length) {
			log(`removed ${result.removedMaps.length} source map(s) this plugin generated, so they are not deployed: ${outcome}`);
		}
	}
}
