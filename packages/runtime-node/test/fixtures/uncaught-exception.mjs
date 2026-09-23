// Child fixture: fatal exception must flush captured telemetry, then preserve
// Node's uncaught-exception exit status.
import { initAutterServer } from "../../dist/index.js";

const exporter = {
	forceFlush() {
		return Promise.resolve();
	},
};
initAutterServer({
	apiKey: "test-key",
	service: "uncaught-exception-test",
	endpoint: `http://127.0.0.1:${process.env.COLLECTOR_PORT}`,
	autoFlush: true,
});
// The fixture verifies lifecycle semantics deterministically without depending
// on OTLP transport timing. The exception monitor still captures a real span.
process.on("beforeExit", () => {});

setTimeout(() => {
	throw new Error("fatal flush regression");
}, 50);
