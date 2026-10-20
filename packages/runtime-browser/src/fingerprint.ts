/**
 * Fingerprint override. Errors that carry the same fingerprint group into one
 * issue, whatever their message or stack:
 *
 *   captureException(err, { fingerprint: ["checkout", "card-timeout"] });
 *
 * or set `event.fingerprint` on any event in `beforeSend`. A string, or up to
 * 10 strings of at most 200 characters each (longer values are cut, extra
 * values dropped). The relay and the ingester scrub and bound it again.
 * Ingester 1.6.0+ groups by it (`manual-v1`); older ingesters ignore it.
 *
 * Kept out of index.ts so the tracker's hot path stays small (size-limit).
 */
export type Fingerprint = string | string[];

/** Move `fingerprint` from captureException's context onto the event. */
export function takeFingerprint(
	event: { fingerprint?: Fingerprint },
	context: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const { fingerprint, ...rest } = context || {};
	if (fingerprint != null) event.fingerprint = fingerprint as Fingerprint;
	return rest;
}
