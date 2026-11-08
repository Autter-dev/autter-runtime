import type { Request } from "express";
import { INGESTER_VERSION_HEADER } from "./compat.js";
import { defaultScopeFor, isIngestKeyScope, type IngesterConfig } from "./config.js";
import { ingesterVersion } from "./sdk-versions.js";
import { parseSuppressionRules } from "./suppression.js";
import type { IngestContext } from "./types.js";
import { LruMap } from "./limits.js";

/**
 * Ingest-key authentication. Keys arrive as `Authorization: Bearer <key>`
 * or `x-autter-key: <key>` and resolve to a tenant {orgId, repositoryId}
 * via a static env mapping (self-host) or a validator webhook (cloud),
 * with a short in-process cache in front of the webhook.
 *
 * Lookups (1.12.0): accepted keys and refused keys are cached apart (two
 * LRUs), so junk keys never evict a known-good one; concurrent requests for
 * the same key share one validator call; a key in neither cache only goes
 * to the validator when the caller's gate allows it (the unknown-key
 * budget, see server.ts); and a key that can't be one (over 512 chars,
 * spaces, control characters) is refused without a call.
 *
 * Scopes: "server", "client" or "upload" (see IngestContext). A key whose
 * entry or validator answer names no scope gets defaultScopeFor(key); one
 * that names a scope this ingester doesn't know is refused, never treated
 * as a server key.
 *
 * Suppression rules (1.9.0) come with the key: the validator's
 * `suppression` array, or a static entry's, parsed by suppression.ts and
 * cached with the key, so a rule change reaches the ingester within the
 * cache TTL (60 s). Validators before 1.9.0 send none: nothing suppressed.
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
 * answer (unreachable, timed out or a 5xx) and no earlier answer was cached;
 * `lookup_limited` — the key is not cached and the unknown-key budget (per
 * client address, and for the whole ingester) is spent, so the validator was
 * not asked (answered 429: the exporter retries).
 */
export type KeyFailure = "unknown_key" | "key_unverified" | "lookup_limited";

export type KeyResolution =
	| { ctx: IngestContext; failure?: undefined }
	| { ctx: null; failure: KeyFailure };

/** Asked before a key that is in neither cache goes to the validator; false = don't ask. */
export type LookupGate = () => boolean | Promise<boolean>;

const VALIDATOR_CACHE_TTL_MS = 60_000;

/** Keys the validator accepted (fresh or stale). Junk keys never enter it, so they can't evict these. */
const KNOWN_KEYS_MAX = 10_000;
/** Keys the validator refused or could not answer for. Bounded on its own. */
const UNKNOWN_KEYS_MAX = 50_000;
/** Longer than any key Autter issues (58 chars) or a static key needs: never sent to the validator. */
const MAX_KEY_LENGTH = 512;
/** Printable ASCII without spaces: anything else is not a key. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

export interface KeyResolverOptions {
	/** Accepted keys cached (default 10,000). */
	knownKeys?: number;
	/** Refused keys cached (default 50,000). */
	unknownKeys?: number;
	now?: () => number;
}

export class KeyResolver {
	private readonly staticKeys = new Map<string, IngestContext>();
	/** Validator answers that named a tenant. Kept past expiry (LRU) so an outage can fall back to them. */
	private readonly known: LruMap<string, CacheEntry>;
	/** Validator refusals and failures: a separate LRU, so junk keys only ever evict each other. */
	private readonly unknown: LruMap<string, CacheEntry>;
	private readonly now: () => number;
	/** One validator call per key at a time: concurrent requests for the same key share it. */
	private readonly inflight = new Map<string, Promise<KeyResolution>>();
	/** Validator calls made (for tests and stats). */
	validatorCalls = 0;

