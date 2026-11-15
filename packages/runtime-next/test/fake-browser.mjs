// A minimal browser for the client entry's trace propagation tests: a page at
// https://app.example.test with fetch and XMLHttpRequest that record what
// they were sent. Each test file runs in its own process (node --test), so
// each starts the tracker once with its own options.

export const ORIGIN = "https://app.example.test";
export const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/;

/** Every fetch the page made: { url, input, init }. */
export const calls = [];
/** Every XMLHttpRequest the page opened. */
export const xhrs = [];

class FakeXHR {
	status = 0;
	readyState = 0;
	headers = [];
	open(_method, url) {
		this.url = url;
		this.readyState = 1;
		xhrs.push(this);
	}
	send() {}
	setRequestHeader(name, value) {
		this.headers.push([name, value]);
	}
	getResponseHeader() {
		return null;
	}
	addEventListener() {}
	removeEventListener() {}
	traceparent() {
		const found = this.headers.filter(([name]) => name.toLowerCase() === "traceparent");
		return found.length ? found.map(([, value]) => value).join(", ") : null;
	}
}

export function installFakeBrowser() {
	globalThis.window = {
		origin: ORIGIN,
		addEventListener() {},
		async fetch(input, init) {
			const url = input instanceof Request ? input.url : String(input);
			calls.push({ url, input, init });
			return new Response(null, { status: 200 });
		},
	};
	globalThis.document = { addEventListener() {}, visibilityState: "visible" };
	globalThis.location = { href: `${ORIGIN}/checkout`, pathname: "/checkout", origin: ORIGIN };
	globalThis.XMLHttpRequest = FakeXHR;
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { sendBeacon: () => true } });
}

/** The traceparent the page's fetch to `url` was sent with (null when none). */
export async function fetchTraceparent(url, init) {
	await window.fetch(url, init);
	const { input, init: sent } = calls[calls.length - 1];
	return new Headers(sent?.headers ?? (input instanceof Request ? input.headers : undefined)).get("traceparent");
}

/** The traceparent an XMLHttpRequest to `url` was sent with (null when none). */
export function xhrTraceparent(url) {
	const request = new XMLHttpRequest();
	request.open("GET", url);
	request.send();
	return request.traceparent();
}

/** The options the tests start the tracker with (no session ping, no timings). */
export const TRACKER = { endpoint: "/api/autter-runtime", service: "web", sessionTracking: false, captureTimings: false };
