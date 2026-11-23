import { test } from "node:test";
import assert from "node:assert/strict";
import { captureException, captureMessage, flush, initAutterBrowser, setContext, trackEvent } from "../dist/index.js";

// A value JSON.stringify cannot handle (a BigInt id, a cycle added by
// beforeSend) used to throw out of the send: from the patched fetch's .then
// the app's own successful fetch rejected, and on the timer the SDK reported
// its own failure in a loop. Sends must never throw and must keep the events.

const posts = [];
const pageErrors = [];
const rejections = [];
process.on("unhandledRejection", (reason) => rejections.push(reason));
globalThis.window = {
	fetch: async () => new Response("down", { status: 500 }),
	addEventListener(name, listener) {
		if (name === "error" || name === "unhandledrejection") pageErrors.push(listener);
	},
};
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = { href: "https://app.example.test/", pathname: "/", hostname: "app.example.test" };
// No sendBeacon: flush() delivers with fetch too.
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
globalThis.fetch = async (_url, init) => {
	posts.push(JSON.parse(init.body));
	return new Response(null, { status: 202 });
};

initAutterBrowser({
	endpoint: "/api/autter-runtime",
	service: "web",
	sessionTracking: false,
	captureActions: false,
	captureTimings: false,
	beforeSend(event) {
		if (event.message === "cyclic") {
			const node = { name: "node" };
			node.self = node;
			event.context = { ...event.context, node, shared: [node.name, node.name], big: 2n };
		}
		if (event.message === "poison") event.context = { ...event.context, bad: { toJSON() { throw new Error("no"); } } };
		return event;
	},
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a BigInt in setContext: the app's fetch still resolves and the events arrive with the id as a string", async () => {
	setContext({ id: 1n });
	for (let i = 0; i < 10; i++) {
		// The 10th 500 fills the queue and sends from inside the fetch's .then.
		const response = await window.fetch(`/api/orders/${i}`);
		assert.equal(response.status, 500);
	}
	await settle();
	assert.equal(posts.length, 1);
	assert.equal(posts[0].events.length, 10);
	for (const event of posts[0].events) {
		assert.equal(event.type, "request_failure");
		assert.equal(event.context.id, "1");
	}
});

test("a cycle and a BigInt added by beforeSend are serialised with a replacer, not dropped", async () => {
	posts.length = 0;
	assert.doesNotThrow(() => captureMessage("cyclic"));
	flush();
	await settle();
	assert.equal(posts.length, 1);
	const [event] = posts[0].events;
	assert.equal(event.context.node.self, "[Circular]");
	assert.deepEqual(event.context.shared, ["node", "node"]);
	assert.equal(event.context.big, "2");
	assert.equal(event.context.id, "1");
});

test("an event that still cannot be serialised is dropped alone", async () => {
	posts.length = 0;
	captureMessage("poison");
	captureException(new Error("healthy"));
	trackEvent("clicked");
	flush();
	await settle();
	assert.equal(posts.length, 1);
	assert.deepEqual(posts[0].events.map((event) => event.message), ["healthy", ""]);
});

test("nothing reached the page's error listeners or became an unhandled rejection", async () => {
	setContext(null);
	await settle();
	assert.equal(rejections.length, 0);
	// The SDK's own listeners are the only ones registered here; calling them
	// with a malformed event must not throw either.
	for (const listener of pageErrors) assert.doesNotThrow(() => listener({}));
});
