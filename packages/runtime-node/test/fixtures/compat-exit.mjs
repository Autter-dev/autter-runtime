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

// The app's own work: long enough for the check to start its request.
setTimeout(() => {}, 300);
