RATES = {"EUR": 0.02, "USD": 0.025}


def render_invoice(invoice_id: int, lines: list) -> dict:
    total = sum(line["amount"] for line in lines)
    average = total / len(lines)  # frame: render_invoice
    return {"invoice": invoice_id, "total": total, "average": average}


def late_fee(amount: float, currency: str) -> float:
    return amount * RATES[currency]  # frame: late_fee
