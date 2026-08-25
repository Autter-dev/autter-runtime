// Child fixture: the app owns SIGTERM (graceful drain). Auto-flush must run
// CONCURRENTLY and must NOT change the app's exit code.
import { installAutterAutoFlush } from "../../dist/index.js";

const flushed = [];
installAutterAutoFlush({
	log: true,
	targets: [
		{
			async forceFlush() {
				await new Promise((r) => setTimeout(r, 30));
				flushed.push(1);
			},
		},
	],
});

process.on("SIGTERM", () => {
	setTimeout(() => {
		if (flushed.length === 0) {
			console.error("APP-HANDLER-SAW-NO-FLUSH");
			process.exit(1);
		}
		console.log("app graceful drain complete");
		process.exit(0);
	}, 60);
});

setTimeout(() => {
	process.kill(process.pid, "SIGTERM");
}, 50);
