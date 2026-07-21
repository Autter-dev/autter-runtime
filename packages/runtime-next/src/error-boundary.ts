import * as React from "react";
import { captureException } from "@autter/runtime-browser";

/**
 * React error boundary that reports render errors to Autter Runtime.
 * React rendering errors do NOT hit `window.onerror`, so the browser
 * tracker alone misses them — wrap your app:
 *
 *   <AutterErrorBoundary fallback={<ErrorPage />}>
 *     <Application />
 *   </AutterErrorBoundary>
 */

export interface AutterErrorBoundaryProps {
	fallback?: React.ReactNode;
	/** Called after the error is reported (e.g. to show a toast). */
	onError?: (error: Error, info: React.ErrorInfo) => void;
	children?: React.ReactNode;
}

interface State {
	hasError: boolean;
}

export class AutterErrorBoundary extends React.Component<
	AutterErrorBoundaryProps,
	State
> {
	override state: State = { hasError: false };

	static getDerivedStateFromError(): State {
		return { hasError: true };
	}

	override componentDidCatch(error: Error, info: React.ErrorInfo): void {
		captureException(error, {
			react: true,
			...(info.componentStack
				? { componentStack: String(info.componentStack).slice(0, 4000) }
				: {}),
		});
		this.props.onError?.(error, info);
	}

	override render(): React.ReactNode {
		if (this.state.hasError) {
			return this.props.fallback ?? null;
		}
		return this.props.children;
	}
}
