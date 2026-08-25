// Child fixture: event loop drains naturally -> beforeExit fires, the async
// flush must complete inside that window, then the process exits 0.
import { installAutterAutoFlush } from "../../dist/index.js";

let flushes = 0;
installAutterAutoFlush({
	log: true,
	targets: [
		{
			async forceFlush() {
				await new Promise((r) => setTimeout(r, 40));
				flushes++;
				console.log(`FLUSHED=${flushes}`);
			},
		},
	],
});

setTimeout(() => {}, 20);
