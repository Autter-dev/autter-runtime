import type { Request } from "express";
import { INGESTER_VERSION_HEADER } from "./compat.js";
import { defaultScopeFor, isIngestKeyScope, LOCAL_DEV_KEY, type IngesterConfig } from "./config.js";
import { ingesterVersion } from "./sdk-versions.js";
import { parseSuppressionRules } from "./suppression.js";
import type { IngestContext } from "./types.js";
import { LruMap } from "./limits.js";

/**
 * Ingest-key authentication. Keys arrive as `Authorization: Bearer <key>`
 * or `x-autter-key: <key>` (or `?key=`, for client keys only: see
 * extractKeyWithSource) and resolve to a tenant {orgId, repositoryId}
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
 *
 * Validator answers (1.12.0):
 *  - 2xx with a tenant: the key is valid. Cached for 60 s, and kept as the
 *    last good answer for up to 15 min in case the validator goes down.
 *  - 2xx without a usable tenant, 404 or 410: the key is definitely
 *    invalid. Cached for 60 s; the ingester answers 401. Nothing else
 *    produces a 401 for a key that was sent.
 *  - Anything else (5xx, 429, another 4xx such as a wrong validator token,
 *    an unreadable body, a timeout, a network error): the validator could
 *    not answer. Nothing negative is cached. The key's last good answer is
 *    used while it is under the stale cap; otherwise the ingester answers
 *    503 with Retry-After, which OTLP exporters retry, instead of a 401
 *    they treat as permanent. The validator is not asked again for that key
 *    for VALIDATOR_RETRY_MS, so an outage doesn't add a 5 s timeout to
 *    every request.
 */

interface CacheEntry {
	/**
	 * The validator's last definite answer and when it was given: a tenant,
	 * or null for "invalid key". Absent when it has never answered.
	 */
	answer?: { ctx: IngestContext | null; at: number };
	/** Don't ask the validator about this key again before this time. */
	nextCheckAt: number;
}

/**
 * Why a key did not resolve: `unknown_key` — not a static key and the
 * validator definitely refused it (401); `key_unverified` — the validator
 * could not answer and there is no good answer recent enough to use (503);
 * `lookup_limited` — the key is not cached and the unknown-key budget (per
 * client address, and for the whole ingester) is spent, so the validator was
 * not asked (answered 429: the exporter retries).
 */
export type KeyFailure = "unknown_key" | "key_unverified" | "lookup_limited";

export type KeyResolution =
	| { ctx: IngestContext; failure?: undefined }
	| { ctx: null; failure: "unknown_key" | "lookup_limited" }
	/** `retryAfterSeconds`: when the validator will be asked again (for Retry-After). */
	| { ctx: null; failure: "key_unverified"; retryAfterSeconds: number };

