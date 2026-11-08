"use client";

import { initAutterBrowser } from "@autter/runtime-browser";
import { useEffect } from "react";
import { computeTotal } from "../../src/checkout/cart.js";

function onCheckoutClick() {
	// "SPRING" has no rule: applyDiscount reads `amount` of null.
	const order = { subtotal: 40, code: "SPRING", discounts: { SPRING: null } };
	document.querySelector("#total").textContent = String(computeTotal(order));
}

export default function Checkout() {
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		initAutterBrowser({
			endpoint: params.get("endpoint") ?? "http://127.0.0.1:4318/v1/browser",
			clientKey: params.get("key") ?? undefined,
			service: "sourcemaps-e2e",
			release: process.env.NEXT_PUBLIC_AUTTER_RELEASE,
		});
		document.body.dataset.ready = "true";
	}, []);
	return (
		<main>
			<button id="checkout" type="button" onClick={onCheckoutClick}>
				Check out
			</button>
			<span id="total" />
		</main>
	);
}
