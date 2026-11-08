import { createHash } from "node:crypto";
import { LruMap } from "./limits.js";

/**
 * The last accepted and the last refused ingest request per key,
 * kept in memory by this process. It answers "did my last batch get in,
 * and if not, why?" for whoever holds the key: `GET /v1/verify` returns
 * the caller's own record, never anyone else's. Keyed by the sha256 of the
 * key, so no key is held in memory past the request.
 *
 * Per process: behind several replicas each one knows only what it saw.
 * Nothing here is written to ClickHouse (the per-minute drop counts are).
 */

export interface DeliveryOutcome {
	route: string;
	status: number;
	at: string;
	/** Refusals: the drop reason (`unknown_key`, `invalid_payload`, …). */
	reason?: string;
	/** Refusals: the error the client was sent. */
	error?: string;
	/** Accepted: what was stored (x-autter-ingest). */
	accepted?: Record<string, number>;
}

export interface DeliveryRecord {
	lastAccepted: DeliveryOutcome | null;
	lastRejected: DeliveryOutcome | null;
	accepted: number;
	rejected: number;
	since: string;
}

export function deliveryKeyHash(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

export class DeliveryLog {
	private readonly records: LruMap<string, DeliveryRecord>;

	constructor(maxKeys = 20_000, private readonly now: () => number = Date.now) {
		this.records = new LruMap(maxKeys);
	}

	private entry(keyHash: string): DeliveryRecord {
		let record = this.records.get(keyHash);
		if (!record) {
			record = { lastAccepted: null, lastRejected: null, accepted: 0, rejected: 0, since: new Date(this.now()).toISOString() };
			this.records.set(keyHash, record);
		}
		return record;
	}

	accepted(keyHash: string, outcome: Omit<DeliveryOutcome, "at">): void {
		const record = this.entry(keyHash);
		record.accepted += 1;
		record.lastAccepted = { ...outcome, at: new Date(this.now()).toISOString() };
	}

	rejected(keyHash: string, outcome: Omit<DeliveryOutcome, "at">): void {
		const record = this.entry(keyHash);
		record.rejected += 1;
		record.lastRejected = { ...outcome, at: new Date(this.now()).toISOString() };
	}

	get(keyHash: string): DeliveryRecord | null {
		return this.records.get(keyHash) ?? null;
	}
}

/** `x-autter-ingest`: what one accepted request stored, `name=count` pairs. */
export function ingestSummaryHeader(counts: Record<string, number>): string {
	return Object.entries(counts)
		.filter(([, value]) => Number.isFinite(value))
		.map(([name, value]) => `${name}=${Math.max(0, Math.round(value))}`)
		.join(" ");
}

/** The resource attribute a `verify` test request carries on every resource. */
export const VERIFY_ATTRIBUTE = "autter.verify.id";
const VERIFY_ID = /^[a-f0-9]{32}$/;

/**
 * The verify id when EVERY resource in an OTLP request carries
 * `autter.verify.id` (a 32-hex trace id); null otherwise. A request that
 * mixes test and real resources is treated as real.
 */
export function verifyIdOf(request: unknown, resourcesField: "resourceSpans" | "resourceLogs"): string | null {
	const resources = (request as Record<string, unknown> | null)?.[resourcesField];
	if (!Array.isArray(resources) || resources.length === 0) return null;
	let id: string | null = null;
	for (const resource of resources) {
		const attributes = (resource as { resource?: { attributes?: unknown } })?.resource?.attributes;
		if (!Array.isArray(attributes)) return null;
		const attribute = attributes.find((a) => (a as { key?: unknown })?.key === VERIFY_ATTRIBUTE) as
			| { value?: { stringValue?: unknown } }
			| undefined;
		const value = attribute?.value?.stringValue;
		if (typeof value !== "string" || !VERIFY_ID.test(value)) return null;
		if (id !== null && id !== value) return null;
		id = value;
	}
	return id;
}
