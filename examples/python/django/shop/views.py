from django.http import Http404, JsonResponse
from opentelemetry import trace

from shop.payments import RefundPending, charge_card, refund_card


def health(request):
    return JsonResponse({"ok": True})


def charge(request, order_id):
    # Unhandled: Django answers 500 and OpenTelemetry's Django middleware
    # records the exception, with its traceback, on the request span.
    receipt = charge_card(order_id)  # frame: charge
    return JsonResponse(receipt)


def refund(request, order_id):
    try:
        return JsonResponse(refund_card(order_id))  # frame: refund
    except RefundPending as exc:
        # Handled: the client gets a 202, and Autter still gets the exception.
        trace.get_current_span().record_exception(exc, attributes={"autter.handled": True})
        return JsonResponse({"status": "pending"}, status=202)


def order(request, order_id):
    # A 404, not an error: shop.middleware keeps it out of Autter.
    raise Http404(f"no order {order_id}")
