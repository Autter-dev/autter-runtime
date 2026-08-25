/**
 * Setup-time self-test: proves the configured ingest key is actually
 * accepted by the ingester before any real telemetry depends on it.
 *
 * The probe POSTs a well-formed batch with zero events. A valid key gets
 * `202 {"accepted":0}` — the ingester authenticates first and writes
 * nothing for an empty batch, so validation has no data side effects. An
 * invalid key is refused with 401/403 and the ingester's own reason.
 */

export interface IngestKeyVerification {
	/**
	 * true when the key itself was accepted (including "valid but currently
	 * rate limited"). false means rejected or unverifiable — see message.
	 */
	ok: boolean;
	/** HTTP status from the ingester, when one was reached. */
	status?: number;
	/** Human-readable verdict, safe to log or surface in onboarding UIs. */
	message: string;
}

export interface VerifyIngestKeyOptions {
	/** Private ingest key (autter_rt_…) to check. */
	apiKey: string;
	/** Ingester base URL. Default: https://otlp.autter.dev */
	endpoint?: string;
}

const DEFAULT_ENDPOINT = "https://otlp.autter.dev";

async function rejectionReason(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: unknown } | null;
		if (typeof body?.error === "string" && body.error) {
			return body.error.slice(0, 200);
		}
	} catch {
		// Non-JSON error page from a proxy — ignore.
	}
	return undefined;
}

/**
 * Check an ingest key against the ingester without writing anything.
 *
 *   const check = await verifyIngestKey({ apiKey: process.env.AUTTER_RUNTIME_KEY! });
 *   if (!check.ok) console.warn("Autter setup problem:", check.message);
 *
 * Verdicts:
 * - 2xx            → key accepted (`ok: true`)
 * - 429            → key accepted but throttled right now (`ok: true`)
 * - 401/403        → key rejected; `message` carries the ingester's reason
 * - other / network → inconclusive (`ok: false`, status when available)
 */
export async function verifyIngestKey(
	options: VerifyIngestKeyOptions,
): Promise<IngestKeyVerification> {
	const url = `${(options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "")}/v1/browser`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${options.apiKey}`,
			},
			body: JSON.stringify({
				version: 1,
				service: "setup-check",
				environment: "setup-check",
				events: [],
			}),
			signal: AbortSignal.timeout(5000),
		});
	} catch (err) {
		return {
			ok: false,
			message: `could not reach the ingester at ${url} (${String(err)})`,
		};
	}
	if (response.ok) {
		return { ok: true, status: response.status, message: "ingest key accepted" };
	}
	const reason = await rejectionReason(response);
	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			status: response.status,
			message: reason ?? "ingest key rejected",
		};
	}
	if (response.status === 429) {
		// Rate limiting runs after key resolution, so a 429 proves the key.
		return {
			ok: true,
			status: response.status,
			message: reason ?? "ingest key accepted, currently rate limited",
		};
	}
	return {
		ok: false,
		status: response.status,
		message: reason ?? `unexpected ingester response (HTTP ${response.status})`,
	};
}
