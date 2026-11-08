import { applyDiscount } from "./pricing.js";

/** Order total after its discount code, rounded to cents. */
export function computeTotal(order) {
	const total = applyDiscount(order, order.code);
	return Math.round(total * 100) / 100;
}
