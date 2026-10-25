import * as React from "react";
import { captureException } from "@autter/runtime-browser";
import { digestOf } from "./control-flow.js";

/**
 * Next.js error pages report through Autter (RF-04). `app/error.tsx` and
 * `app/global-error.tsx` receive the error React caught; report it while the
 * page renders, before React logs it, so it is sent once, with the boundary
 * and Next's `digest` (which names the server-side error onRequestError
 * reported, when it came from the server):
 *
 *   // app/error.tsx
 *   "use client";
 *   import { useAutterErrorReport } from "@autter/runtime-next/client";
 *   export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
 *     useAutterErrorReport(error);
 *     return <button onClick={reset}>Try again</button>;
 *   }
 *
 *   // app/global-error.tsx
 *   "use client";
 *   export { AutterGlobalError as default } from "@autter/runtime-next/client";
 */

export interface NextErrorReportOptions {
	/** Which file caught it: "error" (default) or "global-error". */
	boundary?: "error" | "global-error";
	/** Extra context for the event. */
	context?: Record<string, unknown>;
}

const reported = new WeakSet<object>();

/** Report an error a Next.js error page received, once per error object. */
export function reportNextError(error: unknown, options: NextErrorReportOptions = {}): void {
	try {
		if (error && typeof error === "object") {
			if (reported.has(error)) return;
			reported.add(error);
		}
		const digest = digestOf(error);
		captureException(error, {
			...options.context,
			"next.error_boundary": options.boundary ?? "error",
			...(digest ? { "next.digest": digest.slice(0, 100) } : {}),
		});
	} catch {
		/* reporting never breaks the error page */
	}
}

/**
 * For `app/error.tsx` (and custom `global-error.tsx` pages): reports the
 * error during render (once, Strict Mode's double render included).
 */
export function useAutterErrorReport(error: unknown, options?: NextErrorReportOptions): void {
	reportNextError(error, options);
}

export interface AutterGlobalErrorProps {
	error: Error & { digest?: string };
	reset?: () => void;
}

/**
 * A ready `app/global-error.tsx`: reports the error and renders a minimal
 * page (it replaces the root layout, so it brings its own `<html>`).
 */
export function AutterGlobalError({ error, reset }: AutterGlobalErrorProps): React.ReactElement {
	useAutterErrorReport(error, { boundary: "global-error" });
	return React.createElement(
		"html",
		{ lang: "en" },
		React.createElement(
			"body",
			null,
			React.createElement("h2", null, "Something went wrong"),
			reset ? React.createElement("button", { type: "button", onClick: () => reset() }, "Try again") : null,
		),
	);
}
