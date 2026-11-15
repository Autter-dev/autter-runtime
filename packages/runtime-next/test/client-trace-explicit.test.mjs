// An app that already calls enableTracePropagation before initAutterBrowser
// (the documented opt-in before it became the default) keeps its targets:
// the default does not replace them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { enableTracePropagation, initAutterBrowser } from "../dist/client.js";
import { TRACEPARENT, TRACKER, fetchTraceparent, installFakeBrowser } from "./fake-browser.mjs";

installFakeBrowser();
enableTracePropagation({ tracePropagationTargets: ["https://api.example.test/"] });
initAutterBrowser(TRACKER);

test("targets passed to an earlier enableTracePropagation call are kept", async () => {
	assert.match(await fetchTraceparent("https://api.example.test/v1/orders"), TRACEPARENT);
	assert.match(await fetchTraceparent("/api/orders"), TRACEPARENT);
	assert.equal(await fetchTraceparent("https://cdn.thirdparty.test/lib.json"), null);
});