	constructor(
		private readonly config: IngesterConfig,
		options: KeyResolverOptions = {},
	) {
		this.known = new LruMap(options.knownKeys ?? KNOWN_KEYS_MAX);
		this.unknown = new LruMap(options.unknownKeys ?? UNKNOWN_KEYS_MAX);
		this.now = options.now ?? Date.now;
		for (const entry of config.ingestKeys) {
			const scope = entry.scope ?? defaultScopeFor(entry.key);
			if (!isIngestKeyScope(scope)) continue;
			const suppression = parseSuppressionRules(entry.suppression);
			if (Array.isArray(entry.suppression) && suppression.length < entry.suppression.length) {
				console.error(
					`AUTTER_INGEST_KEYS: ${entry.suppression.length - suppression.length} invalid suppression rule(s) for repository ${entry.repositoryId} ignored`,
				);
			}
			this.staticKeys.set(entry.key, {
				orgId: entry.orgId,
				repositoryId: entry.repositoryId,
				scope,
				allowedOrigins: entry.allowedOrigins ?? [],
				...(suppression.length ? { suppression } : {}),
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

	/**
	 * What is already known about a key, without asking the validator: a
	 * static key, or a cached answer (a stale positive one too). Used to
	 * attribute refusals made before a route ran (404s, unparseable bodies),
	 * which must never cost a validator call.
	 */
	peek(key: string): IngestContext | null {
		return this.staticKeys.get(key) ?? this.known.peek(key)?.ctx ?? null;
	}

	async resolve(key: string): Promise<IngestContext | null> {
		return (await this.resolveDetailed(key)).ctx;
	}

	/**
	 * `resolve`, plus why a key that did not resolve failed (for drop counts).
	 * `gate` is asked only when the validator would be called for a key that
	 * is in neither cache (a known key being refreshed is never gated): it
	 * spends the unknown-key budget.
	 */
	async resolveDetailed(key: string, gate?: LookupGate): Promise<KeyResolution> {
		const staticCtx = this.staticKeys.get(key);
		if (staticCtx) return { ctx: staticCtx };
		if (!this.config.keyValidatorUrl) return { ctx: null, failure: "unknown_key" };
		if (key.length > MAX_KEY_LENGTH || !KEY_SHAPE.test(key)) return { ctx: null, failure: "unknown_key" };

		const now = this.now();
		const known = this.known.get(key);
		if (known && known.expiresAt > now) return resolution(known);
		const unknown = this.unknown.get(key);
		if (unknown && unknown.expiresAt > now) return resolution(unknown);

		// Requests that arrive while this key is being looked up (or gated)
		// share the outcome: one gate check, at most one validator call.
		const pending = this.inflight.get(key);
		if (pending) return pending;
		const lookup = (async (): Promise<KeyResolution> => {
			// Refreshing a key the validator accepted before is never budgeted.
			if (!known && gate && !(await gate())) return { ctx: null, failure: "lookup_limited" };
			return this.lookup(key, known ?? unknown);
		})().finally(() => this.inflight.delete(key));
		this.inflight.set(key, lookup);
		return lookup;
	}

	private async lookup(key: string, cached: CacheEntry | undefined): Promise<KeyResolution> {
		this.validatorCalls += 1;
		let ctx: IngestContext | null = null;
		let failure: KeyFailure = "unknown_key";
		try {
			const response = await fetch(this.config.keyValidatorUrl!, {
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
					suppression?: unknown;
				};
				const scope = body.scope === undefined || body.scope === null ? defaultScopeFor(key) : body.scope;
				if (body.orgId && body.repositoryId && isIngestKeyScope(scope)) {
					const suppression = parseSuppressionRules(body.suppression);
					ctx = {
						orgId: body.orgId,
						repositoryId: body.repositoryId,
						scope,
						allowedOrigins: body.allowedOrigins ?? [],
						...(suppression.length ? { suppression } : {}),
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
		const entry: CacheEntry = { ctx, expiresAt: this.now() + VALIDATOR_CACHE_TTL_MS, ...(ctx ? {} : { failure }) };
		if (ctx) {
			this.known.set(key, entry);
			this.unknown.delete(key);
		} else {
			// A key the validator now refuses (revoked) leaves the known cache:
			// an outage must not bring it back.
			this.known.delete(key);
			this.unknown.set(key, entry);
		}
		return resolution(entry);
	}
}

function resolution(entry: CacheEntry): KeyResolution {
	return entry.ctx ? { ctx: entry.ctx } : { ctx: null, failure: entry.failure ?? "unknown_key" };
}
