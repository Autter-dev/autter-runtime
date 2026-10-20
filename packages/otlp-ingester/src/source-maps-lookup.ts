// stub — EI-13 replaces this file
import type { ClickHouseClient } from "@clickhouse/client";

export interface SourceMapKey {
	orgId: string;
	repositoryId: string;
	release: string | null;
	filename: string;
	debugId?: string | null;
}

/** "https://cdn.example.com/assets/app.js?v=1#x" → "/assets/app.js" (the stored key form). */
function pathOnly(filename: string): string | null {
	try {
		return new URL(filename, "https://autter.invalid").pathname;
	} catch {
		return null;
	}
}

/**
 * The stored map JSON for a minified file: by debug id first when given,
 * else by release + filename (path only, no origin/query). Null when none.
 *
 * Stub until EI-13 lands debug ids: looks up by (release, filename) only
 * and ignores `debugId`.
 */
export async function lookupSourceMap(
	client: ClickHouseClient,
	database: string,
	key: SourceMapKey,
): Promise<string | null> {
	if (!key.release) return null;
	const filename = pathOnly(key.filename);
	if (!filename) return null;
	const rows = await client.query({
		query: `SELECT map FROM ${database}.runtime_source_maps
			WHERE org_id = {org:String} AND repository_id = {repo:String}
				AND release = {release:String} AND filename = {filename:String}
			ORDER BY uploaded_at DESC
			LIMIT 1`,
		query_params: {
			org: key.orgId,
			repo: key.repositoryId,
			release: key.release,
			filename,
		},
		format: "JSONEachRow",
	});
	const [row] = await rows.json<{ map: string }>();
	return typeof row?.map === "string" && row.map ? row.map : null;
}
