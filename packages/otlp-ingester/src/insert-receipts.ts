import { createHash } from "node:crypto";

/**
 * Which tables an ingest request already wrote (1.12).
 *
 * One request fans out to several ClickHouse inserts with no transaction
 * across them. When one fails the request answers 503 and the exporter
 * retries the whole body — re-inserting the rows that did commit. For
 * runtime_metrics_1m (SummingMergeTree) and runtime_spans that inflated
 * request, error and regression counts.
 *
 * Two layers stop that:
 * - every fan-out insert carries `insert_deduplication_token` =
 *   `<request digest>:<table>`, so ClickHouse drops a block it already has
 *   (clickhouse.ts; needs a dedupe window on the table, set at boot);
 * - this receipt book: per request digest, the tables whose insert
 *   committed. A retry that reaches the same process skips them outright,
 *   whatever the ClickHouse version or engine does with the token.
 *
 * The digest covers the tenant, the route and the exact body, so only a
 * byte-identical re-send matches — two exports with equal content but
 * different timestamps never do. Bounded (oldest evicted) and short-lived:
 * exporters retry within minutes.
 */
export class InsertReceipts {
	private readonly entries = new Map<string, { at: number; tables: Set<string> }>();

	constructor(
		private readonly maxEntries = 10_000,
		private readonly ttlMs = 15 * 60_000,
		private readonly now: () => number = Date.now,
	) {}

	/** Tables already written for this request digest. */
	committed(digest: string): ReadonlySet<string> {
		const entry = this.entries.get(digest);
		if (!entry) return new Set();
		if (this.now() - entry.at > this.ttlMs) {
			this.entries.delete(digest);
			return new Set();
		}
		return entry.tables;
	}

	/** Record that `table` committed for this request digest. */
	add(digest: string, table: string): void {
		const entry = this.entries.get(digest);
		if (entry) {
			entry.tables.add(table);
			return;
		}
		this.entries.set(digest, { at: this.now(), tables: new Set([table]) });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	get size(): number {
		return this.entries.size;
	}
}

/** Digest of one ingest request: tenant, route and the exact body. */
export function requestDigest(
	tenant: { orgId: string; repositoryId: string },
	path: string,
	body: unknown,
): string {
	const hash = createHash("sha256");
	hash.update(`${tenant.orgId}\u0000${tenant.repositoryId}\u0000${path.toLowerCase()}\u0000`);
	if (Buffer.isBuffer(body)) hash.update(body);
	else if (typeof body === "string") hash.update(body);
	else hash.update(JSON.stringify(body ?? null));
	return hash.digest("hex").slice(0, 40);
}
