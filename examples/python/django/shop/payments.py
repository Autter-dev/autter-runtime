from opentelemetry import trace

tracer = trace.get_tracer(__name__)

LEDGER: dict = {}


class GatewayError(Exception):
    pass


class PaymentDeclined(Exception):
    pass


class RefundPending(Exception):
    pass


def _call_gateway(order_id):
    # The URL's credentials reach the traceback through the cause's message;
    # redact.py masks them before export.
    raise GatewayError(f"https://merchant:hunter2@pay.example.com answered 402 for order {order_id}")  # frame: _call_gateway


def charge_card(order_id):
    # A span of your own: it records the error too, and the ingester merges
    # the two recordings into one occurrence.
    with tracer.start_as_current_span("payments.charge_card", attributes={"order.id": order_id}):
        try:
            return _call_gateway(order_id)
        except GatewayError as err:
            raise PaymentDeclined(f"card declined for order {order_id}") from err  # frame: charge_card


def refund_card(order_id):
    try:
        return LEDGER[order_id]
    except KeyError:
        raise RefundPending(f"refund for order {order_id} is still settling")  # frame: refund_card
