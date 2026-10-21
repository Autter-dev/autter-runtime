import type { Request } from "express";
import { INGESTER_VERSION_HEADER } from "./compat.js";
import { defaultScopeFor, isIngestKeyScope, type IngesterConfig } from "./config.js";
import { ingesterVersion } from "./sdk-versions.js";
import type { IngestContext } from "./types.js";

/**
 * Ingest-key authentication. Keys arrive as `Authorization: Bearer <key>`
 * or `x-autter-key: <key>` and resolve to a tenant {orgId, repositoryId}
 * via a static env mapping (self-host) or a validator webhook (cloud),
 * with a short in-process cache in front of the webhook.
 *
 * Scopes: "server", "client" or "upload" (see IngestContext). A key whose
 * entry or validator answer names no scope gets defaultScopeFor(key); one
 * that names a scope this ingester doesn't know is refused, never treated
 * as a server key.
 */

interface CacheEntry {
	ctx: IngestContext | null;
	/** Why `ctx` is null: the validator said no, or could not answer (5xx). */
	failure?: KeyFailure;
	expiresAt: number;
}

/**
 * Why a key did not resolve: `unknown_key` — not a static key and the
 * validator did not accept it; `key_unverified` — the validator could not
 * answer (unreachable, timed out or a 5xx) and no earlier answer was cached.
 */
export type KeyFailure = "unknown_key" | "key_unverified";

export type KeyResolution =
	| { ctx: IngestContext; failure?: undefined }
	| { ctx: null; failure: KeyFailure };

const VALIDATOR_CACHE_TTL_MS = 60_000;

export class KeyResolver {
	private readonly staticKeys = new Map<string, IngestContext>();
	private readonly cache = new Map<string, CacheEntry>();

	constructor(private readonly config: IngesterConfig) {
		for (const entry of config.ingestKeys) {
			const scope = entry.scope ?? defaultScopeFor(entry.key);
			if (!isIngestKeyScope(scope)) continue;
			this.staticKeys.set(entry.key, {
				orgId: entry.orgId,
				repositoryId: entry.repositoryId,
				scope,
				allowedOrigins: entry.allowedOrigins ?? [],
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
		// Query param — the only channel available to navigator.sendBeacon
		// (it cannot set headers). Intended for publishable client keys.
		const q = req.query.key;
		if (typeof q === "string" && q.trim()) return q.trim();
		return null;
	}

	async resolve(key: string): Promise<IngestContext | null> {
		return (await this.resolveDetailed(key)).ctx;
	}

	/** `resolve`, plus why a key that did not resolve failed (for drop counts). */
	async resolveDetailed(key: string): Promise<KeyResolution> {
		const staticCtx = this.staticKeys.get(key);
		if (staticCtx) return { ctx: staticCtx };
		if (!this.config.keyValidatorUrl) return { ctx: null, failure: "unknown_key" };

		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) return resolution(cached);

		let ctx: IngestContext | null = null;
		let failure: KeyFailure = "unknown_key";
		try {
			const response = await fetch(this.config.keyValidatorUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					// Lets the validator tell which scopes this ingester enforces:
					// before 1.7.0 any scope but "client" meant a server key, so an
					// upload key must not be answered as "upload" to an ingester
					// that doesn't send this header (or sends an older version).
					[INGESTER_VERSION_HEADER]: ingesterVersion(),
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
					scope?: unknown;
					allowedOrigins?: string[];
				};
				const scope = body.scope === undefined || body.scope === null ? defaultScopeFor(key) : body.scope;
				if (body.orgId && body.repositoryId && isIngestKeyScope(scope)) {
					ctx = {
						orgId: body.orgId,
						repositoryId: body.repositoryId,
						scope,
						allowedOrigins: body.allowedOrigins ?? [],
					};
				}
			} else if (response.status >= 500) {
				failure = "key_unverified";
			}
		} catch {
			// Validator unreachable: fail closed for unknown keys, but reuse a
			// stale cache entry if we have one so transient validator outages
			// don't drop telemetry from known-good keys.
			if (cached) return resolution(cached);
			return { ctx: null, failure: "key_unverified" };
		}
		const entry: CacheEntry = { ctx, expiresAt: Date.now() + VALIDATOR_CACHE_TTL_MS, ...(ctx ? {} : { failure }) };
		this.cache.set(key, entry);
		if (this.cache.size > 10_000) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		return resolution(entry);
	}
}

function resolution(entry: CacheEntry): KeyResolution {
	return entry.ctx ? { ctx: entry.ctx } : { ctx: null, failure: entry.failure ?? "unknown_key" };
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
