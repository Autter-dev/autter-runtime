// Child fixture: SIGTERM arrives twice in quick succession while the flush
// target is slow — the second signal must cut through immediately.
import { installAutterAutoFlush } from "../../dist/index.js";

installAutterAutoFlush({
	log: true,
	targets: [
		{
			async forceFlush() {
				await new Promise((r) => setTimeout(r, 2_000));
			},
		},
	],
});

setTimeout(() => {
	process.kill(process.pid, "SIGTERM");
	setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
}, 50);
