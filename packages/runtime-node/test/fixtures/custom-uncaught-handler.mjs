import { initAutterServer } from "../../dist/index.js";

process.on("uncaughtException", () => {
	process.stdout.write("application handler recovered\n");
	setTimeout(() => process.exit(0), 10);
});

initAutterServer({
	apiKey: "test-key",
	service: "custom-handler-test",
	endpoint: `http://127.0.0.1:${process.env.COLLECTOR_PORT}`,
	autoFlush: true,
});

setTimeout(() => { throw new Error("handled by application"); }, 50);
