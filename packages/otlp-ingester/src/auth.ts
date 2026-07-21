import type { Request } from "express";
import type { IngesterConfig } from "./config.js";
import type { IngestContext } from "./types.js";

/**
 * Ingest-key authentication. Keys arrive as `Authorization: Bearer <key>`
 * or `x-autter-key: <key>` and resolve to a tenant {orgId, repositoryId}
 * via a static env mapping (self-host) or a validator webhook (cloud),
 * with a short in-process cache in front of the webhook.
 */

interface CacheEntry {
	ctx: IngestContext | null;
	expiresAt: number;
}

const VALIDATOR_CACHE_TTL_MS = 60_000;

export class KeyResolver {
	private readonly staticKeys = new Map<string, IngestContext>();
	private readonly cache = new Map<string, CacheEntry>();

	constructor(private readonly config: IngesterConfig) {
		for (const entry of config.ingestKeys) {
			this.staticKeys.set(entry.key, {
				orgId: entry.orgId,
				repositoryId: entry.repositoryId,
			});
		}
	}

	extractKey(req: Request): string | null {
		const header = req.headers.authorization;
		if (header?.toLowerCase().startsWith("bearer ")) {
			return header.slice(7).trim() || null;
		}
		const alt = req.headers["x-autter-key"];
		if (typeof alt === "string" && alt.trim()) return alt.trim();
		return null;
	}

	async resolve(key: string): Promise<IngestContext | null> {
		const staticCtx = this.staticKeys.get(key);
		if (staticCtx) return staticCtx;
		if (!this.config.keyValidatorUrl) return null;

		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.ctx;

		let ctx: IngestContext | null = null;
		try {
			const response = await fetch(this.config.keyValidatorUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.config.keyValidatorToken
						? { authorization: `Bearer ${this.config.keyValidatorToken}` }
						: {}),
				},
				body: JSON.stringify({ key }),
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				const body = (await response.json()) as {
					orgId?: string;
					repositoryId?: string;
				};
				if (body.orgId && body.repositoryId) {
					ctx = { orgId: body.orgId, repositoryId: body.repositoryId };
				}
			}
		} catch {
			// Validator unreachable: fail closed for unknown keys, but reuse a
			// stale cache entry if we have one so transient validator outages
			// don't drop telemetry from known-good keys.
			if (cached) return cached.ctx;
			return null;
		}
		this.cache.set(key, { ctx, expiresAt: Date.now() + VALIDATOR_CACHE_TTL_MS });
		if (this.cache.size > 10_000) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		return ctx;
	}
}

/** Fixed-window per-key rate limiter (single-node; Redis backing is M1). */
export class RateLimiter {
	private windows = new Map<string, { windowStart: number; count: number }>();

	constructor(private readonly limitPerMinute: number) {}

	allow(key: string): boolean {
		const now = Date.now();
		const windowStart = Math.floor(now / 60_000) * 60_000;
		const entry = this.windows.get(key);
		if (!entry || entry.windowStart !== windowStart) {
			this.windows.set(key, { windowStart, count: 1 });
			if (this.windows.size > 50_000) this.windows.clear();
			return true;
		}
		entry.count += 1;
		return entry.count <= this.limitPerMinute;
	}
}