/** How long a definite validator answer is used before asking again. */
export const VALIDATOR_CACHE_TTL_MS = 60_000;
/** How long after it was given a valid answer may still be used while the validator can't answer. */
export const VALIDATOR_STALE_CAP_MS = 15 * 60_000;
/** After the validator failed to answer for a key, how long before asking again. */
export const VALIDATOR_RETRY_MS = 5_000;
/** At most one "validator unavailable" log line per this interval. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

type ValidatorAnswer = { kind: "valid"; ctx: IngestContext } | { kind: "invalid" } | { kind: "unavailable"; reason: string };

/** Asked before a key that is in neither cache goes to the validator; false = don't ask. */
export type LookupGate = () => boolean | Promise<boolean>;

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
	/** Validator answers that named a tenant. Kept past expiry (LRU) so an outage can fall back to them (under the stale cap). */
	private readonly known: LruMap<string, CacheEntry>;
	/** Validator refusals, and failures for keys with no good answer: a separate LRU, so junk keys only ever evict each other. */
	private readonly unknown: LruMap<string, CacheEntry>;
	private readonly now: () => number;
	/** One validator call per key at a time: concurrent requests for the same key share it. */
	private readonly inflight = new Map<string, Promise<KeyResolution>>();
	/** Validator calls made (for tests and stats). */
	validatorCalls = 0;
	private lastFailureLogAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly config: IngesterConfig,
		options: KeyResolverOptions = {},
	) {
		this.known = new LruMap(options.knownKeys ?? KNOWN_KEYS_MAX);
		this.unknown = new LruMap(options.unknownKeys ?? UNKNOWN_KEYS_MAX);
		this.now = options.now ?? Date.now;
		for (const entry of config.ingestKeys) {
			// The built-in local key works only in local dev mode, however the
			// config was built (config.ts withLocalDevKey adds and strips it).
			if (entry.key === LOCAL_DEV_KEY && !config.localDev) continue;
			const scope = entry.scope ?? defaultScopeFor(entry.key);
			if (!isIngestKeyScope(scope)) continue;
			const suppression = parseSuppressionRules(entry.suppression);
			if (Array.isArray(entry.suppression) && suppression.length < entry.suppression.length) {
				console.error(
					`AUTTER_INGEST_KEYS: ${entry.suppression.length - suppression.length} invalid suppression rule(s) for repository ${entry.repositoryId} ignored`,
				);
			}
			if (scope === "client" && !entry.allowedOrigins?.length) {
				console.error(
					`AUTTER_INGEST_KEYS: client key for repository ${entry.repositoryId} has no allowedOrigins, so it accepts no browser origin — list your site's exact origins`,
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
		return extractKeyWithSource(req)?.key ?? null;
	}

	/**
	 * What is already known about a key, without asking the validator: a
	 * static key, or a cached answer (a stale positive one too). Used to
	 * attribute refusals made before a route ran (404s, unparseable bodies),
	 * which must never cost a validator call.
	 */
	peek(key: string): IngestContext | null {
		return this.staticKeys.get(key) ?? this.known.peek(key)?.answer?.ctx ?? null;
	}

	async resolve(key: string): Promise<IngestContext | null> {
		return (await this.resolveDetailed(key)).ctx;
	}

	/**
	 * `resolve`, plus why a key that did not resolve failed (for drop counts and the status).
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
		if (known && known.nextCheckAt > now) return this.fromEntry(known);
		const unknown = this.unknown.get(key);
		if (unknown && unknown.nextCheckAt > now) return this.fromEntry(unknown);

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
		const answer = await this.askValidator(this.config.keyValidatorUrl!, key);
		const now = this.now();
		if (answer.kind === "unavailable") {
			this.logFailure(answer.reason);
			// Keep the last definite answer (fromEntry decides whether it may
			// still be used); never record the failure as an answer.
			const entry: CacheEntry = {
				...(cached?.answer ? { answer: cached.answer } : {}),
				nextCheckAt: now + VALIDATOR_RETRY_MS,
			};
			if (entry.answer?.ctx) this.known.set(key, entry);
			else this.unknown.set(key, entry);
			return this.fromEntry(entry);
		}
		const entry: CacheEntry = {
			answer: { ctx: answer.kind === "valid" ? answer.ctx : null, at: now },
			nextCheckAt: now + VALIDATOR_CACHE_TTL_MS,
		};
		if (answer.kind === "valid") {
			this.known.set(key, entry);
			this.unknown.delete(key);
		} else {
			// A key the validator now refuses (revoked) leaves the known cache:
			// an outage must not bring it back.
			this.known.delete(key);
			this.unknown.set(key, entry);
		}
		return this.fromEntry(entry);
	}

	/**
	 * What a cache entry says now: a fresh answer as given; a valid answer
	 * past its TTL (the validator could not answer since) while it is under
	 * the stale cap; otherwise key_unverified. A refusal past its TTL is not
	 * reused: the key might have been created since.
	 */
	private fromEntry(entry: CacheEntry): KeyResolution {
		const now = this.now();
		const answer = entry.answer;
		if (answer) {
			const age = now - answer.at;
			if (answer.ctx && age < VALIDATOR_STALE_CAP_MS) return { ctx: answer.ctx };
			if (!answer.ctx && age < VALIDATOR_CACHE_TTL_MS) return { ctx: null, failure: "unknown_key" };
		}
		return {
			ctx: null,
			failure: "key_unverified",
			retryAfterSeconds: Math.max(1, Math.ceil((entry.nextCheckAt - now) / 1000)),
		};
	}

	private async askValidator(url: string, key: string): Promise<ValidatorAnswer> {
		let response: globalThis.Response;
		try {
			response = await fetch(url, {
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
		} catch (err) {
			return { kind: "unavailable", reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
		}
		if (response.status === 404 || response.status === 410) {
			await response.body?.cancel().catch(() => {});
			return { kind: "invalid" };
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return { kind: "unavailable", reason: `HTTP ${response.status}` };
		}
		let body: {
			orgId?: string;
			repositoryId?: string;
			scope?: unknown;
			allowedOrigins?: string[];
			suppression?: unknown;
		};
		try {
			body = (await response.json()) as typeof body;
		} catch (err) {
			return { kind: "unavailable", reason: `unreadable answer (${err instanceof Error ? err.message : String(err)})` };
		}
		if (!body || typeof body !== "object") return { kind: "invalid" };
		const scope = body.scope === undefined || body.scope === null ? defaultScopeFor(key) : body.scope;
		if (!body.orgId || !body.repositoryId || !isIngestKeyScope(scope)) return { kind: "invalid" };
		const suppression = parseSuppressionRules(body.suppression);
		return {
			kind: "valid",
			ctx: {
				orgId: body.orgId,
				repositoryId: body.repositoryId,
				scope,
				allowedOrigins: body.allowedOrigins ?? [],
				...(suppression.length ? { suppression } : {}),
			},
		};
	}

	private logFailure(reason: string): void {
		const now = this.now();
		if (now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
		this.lastFailureLogAt = now;
		console.warn(
			`key validator could not answer (${reason}): serving cached keys for up to ${VALIDATOR_STALE_CAP_MS / 60_000} min, 503 for the rest`,
		);
	}
}

/**
 * Where a request's key came from. `query` is `?key=`: the only channel
 * navigator.sendBeacon has (it cannot set headers), so it is for
 * publishable client keys only. A URL ends up in proxy, CDN and access
 * logs, so the server refuses any other scope sent this way
 * (server.ts `authenticate`).
 */
export type KeySource = "authorization" | "x-autter-key" | "query";

/** The request's key and where it came from; headers win over `?key=`. */
export function extractKeyWithSource(req: Request): { key: string; source: KeySource } | null {
	const header = req.headers.authorization;
	if (header?.toLowerCase().startsWith("bearer ")) {
		const key = header.slice(7).trim();
		return key ? { key, source: "authorization" } : null;
	}
	const alt = req.headers["x-autter-key"];
	if (typeof alt === "string" && alt.trim()) return { key: alt.trim(), source: "x-autter-key" };
	const q = req.query.key;
	if (typeof q === "string" && q.trim()) return { key: q.trim(), source: "query" };
	return null;
}

/**
 * `url` with the value of every `key` query parameter replaced by
 * `[redacted]`, so nothing that logs a request URL can log a key. Leaves
 * a URL without one untouched (same string).
 */
export function redactKeyFromUrl(url: string): string {
	const q = url.indexOf("?");
	if (q < 0) return url;
	const hash = url.indexOf("#", q);
	const end = hash < 0 ? url.length : hash;
	const params = url.slice(q + 1, end).split("&");
	let changed = false;
	const redacted = params.map((param) => {
		const eq = param.indexOf("=");
		const name = eq < 0 ? param : param.slice(0, eq);
		let decoded = name;
		try {
			decoded = decodeURIComponent(name.replace(/\+/g, " "));
		} catch {
			// a malformed name is compared as written
		}
		if (decoded !== "key" || eq < 0) return param;
		changed = true;
		return `${name}=[redacted]`;
	});
	return changed ? `${url.slice(0, q + 1)}${redacted.join("&")}${url.slice(end)}` : url;
}
