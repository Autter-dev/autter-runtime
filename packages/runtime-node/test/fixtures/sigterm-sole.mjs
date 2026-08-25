// Child fixture: sole signal handler -> auto-flush runs, then exits with the
// conventional code. Usage: node sigterm-sole.mjs <expected-exit-code>
import { installAutterAutoFlush } from "../../dist/index.js";

let flushes = 0;
installAutterAutoFlush({
	log: true,
	targets: [
		{
			async forceFlush() {
				flushes++;
			},
		},
	],
});

setTimeout(() => {
	process.kill(process.pid, "SIGTERM");
}, 50);

// Would keep the process alive forever if the signal path failed to exit.
setTimeout(() => {
	assert.fail("process was never terminated by the auto-flush handler");
	process.exit(1);
}, 5_000);
