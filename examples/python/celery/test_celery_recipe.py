"""The Celery recipe, run for real, without a broker service:

* a prefork worker (`celery -A tasks worker`) in its own process, set up by
  `worker_process_init` in its pool child, fed through kombu's filesystem
  transport;
* a solo-pool worker thread in this process on the in-memory broker, set up
  by the same signal, where the producer is instrumented too.

    pip install -r requirements.txt
    python -m unittest -v test_celery_recipe.py   # from this directory
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "testing"))
sys.path.insert(0, HERE)
# tasks.py imports autter_tracing, as the app does once it is copied in.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), "adapters", "python"))

from otlp_stub import (  # noqa: E402
    RELEASE,
    TEST_KEY,
    OtlpStub,
    Process,
    assert_traceback_names,
    exception_events,
    expected_frames,
    package_versions,
    recipe_env,
    write_expectations,
    write_fixture,
)

SERVICE = "shop-worker"
TASKS = os.path.join(HERE, "tasks.py")
FULFILMENT = os.path.join(HERE, "fulfilment.py")


def task_spans(spans: list[dict], task: str) -> list[dict]:
    return [s for s in spans if s["kind"] == "CONSUMER" and s["attributes"].get("celery.task_name") == task]


class CeleryRecipe(unittest.TestCase):
    scenarios: dict = {}

    @classmethod
    def tearDownClass(cls):
        write_expectations("celery", HERE, package_versions(
            "celery", "kombu", "opentelemetry-sdk", "opentelemetry-instrumentation-celery",
            "opentelemetry-exporter-otlp-proto-http",
        ), cls.scenarios)

    def check_task_spans(self, spans: list[dict]) -> dict:
        ship = task_spans(spans, "shop.ship_order")
        receipt = task_spans(spans, "shop.send_receipt")
        pickup = task_spans(spans, "shop.schedule_pickup")
        self.assertEqual((len(ship), len(receipt), len(pickup)), (2, 1, 1), [s["name"] for s in spans])
        for span in ship + receipt + pickup:
            self.assertIs(span["attributes"]["autter.tail_retained"], True)
            self.assertEqual(span["resource"]["service.name"], SERVICE)
            self.assertEqual(span["resource"]["service.version"], RELEASE)

        # Unhandled: recorded on the task span, which ends ERROR.
        ship_frames = expected_frames(FULFILMENT, "print_label") + expected_frames(TASKS, "ship_order")
        for span in ship:
            self.assertEqual(span["name"], "run/shop.ship_order")
            self.assertEqual(span["status_code"], 2)
            self.assertEqual(span["attributes"]["celery.state"], "FAILURE")
            [event] = exception_events(span)
            self.assertEqual(event["exception.type"], "fulfilment.PrinterOffline")
            self.assertRegex(event["exception.message"], r"^label printer for order 100[12] is offline$")
            assert_traceback_names(self, event["exception.stacktrace"], ship_frames)
            self.assertIn("celery/app/trace.py", event["exception.stacktrace"])
        receipt_frames = expected_frames(FULFILMENT, "print_label") + expected_frames(TASKS, "send_receipt")
        [event] = exception_events(receipt[0])
        assert_traceback_names(self, event["exception.stacktrace"], receipt_frames)

        # Handled inside the task: the task succeeds, the exception is kept.
        [event] = exception_events(pickup[0])
        self.assertEqual(pickup[0]["attributes"]["celery.state"], "SUCCESS")
        self.assertEqual(pickup[0]["status_code"], 0)
        self.assertEqual(event["exception.type"], "fulfilment.CarrierTimeout")
        self.assertIs(event["autter.handled"], True)
        pickup_frames = expected_frames(FULFILMENT, "book_courier") + expected_frames(TASKS, "schedule_pickup")
        assert_traceback_names(self, event["exception.stacktrace"], pickup_frames)
        return {
            "ship": ship, "receipt": receipt, "pickup": pickup,
            "ship_frames": ship_frames, "receipt_frames": receipt_frames, "pickup_frames": pickup_frames,
        }

    def test_prefork_worker_with_worker_process_init(self):
        stub = OtlpStub()
        self.addCleanup(stub.close)
        queue = tempfile.mkdtemp(prefix="autter-celery-")
        self.addCleanup(shutil.rmtree, queue, True)
        broker = {
            "CELERY_BROKER_URL": "filesystem://",
            "CELERY_FS_QUEUE": os.path.join(queue, "queue"),
            "CELERY_FS_PROCESSED": os.path.join(queue, "processed"),
            "CELERY_FS_CONTROL": os.path.join(queue, "control"),
        }
        for folder in ("queue", "processed", "control"):
            os.makedirs(os.path.join(queue, folder))
        env = recipe_env(stub, SERVICE, extra=broker)
        if sys.platform == "darwin":
            # macOS only: billiard 4.3 starts pool children with spawn, not
            # fork, and Celery's prefork pool then needs this to set up its
            # task tracer in them. worker_process_init fires either way.
            env["FORKED_BY_MULTIPROCESSING"] = "1"

        # Publish first (the filesystem queue keeps the messages), from an
        # uninstrumented producer, then start the worker.
        with mock.patch.dict(os.environ, broker):
            sys.modules.pop("tasks", None)
            import tasks

            tasks.ship_order.delay(1001)
            tasks.ship_order.delay(1002)
            tasks.send_receipt.delay(1001)
            tasks.schedule_pickup.delay(1001)
            sys.modules.pop("tasks", None)

        celery = os.path.join(os.path.dirname(sys.executable), "celery")
        worker = Process([celery, "-A", "tasks", "worker", "--pool=prefork", "--concurrency=1", "--loglevel=INFO"], env, HERE)
        try:
            stub.wait_for(lambda s: len([x for x in s if x["kind"] == "CONSUMER"]) >= 4, timeout=60)
        finally:
            output = worker.stop()
        spans = stub.spans()
        found = self.check_task_spans(spans)
        self.assertEqual(stub.trace_requests()[0]["headers"].get("x-autter-key"), TEST_KEY, output)
        # Four tasks, four traces: each task span is its process's local root.
        self.assertEqual(len({s["trace_id"] for s in spans}), 4)

        tasks_traces = [s["trace_id"] for s in found["ship"] + found["receipt"]]
        write_fixture(stub, "celery-task-failures", tasks_traces, HERE)
        write_fixture(stub, "celery-handled", [found["pickup"][0]["trace_id"]], HERE)
        CeleryRecipe.scenarios["task-failures"] = {
            "fixture": "celery-task-failures",
            "description": "prefork worker: ship_order(1001), ship_order(1002) and send_receipt(1001) fail in the same helper",
            "tailRetained": True,
            "occurrences": 3,
            "errorType": "fulfilment.PrinterOffline",
            "severity": "error",
            "requestCount": 3,
            "errorCount": 3,
            "groups": {
                "shop.ship_order": {"occurrences": 2, "inAppFrames": found["ship_frames"]},
                "shop.send_receipt": {"occurrences": 1, "inAppFrames": found["receipt_frames"]},
            },
        }
        CeleryRecipe.scenarios["handled"] = {
            "fixture": "celery-handled",
            "description": "prefork worker: schedule_pickup records a handled CarrierTimeout and succeeds",
            "tailRetained": True,
            "occurrences": 1,
            "errorType": "fulfilment.CarrierTimeout",
            "message": "carrier booking for order 1001 timed out",
            "severity": "error",
            "handled": True,
            "inAppFrames": found["pickup_frames"],
        }

    def test_solo_worker_thread_on_the_memory_broker(self):
        from celery.contrib.testing.worker import start_worker

        stub = OtlpStub()
        self.addCleanup(stub.close)
        env = recipe_env(stub, SERVICE)
        with mock.patch.dict(os.environ, {k: v for k, v in env.items() if k.startswith("OTEL_")}):
            sys.modules.pop("tasks", None)
            import tasks

            # The solo pool sends worker_process_init when it starts.
            with start_worker(tasks.app, pool="solo", perform_ping_check=False, shutdown_timeout=10):
                tasks.ship_order.delay(1001)
                tasks.ship_order.delay(1002)
                tasks.send_receipt.delay(1001)
                tasks.schedule_pickup.delay(1001)
                stub.wait_for(lambda s: len([x for x in s if x["kind"] == "CONSUMER"]) >= 4, timeout=30)
        spans = stub.spans()
        self.check_task_spans(spans)
        # The producer was traced too: each task span's parent is its
        # apply_async span, which was not sampled and did not fail, so it
        # was not exported.
        producers = {s["span_id"] for s in spans if s["kind"] == "PRODUCER"}
        for span in spans:
            if span["kind"] == "CONSUMER":
                self.assertTrue(span["parent_span_id"])
                self.assertNotIn(span["parent_span_id"], producers)


if __name__ == "__main__":
    unittest.main()
