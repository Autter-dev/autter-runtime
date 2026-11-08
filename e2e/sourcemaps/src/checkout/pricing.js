/** The discount a code gives on an order. Throws when the code has no rule. */
export function applyDiscount(order, code) {
	const rule = order.discounts[code];
	return order.subtotal - rule.amount;
}
