// Child fixture: the compat check's request to a hanging ingester must not
// keep the process alive — a short-lived script exits as soon as its own
// work is done.
import { initAutterServer } from "../../dist/index.js";

initAutterServer({
	service: "compat-exit",
	apiKey: "test-key",
	endpoint: process.argv[2],
	captureGlobalErrors: false,
	autoFlush: false,
	memoryMetrics: false,
});

// The app's own work: long enough for the check to start its request. The
// process should exit right after it. It prints what still keeps the event
// loop alive once the work is done (nothing, if the in-flight compat request
// is unref'd), and the time, which the parent compares with the exit.
setTimeout(() => {
	setImmediate(() => {
		process.stdout.write(`HOLDING ${JSON.stringify(process.getActiveResourcesInfo())}\n`);
		process.stdout.write(`WORK_DONE ${Date.now()}\n`);
	});
}, 300);
