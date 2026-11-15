// `tracePropagation: false` keeps every request free of a traceparent, even
// same-origin and listed ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import { initAutterBrowser } from "../dist/client.js";
import { TRACKER, fetchTraceparent, installFakeBrowser, xhrTraceparent } from "./fake-browser.mjs";

installFakeBrowser();
initAutterBrowser({ ...TRACKER, tracePropagation: false, tracePropagationTargets: ["https://api.example.test/"] });

test("tracePropagation: false sends no traceparent anywhere", async () => {
	assert.equal(await fetchTraceparent("/api/orders"), null);
	assert.equal(await fetchTraceparent("https://api.example.test/v1/orders"), null);
	assert.equal(await fetchTraceparent("https://cdn.thirdparty.test/lib.json"), null);
	assert.equal(xhrTraceparent("/api/cart"), null);
});
