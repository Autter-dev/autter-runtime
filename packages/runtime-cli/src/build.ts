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
	/** Server ingest key. Default: $AUTTER_RUNTIME_KEY. Without one, debug ids
	 * are still injected but nothing is uploaded. */
	key?: string;
	/** Set false to inject debug ids only (upload later with the CLI). */
	upload?: boolean;
	/** Delete `.map` files once uploaded so they are never deployed. Default:
	 * true when the plugin turned source maps on itself, false when you had. */
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
 * Failures are logged, and thrown only with `failOnError`.
 */
export async function processBuildOutput(input: {
	dir: string;
	files?: string[];
	urlPrefix: string;
	options: AutterSourceMapsOptions;
	/** Default for `deleteAfterUpload` (true when the plugin enabled maps). */
	deleteAfterUpload: boolean;
	stripSourceMappingUrl?: boolean;
}): Promise<BuildOutputResult> {
	const { options } = input;
	const log = (line: string) => {
		if (!options.silent) console.log(`[autter-runtime] ${line}`);
	};
	const result: BuildOutputResult = { injected: [], upload: null };
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
		const key = options.key ?? process.env.AUTTER_RUNTIME_KEY;
		if (!key && !options.dryRun) {
			if (result.injected.length) log("AUTTER_RUNTIME_KEY is not set: source maps were not uploaded");
			return result;
		}
		if (!result.injected.some((r) => r.status !== "invalid-map")) return result;
		result.upload = await uploadDir(input.dir, {
			files: input.files,
			release: options.release,
			urlPrefix: options.urlPrefix ?? input.urlPrefix,
			endpoint: options.endpoint,
			key,
			dryRun: options.dryRun,
			concurrency: options.concurrency,
			deleteAfterUpload: options.deleteAfterUpload ?? input.deleteAfterUpload,
			log,
		});
		for (const line of formatUploadSummary(result.upload)) log(line);
		if (result.upload.failed.length && options.failOnError) {
			throw new Error(`${result.upload.failed.length} source map upload(s) failed`);
		}
	} catch (err) {
		const message = `source maps: ${err instanceof Error ? err.message : String(err)}`;
		if (options.failOnError) throw new Error(`[autter-runtime] ${message}`);
		if (!options.silent) console.warn(`[autter-runtime] ${message}`);
	}
	return result;
}
