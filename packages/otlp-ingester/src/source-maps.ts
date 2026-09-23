export function sourceMapTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_source_maps (
		org_id String, repository_id String, release String, filename String,
		map String CODEC(ZSTD(3)), uploaded_at DateTime64(3, 'UTC') DEFAULT now64(3)
	) ENGINE = ReplacingMergeTree(uploaded_at)
	ORDER BY (org_id, repository_id, release, filename)
	TTL toDateTime(uploaded_at) + INTERVAL 30 DAY`;
}

export function validateSourceMap(body: unknown): { release: string; filename: string; map: string } | null {
	if (!body || typeof body !== "object") return null;
	const input = body as Record<string, unknown>;
	if (typeof input.release !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(input.release)) return null;
	if (typeof input.filename !== "string" || input.filename.length > 1000) return null;
	let filename: string;
	try { filename = new URL(input.filename, "https://autter.invalid").pathname; } catch { return null; }
	if (!filename.endsWith(".js")) return null;
	let parsed: Record<string, unknown>;
	try { parsed = typeof input.map === "string" ? JSON.parse(input.map) : input.map as Record<string, unknown>; }
	catch { return null; }
	if (!parsed || parsed.version !== 3 || typeof parsed.mappings !== "string" || !Array.isArray(parsed.sources)) return null;
	// Source contents are unnecessary for position lookup and may contain secrets.
	const { sourcesContent: _omitted, ...safe } = parsed;
	const map = JSON.stringify(safe);
	if (map.length > 5 * 1024 * 1024) return null;
	return { release: input.release, filename, map };
}
