// Child fixture: one unhandled promise rejection, with or without Autter.
// The parent runs every scenario twice (AUTTER=0 and AUTTER=1) and checks
// that the exit code and survival are identical, then reads what Autter sent.
//
//   AUTTER=1                 initAutterServer before anything else
//   AUTOFLUSH=0              initAutterServer({ autoFlush: false })
//   CAPTURE_REJECTIONS=0     initAutterServer({ captureUnhandledRejections: false })
//   APP_LISTENER=log|rethrow the app's own unhandledRejection listener
//   APP_UNCAUGHT=1           the app's own uncaughtException listener
//   REASON=error|string      what the promise rejects with
const env = process.env;
let autter = null;
if (env.AUTTER === "1") {
	const { initAutterServer } = await import("../../dist/index.js");
	autter = initAutterServer({
		apiKey: "test-key",
		service: env.SERVICE ?? "rejections",
		endpoint: `http://127.0.0.1:${env.COLLECTOR_PORT}`,
		autoFlush: env.AUTOFLUSH !== "0",
		captureUnhandledRejections: env.CAPTURE_REJECTIONS !== "0",
		memoryMetrics: false,
		compatCheck: false,
		metricIntervalMs: 3_600_000,
		logging: { console: false },
	});
}

if (env.APP_LISTENER === "log")
	process.on("unhandledRejection", (reason) => {
		process.stdout.write(`app listener: ${reason instanceof Error ? reason.message : String(reason)}\n`);
	});
if (env.APP_LISTENER === "rethrow")
	process.on("unhandledRejection", (reason) => {
		throw reason;
	});
if (env.APP_UNCAUGHT === "1")
	process.on("uncaughtException", (error) => {
		process.stdout.write(`app uncaught handler: ${error instanceof Error ? error.message : String(error)}\n`);
	});

setTimeout(() => {
	Promise.reject(env.REASON === "string" ? "plain rejection reason" : new Error("rejection boom"));
}, 20);

setTimeout(async () => {
	if (autter) await autter.shutdown();
	process.stdout.write("survived\n");
}, 400);
