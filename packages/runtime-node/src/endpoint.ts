/**
 * Where the Autter ingest key and telemetry go: one resolver for
 * `initAutterServer`, `initAutterLogging`, the browser relay, `doctor` and
 * `verify`, so `verify` checks the endpoint the app really sends to.
 *
 * Order: the explicit option, then `AUTTER_ENDPOINT`, then
 * `AUTTER_RUNTIME_ENDPOINT`, then https://otlp.autter.dev.
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is never used to decide where the Autter key
 * goes: it is often set for another vendor's collector, which would then
 * receive the key. `doctor` and `verify` say so when it is set and differs.
 */

export const DEFAULT_INGEST_ENDPOINT = "https://otlp.autter.dev";

export type IngestEndpointSource = "option" | "AUTTER_ENDPOINT" | "AUTTER_RUNTIME_ENDPOINT" | "default";

export interface ResolvedIngestEndpoint {
	/** Base URL without a trailing slash. */
	endpoint: string;
	source: IngestEndpointSource;
}

function present(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** @internal The ingester base URL and where it came from. */
export function resolveIngestEndpoint(
	explicit?: string,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedIngestEndpoint {
	const option = present(explicit);
	const fromEnv = present(env.AUTTER_ENDPOINT);
	const fromRuntimeEnv = present(env.AUTTER_RUNTIME_ENDPOINT);
	const [raw, source]: [string, IngestEndpointSource] = option
		? [option, "option"]
		: fromEnv
			? [fromEnv, "AUTTER_ENDPOINT"]
			: fromRuntimeEnv
				? [fromRuntimeEnv, "AUTTER_RUNTIME_ENDPOINT"]
				: [DEFAULT_INGEST_ENDPOINT, "default"];
	return { endpoint: raw.replace(/\/+$/, ""), source };
}

/**
 * @internal A note for `doctor` and `verify` when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set to somewhere else than the Autter endpoint in use, else null.
 */
export function otelEndpointNote(endpoint: string, env: NodeJS.ProcessEnv = process.env): string | null {
	const otel = present(env.OTEL_EXPORTER_OTLP_ENDPOINT)?.replace(/\/+$/, "");
	if (!otel || otel === endpoint) return null;
	return (
		`OTEL_EXPORTER_OTLP_ENDPOINT is set to ${otel}, but Autter SDKs never send the Autter key there: ` +
		`they use ${endpoint}. To send to another Autter ingester, set AUTTER_ENDPOINT (or pass endpoint).`
	);
}
