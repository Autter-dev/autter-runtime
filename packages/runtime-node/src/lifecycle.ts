import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * Lifecycle helpers for the server tracker:
 *
 *   - `installAutterAutoFlush()` — pushes buffered telemetry out on process
 *     exit (`beforeExit`, SIGINT, SIGTERM) so a forgotten `shutdown()` no
 *     longer means silent data loss.
 *   - export counting + debug logging — "exported N spans" visibility and an
 *     explicit warning when the process exits with unconfirmed captures.
 *
 * The browser SDK solves the same problem with pagehide/beacon batching;
 * Node has no beacon, so we flush what we can reach instead.
 */

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

let debugEnabled =
	process.env.AUTTER_DEBUG === "1" || process.env.AUTTER_DEBUG === "true";

export interface AutterLogger {
	log: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

export function setDebugMode(enabled: boolean): void {
	debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
	return debugEnabled;
}

/** `[autter] …` line to stderr, only when debug mode is on. */
export function debugLog(...args: unknown[]): void {
	if (debugEnabled) {
		console.error("[autter]", ...args);
	}
}

// ---------------------------------------------------------------------------
// Export accounting — powers "exported N spans" logs and the unflushed-exit
// warning.
// ---------------------------------------------------------------------------

class TelemetryStats {
	/** Captures queued via our APIs and not yet seen leaving an exporter. */
	pendingCaptures = 0;

	markCaptured(count = 1): void {
		this.pendingCaptures += count;
	}

	/** An exporter batch left the process successfully. */
	onExported(spanCount: number): void {
		// Exported batches also contain sampled request spans, so this
		// over-credits captures — erring toward "already flushed" keeps the
		// exit warning quiet unless data really is still queued.
		this.pendingCaptures = Math.max(0, this.pendingCaptures - spanCount);
		if (debugEnabled && spanCount > 0) {
			debugLog(`exported ${spanCount} span${spanCount === 1 ? "" : "s"}`);
		}
	}

	markAllFlushed(): void {
		this.pendingCaptures = 0;
	}
}

export const telemetryStats = new TelemetryStats();

/**
 * Wraps an OTLP trace exporter to observe every batch that actually leaves
 * the process (periodic batches included — wrapping the span processor would
 * only see forced flushes).
 */
export class CountingExporter implements SpanExporter {
	constructor(private readonly inner: SpanExporter) {}

