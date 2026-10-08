import inspector from "node:inspector";
import { captureException } from "./server.js";

/** Opt-in diagnostic hook. V8 pauses briefly for every throw, including handled throws. */
export function startCaughtExceptionSampler(options: { sampleRate?: number; maxPerMinute?: number } = {}): { stop(): void } {
	const rate = Math.max(0, Math.min(1, options.sampleRate ?? 0.01));
	const cap = Math.max(1, Math.min(100, options.maxPerMinute ?? 10));
	const session = new inspector.Session();
	let active = true;
	let minute = 0;
	let sent = 0;
	session.connect();
	session.on("Debugger.paused", (message) => {
		// Resume before any telemetry work; inspection must not hold application execution.
		session.post("Debugger.resume", () => {});
		if (!active || message.params.reason !== "exception") return;
		const nowMinute = Math.floor(Date.now() / 60_000);
		if (nowMinute !== minute) { minute = nowMinute; sent = 0; }
		if (sent >= cap || Math.random() >= rate) return;
		sent++;
		const frames = message.params.callFrames.slice(0, 8)
			.filter((frame) => frame.url && !frame.url.startsWith("node:"))
			.map((frame) => `    at ${frame.functionName || "anonymous"} (${frame.url.split("?")[0]}:${frame.location.lineNumber + 1}:${(frame.location.columnNumber ?? 0) + 1})`);
		if (!frames.length) return;
		const error = new Error("Sampled caught exception");
		error.name = "CaughtException";
		error.stack = `${error.name}: ${error.message}\n${frames.join("\n")}`;
		queueMicrotask(() => { if (active) captureException(error, { "autter.handled": true, "autter.sampled": true }); });
	});
	session.post("Debugger.enable", (error) => {
		if (!error && active) session.post("Debugger.setPauseOnExceptions", { state: "all" }, () => {});
	});
	return { stop() {
		if (!active) return;
		active = false;
		session.post("Debugger.setPauseOnExceptions", { state: "none" }, () => {
			session.post("Debugger.disable", () => session.disconnect());
		});
	} };
}
