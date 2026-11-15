// @autter/runtime-next/client turns same-origin trace propagation on by
// default: initAutterBrowser alone adds a traceparent to the app's own
// requests, never to a third-party origin or to the tracker's endpoint.
import assert from "node:assert/strict";
import { test } from "node:test";
import { initAutterBrowser } from "../dist/client.js";
import { ORIGIN, TRACEPARENT, TRACKER, fetchTraceparent, installFakeBrowser, xhrTraceparent } from "./fake-browser.mjs";

installFakeBrowser();
initAutterBrowser({ ...TRACKER, tracePropagationTargets: ["https://api.example.test/"] });

test("same-origin requests get a traceparent with no extra call", async () => {
	assert.match(await fetchTraceparent("/api/orders?page=2"), TRACEPARENT);
	assert.match(await fetchTraceparent(`${ORIGIN}/api/orders`, { method: "POST" }), TRACEPARENT);
	assert.match(xhrTraceparent("/api/cart"), TRACEPARENT);
});

test("a third-party origin never gets one by default", async () => {
	assert.equal(await fetchTraceparent("https://cdn.thirdparty.test/lib.json"), null);
	assert.equal(await fetchTraceparent("https://app.example.test.evil.test/api"), null, "a prefix of the origin is not the origin");
	assert.equal(await fetchTraceparent("https://api.example.test.evil.test/x"), null, "nor is a host that starts like a target");
	assert.equal(xhrTraceparent("https://maps.thirdparty.test/tiles"), null);
});

test("an origin listed in tracePropagationTargets gets one", async () => {
	assert.match(await fetchTraceparent("https://api.example.test/v1/orders"), TRACEPARENT);
	assert.match(xhrTraceparent("https://api.example.test/v1/cart"), TRACEPARENT);
});

test("the tracker's own endpoint is skipped", async () => {
	assert.equal(await fetchTraceparent("/api/autter-runtime", { method: "POST", body: "{}" }), null);
});

test("a second initAutterBrowser call changes nothing", async () => {
	initAutterBrowser({ ...TRACKER, tracePropagation: false });
	assert.match(await fetchTraceparent("/api/orders"), TRACEPARENT);
	assert.match(await fetchTraceparent("https://api.example.test/v1/orders"), TRACEPARENT);
});
