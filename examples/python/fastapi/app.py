"""FastAPI on plain OpenTelemetry with always-on error spans.

    uvicorn app:app   # with the OTEL_* variables from docs/INTEGRATIONS.md#python
"""

import asyncio

from autter_tracing import init_tracing  # copied from adapters/python, with redact.py
from fastapi import FastAPI, HTTPException
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from inventory import PricingTimeout, check_warehouse, price, reserve

# Once per process, at import: uvicorn --workers N imports this module in
# each worker process.
init_tracing()

app = FastAPI()


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/ok")
async def ok():
    return {"ok": True}


@app.post("/carts/{cart_id}/checkout")
async def checkout(cart_id: int):
    # Unhandled: Starlette answers 500, and the OpenTelemetry ASGI middleware
    # records the exception on the request span.
    reserve("sku-1", 2)  # frame: checkout
    return {"cart": cart_id, "status": "reserved"}


@app.get("/carts/{cart_id}/quote")
def quote(cart_id: int):
    try:
        return {"cart": cart_id, "total": price(cart_id)}  # frame: quote
    except PricingTimeout as exc:
        # Handled: a degraded answer, and Autter still gets the exception.
        trace.get_current_span().record_exception(exc, attributes={"autter.handled": True})
        return {"cart": cart_id, "total": None, "estimated": True}


@app.get("/carts/{cart_id}/availability")
async def availability(cart_id: int):
    # Python 3.11+: two failing tasks raise an ExceptionGroup.
    async with asyncio.TaskGroup() as group:  # frame: availability
        group.create_task(check_warehouse("north"))
        group.create_task(check_warehouse("south"))
    return {"cart": cart_id}


@app.get("/items/{item_id}")
async def item(item_id: int):
    # HTTPException becomes a 404 inside Starlette; nothing is recorded.
    raise HTTPException(status_code=404, detail=f"no item {item_id}")


# The defaults: a server span per request, plus "http send"/"http receive"
# spans per ASGI message. A 500's "http send" span has ERROR status and no
# exception; Autter drops it as part of the request's error when both arrive
# in one export batch. exclude_spans=["send", "receive"] removes them.
FastAPIInstrumentor.instrument_app(app)
