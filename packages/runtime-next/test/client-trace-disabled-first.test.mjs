// disableTracePropagation() called before initAutterBrowser keeps
// propagation off: the default does not turn it back on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { disableTracePropagation, initAutterBrowser } from "../dist/client.js";
import { TRACKER, fetchTraceparent, installFakeBrowser, xhrTraceparent } from "./fake-browser.mjs";

installFakeBrowser();
disableTracePropagation();
initAutterBrowser(TRACKER);

test("an earlier disableTracePropagation call keeps every request free of a traceparent", async () => {
	assert.equal(await fetchTraceparent("/api/orders"), null);
	assert.equal(xhrTraceparent("/api/cart"), null);
});
