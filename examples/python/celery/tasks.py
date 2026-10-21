"""Celery on plain OpenTelemetry with always-on error spans.

    celery -A tasks worker   # with the OTEL_* variables from docs/INTEGRATIONS.md#python

The broker is CELERY_BROKER_URL (memory:// by default, for the tests).
"""

import os

from autter_tracing import init_tracing  # copied from adapters/python, with redact.py
from celery import Celery
from celery.signals import worker_process_init
from opentelemetry import trace
from opentelemetry.instrumentation.celery import CeleryInstrumentor

from fulfilment import CarrierTimeout, book_courier, print_label

app = Celery("shop", broker=os.environ.get("CELERY_BROKER_URL", "memory://"))
app.conf.update(
    broker_transport_options={
        key: os.environ[env] for key, env in (
            ("data_folder_in", "CELERY_FS_QUEUE"),
            ("data_folder_out", "CELERY_FS_QUEUE"),
            ("processed_folder", "CELERY_FS_PROCESSED"),
            ("control_folder", "CELERY_FS_CONTROL"),
        ) if env in os.environ
    },
    task_ignore_result=True,
)


def init_observability() -> None:
    init_tracing()
    CeleryInstrumentor().instrument()


@worker_process_init.connect(weak=False)
def _init_worker_process(**_kwargs) -> None:
    # Prefork pool: in each child process, after the fork, as OpenTelemetry's
    # Celery instrumentation asks; solo pool: once, in the worker. The
    # threads, gevent and eventlet pools send no worker_process_init: call
    # init_observability() from worker_init instead.
    init_observability()


@app.task(name="shop.ship_order")
def ship_order(order_id: int) -> None:
    # Unhandled: the task fails; the instrumentation records the exception
    # on the task's span (run/shop.ship_order) and marks it ERROR.
    print_label(order_id)  # frame: ship_order


@app.task(name="shop.send_receipt")
def send_receipt(order_id: int) -> None:
    print_label(order_id)  # frame: send_receipt


@app.task(name="shop.schedule_pickup")
def schedule_pickup(order_id: int) -> str:
    try:
        book_courier(order_id)  # frame: schedule_pickup
    except CarrierTimeout as exc:
        # Handled: retried by a later run; the exception still reaches Autter.
        trace.get_current_span().record_exception(exc, attributes={"autter.handled": True})
        return "deferred"
    return "booked"