	export(
		spans: ReadableSpan[],
		resultCallback: (result: ExportResult) => void,
	): void {
		this.inner.export(spans, (result) => {
			if (result.code === ExportResultCode.SUCCESS) {
				telemetryStats.onExported(spans.length);
			}
			resultCallback(result);
		});
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown();
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve();
	}
}

// ---------------------------------------------------------------------------
// Flush-target registry — initAutterServer registers everything that buffers
// telemetry here, so auto-flush can reach it without reaching into NodeSDK
// internals (NodeSDK exposes shutdown() but no forceFlush()).
// ---------------------------------------------------------------------------

export interface FlushTarget {
	forceFlush(): Promise<unknown> | unknown;
}

const flushTargets = new Map<string, FlushTarget>();

export function registerFlushTarget(key: string, target: FlushTarget): void {
	flushTargets.set(key, target);
}

/** Removes all registered targets — called by shutdown(). */
export function unregisterFlushTargets(): void {
	flushTargets.clear();
}

function activeFlushTargets(): FlushTarget[] {
	return [...flushTargets.values()];
}

// ---------------------------------------------------------------------------
// Auto-flush
// ---------------------------------------------------------------------------

export interface AutoFlushOptions {
	/**
	 * Targets to flush. Defaults to whatever initAutterServer has registered;
	 * pass your own for custom pipelines.
	 */
	targets?: FlushTarget[];
	/** Where lifecycle messages go. Default console. */
	logger?: AutterLogger;
	/** Log each successful flush ("flushed telemetry (SIGTERM)"). Default true. */
	log?: boolean;
	/**
	 * Warn on stderr when the process exits with captures that were never
	 * confirmed exported. Default true.
	 */
	warnOnUnflushedExit?: boolean;
	/**
	 * Max wall-clock time a single flush may take before giving up (and, on
	 * signals, proceeding to exit anyway). Default 3000 ms.
	 */
	timeoutMs?: number;
	/** Signals handled besides the defaults. Default ["SIGINT", "SIGTERM"]. */
	signals?: string[];
}

export interface AutoFlushHandle {
	/** Force-flush now. Safe to call repeatedly; concurrent calls coalesce. */
	flush(reason?: string): Promise<boolean>;
	/** Remove every listener this install added. */
	dispose(): void;
}

const DEFAULT_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SIGNAL_EXIT_CODES: Record<string, number> = {
	SIGINT: 130,
	SIGTERM: 143,
};

/**
 * Flush all exporters when the process is going away:
 *
 *   - `beforeExit` — event-loop drained naturally: force-flush, then hand the
 *     loop back (a kept-alive timer makes sure the async flush finishes
 *     inside the beforeExit window).
 *   - SIGINT / SIGTERM — flush, then exit with the conventional code (130 /
 *     143). If YOUR code also listens to the signal, we only flush
 *     concurrently and let your handler decide the exit — installing this
 *     never changes an existing graceful-shutdown path. A second signal
 *     always exits immediately.
 *
 * Idempotent per options object; `initAutterServer` installs it by default
 * (`autoFlush: false` opts out).
 */
export function installAutterAutoFlush(
	options: AutoFlushOptions = {},
): AutoFlushHandle {
	const logger = options.logger ?? console;
	const log = options.log !== false;
	const warnOnUnflushedExit = options.warnOnUnflushedExit !== false;
	const timeoutMs = Math.max(100, options.timeoutMs ?? 3_000);
	const signals = options.signals ?? DEFAULT_SIGNALS;
	let disposed = false;

	let inFlight: Promise<boolean> | null = null;

	const doFlush = async (): Promise<boolean> => {
		const targets = options.targets ?? activeFlushTargets();
		if (targets.length === 0) return true;
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		});
		const drained = Promise.allSettled(
			targets.map((target) => target.forceFlush()),
		).then(() => true);
		const ok = await Promise.race([drained, timedOut]);
		clearTimeout(timer);
		if (ok) {
			telemetryStats.markAllFlushed();
			if (log) {
				logger.log("[autter] telemetry flushed");
			}
		} else {
			logger.error(
				`[autter] flush did not finish within ${timeoutMs}ms — some telemetry may be lost`,
			);
		}
		return ok;
	};

	const flush = (reason = "exit"): Promise<boolean> => {
		if (disposed) return Promise.resolve(false);
		if (!inFlight) {
			inFlight = doFlush().finally(() => {
				inFlight = null;
			});
		}
		if (isDebugEnabled()) debugLog(`auto-flush requested on ${reason}`);
		return inFlight;
	};

	const signalCounts = new Map<string, number>();

	const onSignal = (signal: string): void => {
		const count = (signalCounts.get(signal) ?? 0) + 1;
		signalCounts.set(signal, count);
		const exitCode = SIGNAL_EXIT_CODES[signal] ?? 1;
		if (count > 1) {
			// Second Ctrl+C / kill: the user wants out, don't hold the door.
			process.exit(exitCode);
		}
		// -1 because our own listener is already attached at this point.
		const otherHandlers = process.listenerCount(signal) - 1;
		if (otherHandlers > 0) {
			// The app owns this signal's exit path (graceful drain etc.) —
			// opportunistically flush alongside it and stay out of the way.
			void flush(signal);
			return;
		}
		void flush(signal).finally(() => {
			process.exit(exitCode);
		});
	};

	// beforeExit re-fires every time the loop drains again — including after
	// OUR keep-alive timer is cleared — so flush eagerly on the first drain
	// (covering buffers we don't count, like sampled request spans and the
	// metric interval) and afterwards only when captures are actually
	// pending. The cap is a runaway guard, not an expected path.
	const MAX_BEFORE_EXIT_FLUSHES = 10;
	let beforeExitFlushes = 0;

	const onBeforeExit = (): void => {
		if (disposed) return;
		const targets = options.targets ?? activeFlushTargets();
		const worthIt =
			beforeExitFlushes === 0
				? targets.length > 0
				: telemetryStats.pendingCaptures > 0;
		if (!worthIt || beforeExitFlushes >= MAX_BEFORE_EXIT_FLUSHES) return;
		beforeExitFlushes++;
		// beforeExit does not wait for promises: pin the event loop until the
		// flush settles (or times out), then let the process die naturally.
		const keepAlive = setTimeout(() => {}, timeoutMs);
		void flush("beforeExit").finally(() => clearTimeout(keepAlive));
	};

	const onExit = (): void => {
		if (!warnOnUnflushedExit || disposed) return;
		const pending = telemetryStats.pendingCaptures;
		if (pending > 0) {
			logger.error(
				`[autter] process exiting with ~${pending} captured item(s) never confirmed exported — await autter.shutdown() on graceful shutdown`,
			);
		}
	};

	const signalHandlers = new Map<string, () => void>();

	process.on("beforeExit", onBeforeExit);
	for (const signal of signals) {
		const handler = () => onSignal(signal);
		signalHandlers.set(signal, handler);
		process.on(signal, handler);
	}
	process.on("exit", onExit);

	return {
		flush,
		dispose(): void {
			disposed = true;
			process.removeListener("beforeExit", onBeforeExit);
			process.removeListener("exit", onExit);
			for (const [signal, handler] of signalHandlers) {
				process.removeListener(signal, handler);
			}
			signalHandlers.clear();
		},
	};
}
