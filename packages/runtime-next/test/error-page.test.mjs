// RF-04 (Next.js): the error.tsx / global-error.tsx helpers report the error
// a Next error page received, through the browser tracker, once per error,
// with the boundary and Next's digest. AutterGlobalError renders a page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as client from "../dist/client.js";

const sent = [];
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: "visible", scripts: [] };
globalThis.location = { href: "https://app.example.test/orders", pathname: "/orders", origin: "https://app.example.test" };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
	sendBeacon(_url, body) { sent.push(body); return true; },
} });
client.initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false, captureNetworkFailures: false, captureLoggedErrors: false });

async function drain() {
	client.flush();
	const batch = sent.splice(0, sent.length);
	const events = [];
	for (const body of batch) events.push(...JSON.parse(await body.text()).events);
	return events;
}

test("reportNextError captures the error once, with the boundary and Next digest", async () => {
	const error = Object.assign(new Error("render failed"), { digest: "1234567890" });
	client.reportNextError(error, { boundary: "error" });
	client.reportNextError(error, { boundary: "error" }); // a re-render must not double-report
	const events = await drain();
	const reported = events.filter((e) => e.message === "render failed");
	assert.equal(reported.length, 1, "reported once per error object");
	assert.equal(reported[0].context["next.error_boundary"], "error");
	assert.equal(reported[0].context["next.digest"], "1234567890");
});

test("AutterGlobalError reports and renders an html page with a reset button", async () => {
	const reset = () => {};
	const element = client.AutterGlobalError({ error: new Error("global boom"), reset });
	assert.equal(element.type, "html");
	const events = await drain();
	const reported = events.find((e) => e.message === "global boom");
	assert.ok(reported, "global-error reported");
	assert.equal(reported.context["next.error_boundary"], "global-error");
});

test("the client entry exports the error-page helpers and their types", () => {
	assert.equal(typeof client.reportNextError, "function");
	assert.equal(typeof client.useAutterErrorReport, "function");
	assert.equal(typeof client.AutterGlobalError, "function");
	for (const file of ["client.d.ts", "client.d.cts"]) {
		const types = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
		assert.match(types, /reportNextError/);
		assert.match(types, /AutterGlobalError/);
		assert.match(types, /NextErrorReportOptions/);
	}
});
