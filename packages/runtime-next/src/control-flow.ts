/**
 * Next.js control-flow signals: `redirect()`, `notFound()`, `forbidden()`,
 * `unauthorized()` and dynamic-rendering bailouts are thrown, but they are
 * how Next answers, not errors. Runtime-neutral (no Node, no React).
 */

/** Digests Next attaches to its control-flow "errors". */
const CONTROL_FLOW_DIGEST =
	/^(?:NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)\b/;

/** The `digest` Next puts on errors it handles, or "". */
export function digestOf(error: unknown): string {
	try {
		const digest = (error as { digest?: unknown } | null)?.digest;
		return typeof digest === "string" ? digest : "";
	} catch {
		return "";
	}
}

/** True for a thrown `redirect()`, `notFound()`, … — never report these. */
export function isNextControlFlow(error: unknown): boolean {
	return CONTROL_FLOW_DIGEST.test(digestOf(error));
}
