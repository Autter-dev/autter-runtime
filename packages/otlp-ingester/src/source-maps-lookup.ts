import type { ClickHouseClient } from "@clickhouse/client";
import {
	normalizeDebugId,
	sourceMapPath,
	type SourceMapCheck,
} from "./source-maps.js";

/**
 * Source map lookups against `runtime_source_maps` (EI-13). Uploads come
 * from `autter-runtime sourcemaps upload` / the bundler plugins, or any
 * client of `POST /v1/sourcemaps`.
 */

export interface SourceMapKey {
	orgId: string;
	repositoryId: string;
	release: string | null;
	filename: string;
	debugId?: string | null;
}

async function firstMap(
	client: ClickHouseClient,
	database: string,
	where: string,
	params: Record<string, string>,
): Promise<string | null> {
	const rows = await client.query({
		query: `SELECT map FROM ${database}.runtime_source_maps
			WHERE org_id = {org:String} AND repository_id = {repo:String} AND ${where}
			ORDER BY uploaded_at DESC LIMIT 1`,
		query_params: params,
		format: "JSONEachRow",
	});
	const [row] = await rows.json<{ map: string }>();
	return row?.map ?? null;
}

/** The stored map JSON for a minified file: by debug id first when given, else by release + filename (path only, no origin/query). Null when none. */
export async function lookupSourceMap(
	client: ClickHouseClient,
	database: string,
	key: SourceMapKey,
): Promise<string | null> {
	const tenant = { org: key.orgId, repo: key.repositoryId };
	// A debug id names the exact bundle bytes, so it matches whatever release
	// the SDK reported (or none). Fall through to release + path when no map
	// was uploaded with this id (old CLI, plain curl upload).
	const debugId = normalizeDebugId(key.debugId);
	if (debugId) {
		const map = await firstMap(client, database, "debug_id = {debugId:String}", { ...tenant, debugId });
		if (map !== null) return map;
	}
	const filename = sourceMapPath(key.filename);
	if (!key.release || !filename) return null;
	return firstMap(
		client,
		database,
		"release = {release:String} AND filename = {filename:String}",
		{ ...tenant, release: key.release, filename },
	);
}

/**
 * Re-uploading a map refreshes its 30-day TTL, so a map only counts as
 * already uploaded when it was stored this recently; older ones are sent
 * again and stay alive while the release is still being built.
 */
export const SOURCE_MAP_FRESH_DAYS = 7;

/**
 * Which check entries the tenant already has. An entry with a hash: same
 * release, path, debug id and content hash, uploaded in the last
 * SOURCE_MAP_FRESH_DAYS (the upload skips those). An entry with only a
 * debug id: any stored map with that id, whatever its release and path —
 * exactly what lookupSourceMap would find for a stack from that bundle.
 * Returns the indexes of `check.entries` that are present.
 */
export async function presentSourceMaps(
	client: ClickHouseClient,
	database: string,
	tenant: { orgId: string; repositoryId: string },
	check: SourceMapCheck,
): Promise<number[]> {
	const hashed = check.entries.some((entry) => entry.hash);
	const byId = check.entries.filter((entry) => !entry.hash).map((entry) => entry.debugId);
	const [withHash, ids] = await Promise.all([
		hashed ? presentByHash(client, database, tenant, check) : new Set<string>(),
		byId.length ? presentDebugIds(client, database, tenant, byId) : new Set<string>(),
	]);
	const present: number[] = [];
	check.entries.forEach((entry, index) => {
		const found = entry.hash
			? withHash.has(`${entry.filename}\u0000${entry.debugId}\u0000${entry.hash}`)
			: ids.has(entry.debugId);
		if (found) present.push(index);
	});
	return present;
}

async function presentDebugIds(
	client: ClickHouseClient,
	database: string,
	tenant: { orgId: string; repositoryId: string },
	debugIds: string[],
): Promise<Set<string>> {
	const rows = await client.query({
		query: `SELECT DISTINCT debug_id FROM ${database}.runtime_source_maps
			WHERE org_id = {org:String} AND repository_id = {repo:String}
				AND has({debugIds:Array(String)}, debug_id)`,
		query_params: { org: tenant.orgId, repo: tenant.repositoryId, debugIds: [...new Set(debugIds)] },
		format: "JSONEachRow",
	});
	return new Set((await rows.json<{ debug_id: string }>()).map((row) => row.debug_id));
}

async function presentByHash(
	client: ClickHouseClient,
	database: string,
	tenant: { orgId: string; repositoryId: string },
	check: SourceMapCheck,
): Promise<Set<string>> {
	const rows = await client.query({
		query: `SELECT DISTINCT filename, debug_id, content_hash FROM ${database}.runtime_source_maps
			WHERE org_id = {org:String} AND repository_id = {repo:String} AND release = {release:String}
				AND has({hashes:Array(String)}, content_hash)
				AND uploaded_at >= now64(3) - INTERVAL ${SOURCE_MAP_FRESH_DAYS} DAY`,
		query_params: {
			org: tenant.orgId,
			repo: tenant.repositoryId,
			release: check.release,
			hashes: [...new Set(check.entries.filter((entry) => entry.hash).map((entry) => entry.hash))],
		},
		format: "JSONEachRow",
	});
	return new Set(
		(await rows.json<{ filename: string; debug_id: string; content_hash: string }>()).map(
			(row) => `${row.filename}\u0000${row.debug_id}\u0000${row.content_hash}`,
		),
	);
}
