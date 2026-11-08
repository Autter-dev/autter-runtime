import { initAutterBrowser } from "@autter/runtime-browser";
import { computeTotal } from "./checkout/cart.js";

// Set at build time (see vite.config.js / webpack.config.js) and read from
// the page's query string, so one build can point at any test ingester.
const params = new URLSearchParams(window.location.search);
initAutterBrowser({
	endpoint: params.get("endpoint") ?? "http://127.0.0.1:4318/v1/browser",
	clientKey: params.get("key") ?? undefined,
	service: "sourcemaps-e2e",
	release: __AUTTER_RELEASE__,
});

function onCheckoutClick() {
	// "SPRING" has no rule: applyDiscount reads `amount` of null.
	const order = { subtotal: 40, code: "SPRING", discounts: { SPRING: null } };
	document.querySelector("#total").textContent = String(computeTotal(order));
}

document.querySelector("#checkout").addEventListener("click", onCheckoutClick);
document.body.dataset.ready = "true";
