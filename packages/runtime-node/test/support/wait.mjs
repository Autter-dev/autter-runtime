// Waiting in tests without guessing how fast the machine is.
//
// A fixed sleep before an assertion ("wait 30 ms, then check the summary was
// recorded") passes on a fast laptop and fails on a loaded CI runner or a
// slow Windows VM. Wait for the thing the assertion is about instead.

/**
 * Poll `check` every 10 ms until it returns a truthy value, or until `ms`
 * have passed. Resolves either way (with the last result): the assertion
 * that follows then fails with its own message, which says what is missing,
 * rather than with a timeout.
 */
export async function until(check, ms = 5000) {
	const deadline = Date.now() + ms;
	let result = check();
	while (!result && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		result = check();
	}
	return result;
}

/**
 * A short, bounded wait for a check that something does NOT happen (no
 * second warning, no stray rejection, nothing forwarded). There is nothing
 * to poll for, so a fixed wait is the right tool here; the call site says
 * what it gives a chance to happen. Never use it before an assertion that
 * something DID happen: use `until` for that.
 */
export function quietPeriod(ms = 100) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Count a server's responses that have not closed yet. The OTel HTTP
 * instrumentation ends a server span on the response's `close` event, and it
 * subscribes before any `request` listener runs, so once this count is back
 * to 0 every server span has ended and `shutdown()` will export it.
 */
export function trackOpenResponses(server, counter = { open: 0 }) {
	server.on("request", (_req, res) => {
		counter.open++;
		res.once("close", () => counter.open--);
	});
	return counter;
}
