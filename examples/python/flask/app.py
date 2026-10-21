"""Flask on plain OpenTelemetry with always-on error spans.

    gunicorn -w 4 app:app   # with the OTEL_* variables from docs/INTEGRATIONS.md#python
"""

from autter_tracing import init_tracing  # copied from adapters/python, with redact.py
from flask import Flask, abort, jsonify
from opentelemetry import trace
from opentelemetry.instrumentation.flask import FlaskInstrumentor

from billing import late_fee, render_invoice

# gunicorn imports this module in each worker (or once before forking them,
# with --preload: the batch exporter and the error buffer restart in each
# worker). Either way, before the app is instrumented.
init_tracing()

app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/ok")
def ok():
    return {"ok": True}


@app.get("/invoices/<int:invoice_id>/summary")
def summary(invoice_id):
    # Unhandled: Flask answers 500; the Flask instrumentation records the
    # exception on the request span when the request is torn down.
    return jsonify(render_invoice(invoice_id, lines=[]))  # frame: summary


@app.get("/invoices/<int:invoice_id>/late-fee")
def fee(invoice_id):
    try:
        return {"invoice": invoice_id, "fee": late_fee(120.0, "XYZ")}  # frame: fee
    except KeyError as exc:
        # Handled: a 422 for the client, the exception for Autter.
        trace.get_current_span().record_exception(exc, attributes={"autter.handled": True})
        return {"error": "unsupported currency"}, 422


@app.get("/invoices/<int:invoice_id>")
def invoice(invoice_id):
    abort(404)  # HTTPExceptions are responses: nothing is recorded
