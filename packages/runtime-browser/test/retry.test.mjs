import { test } from "node:test";
import assert from "node:assert/strict";
import { flush, initAutterBrowser, trackEvent } from "../dist/index.js";

// Scheduled sends go through fetch so a 429 or 5xx can be retried: the
// ingester answers 503 with Retry-After while it can't check a key (its
// validator is down), and a 401 only for a key it refused. flush() (page
// hidden or closing) still uses sendBeacon, which can't see the answer.

const beacons = [];
const posts = [];
let answers = [];
globalThis.window = { fetch: async () => new Response("{}"), addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = { href: "https://app.example.test/", pathname: "/" };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	sendBeacon(_url, body) { beacons.push(body); return true; },
} });
globalThis.fetch = async (url, init) => {
	posts.push({ url, init, names: JSON.parse(init.body).events.map((event) => event.name) });
	const answer = answers.shift() ?? { status: 202 };
	if (answer.status === 0) throw new TypeError("Failed to fetch");
	return new Response(null, { status: answer.status, headers: answer.headers ?? {} });
};

initAutterBrowser({
	endpoint: "https://collector.example.test/v1/browser",
	clientKey: "autter_rtc_test",
	service: "web",
	sessionTracking: false,
	captureTimings: false,
	captureErrors: false,
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
const fillQueue = (tag) => {
	for (let i = 0; i < 10; i++) trackEvent(`${tag}-${i}`);
};

test("a 503 with Retry-After is retried after that delay, with the same events", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	posts.length = 0;
	answers = [{ status: 503, headers: { "retry-after": "5" } }, { status: 202 }];
	fillQueue("outage");
	await settle();
	assert.equal(posts.length, 1);
	assert.equal(posts[0].init.keepalive, false);
	t.mock.timers.tick(4999);
	await settle();
	assert.equal(posts.length, 1);
	t.mock.timers.tick(1);
	await settle();
	assert.equal(posts.length, 2);
	assert.deepEqual(posts[1].names, posts[0].names);
	assert.equal(beacons.length, 0);
});

test("429 and network errors are retried with backoff; 401 is not", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	posts.length = 0;
	answers = [{ status: 429 }, { status: 0 }, { status: 202 }];
	fillQueue("busy");
	await settle();
	t.mock.timers.tick(5000);
	await settle();
	t.mock.timers.tick(10000);
	await settle();
	assert.equal(posts.length, 3);
	assert.deepEqual(posts[2].names, posts[0].names);

	posts.length = 0;
	answers = [{ status: 401 }];
	fillQueue("refused");
	await settle();
	t.mock.timers.tick(60000);
	await settle();
	assert.equal(posts.length, 1);
});

test("events are dropped after three retries in a row", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	posts.length = 0;
	answers = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }];
	fillQueue("down");
	await settle();
	for (const delay of [5000, 10000, 20000, 40000, 80000]) {
		t.mock.timers.tick(delay);
		await settle();
	}
	assert.equal(posts.length, 4);
});

test("flush() still uses sendBeacon", async () => {
	trackEvent("final");
	flush();
	assert.equal(beacons.length, 1);
});
