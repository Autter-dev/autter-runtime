"""The Django recipe, run for real: `manage.py runserver` in its own process,
configured only by the OTEL_* variables, exporting OTLP/HTTP to a stub.

    pip install -r requirements.txt
    python -m unittest -v test_django_recipe.py   # from this directory
"""

from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "testing"))

from otlp_stub import (  # noqa: E402
    RELEASE,
    TEST_KEY,
    App,
    OtlpStub,
    assert_traceback_names,
    exception_events,
    expected_frames,
    free_port,
    package_versions,
    recipe_env,
    write_expectations,
    write_fixture,
)

SERVICE = "shop-django"
PAYMENTS = os.path.join(HERE, "shop", "payments.py")
VIEWS = os.path.join(HERE, "shop", "views.py")


def start(stub: OtlpStub, *, ratio: str = "0", zero_code: bool = False, extra=None) -> App:
    port = free_port()
    argv = [sys.executable, "manage.py", "runserver", f"127.0.0.1:{port}", "--noreload"]
    if zero_code:
        argv = [os.path.join(os.path.dirname(sys.executable), "opentelemetry-instrument"), *argv]
    return App(argv, recipe_env(stub, SERVICE, ratio=ratio, extra=extra), HERE, port)


def server_span(spans: list[dict], route: str) -> dict:
    matches = [s for s in spans if s["kind"] == "SERVER" and s["attributes"].get("http.route") == route]
    assert len(matches) == 1, f"{len(matches)} server spans for {route}"
    return matches[0]


class DjangoRecipe(unittest.TestCase):
    scenarios: dict = {}

    @classmethod
    def tearDownClass(cls):
        write_expectations("django", HERE, package_versions(
            "django", "opentelemetry-sdk", "opentelemetry-instrumentation-django",
            "opentelemetry-exporter-otlp-proto-http",
        ), cls.scenarios)

    def setUp(self):
        self.stub = OtlpStub()
        self.addCleanup(self.stub.close)

    def test_unsampled_traffic_still_exports_every_error(self):
        app = start(self.stub, ratio="0")
        try:
            self.assertEqual(app.get("/ok")[0], 200)
            self.assertEqual(app.get("/orders/4821/charge")[0], 500)
            self.assertEqual(app.get("/orders/4821/refund")[0], 202)
            self.assertEqual(app.get("/orders/7")[0], 404)
            spans = self.stub.wait_for(lambda s: len([x for x in s if x["kind"] == "SERVER"]) >= 2)
        finally:
            output = app.stop()
        spans = self.stub.spans()

        # Only the two errored requests: the healthy one and the 404 were
        # not sampled and had no error.
        routes = sorted(s["attributes"].get("http.route") for s in spans if s["kind"] == "SERVER")
        self.assertEqual(routes, ["orders/<int:order_id>/charge", "orders/<int:order_id>/refund"], output)
        for span in spans:
            self.assertIs(span["attributes"]["autter.tail_retained"], True)
            self.assertEqual(span["resource"]["service.name"], SERVICE)
            self.assertEqual(span["resource"]["service.version"], RELEASE)
            self.assertEqual(span["resource"]["deployment.environment"], "test")
        self.assertEqual(self.stub.trace_requests()[0]["headers"].get("x-autter-key"), TEST_KEY)

        # Unhandled → Django's 500: DjangoInstrumentor records it on the
        # request span, and the recipe's own span records it as well.
        charge = server_span(spans, "orders/<int:order_id>/charge")
        self.assertEqual(charge["attributes"]["http.status_code"], 500)
        self.assertEqual(charge["status_code"], 2)
        [event] = exception_events(charge)
        self.assertEqual(event["exception.type"], "shop.payments.PaymentDeclined")
        self.assertEqual(event["exception.message"], "card declined for order 4821")
        stack = event["exception.stacktrace"]
        self.assertTrue(stack.startswith("Traceback (most recent call last):"))
        self.assertIn("The above exception was the direct cause of the following exception:", stack)
        self.assertIn("django/core/handlers/base.py", stack)
        frames = expected_frames(PAYMENTS, "charge_card") + expected_frames(VIEWS, "charge")
        assert_traceback_names(self, stack, frames)
        assert_traceback_names(self, stack, expected_frames(PAYMENTS, "_call_gateway"))
        # The cause's message carried URL credentials; redact.py masked them.
        self.assertNotIn("hunter2", stack)
        self.assertIn("https://[redacted]@pay.example.com answered 402", stack)
        child = next(s for s in spans if s["name"] == "payments.charge_card")
        self.assertEqual(child["parent_span_id"], charge["span_id"])
        self.assertEqual(exception_events(child)[0]["exception.type"], "shop.payments.PaymentDeclined")

        # Handled → 202: recorded by the view, status left alone.
        refund = server_span(spans, "orders/<int:order_id>/refund")
        self.assertEqual(refund["attributes"]["http.status_code"], 202)
        self.assertEqual(refund["status_code"], 0)
        [event] = exception_events(refund)
        self.assertEqual(event["exception.type"], "shop.payments.RefundPending")
        self.assertIs(event["autter.handled"], True)
        self.assertIn("During handling of the above exception, another exception occurred:", event["exception.stacktrace"])
        refund_frames = expected_frames(PAYMENTS, "refund_card") + expected_frames(VIEWS, "refund")
        assert_traceback_names(self, event["exception.stacktrace"], refund_frames)

        write_fixture(self.stub, "django-unhandled", [charge["trace_id"]], HERE)
        write_fixture(self.stub, "django-handled", [refund["trace_id"]], HERE)
        DjangoRecipe.scenarios["unhandled"] = {
            "fixture": "django-unhandled",
            "description": "GET /orders/4821/charge → 500 on an unsampled trace; recorded on the request span and on payments.charge_card",
            "tailRetained": True,
            "occurrences": 1,
            "mergedRecordings": 2,
            "errorType": "shop.payments.PaymentDeclined",
            "message": "card declined for order 4821",
            "route": "orders/<int:order_id>/charge",
            "statusCode": 500,
            "severity": "error",
            "requestCount": 1,
            "errorCount": 1,
            "inAppFrames": frames,
        }
        DjangoRecipe.scenarios["handled"] = {
            "fixture": "django-handled",
            "description": "GET /orders/4821/refund → 202; the view records the handled exception",
            "tailRetained": True,
            "occurrences": 1,
            "errorType": "shop.payments.RefundPending",
            "message": "refund for order 4821 is still settling",
            "route": "orders/<int:order_id>/refund",
            "statusCode": 202,
            "severity": "error",
            "handled": True,
            "inAppFrames": refund_frames,
        }

    def test_sampled_traffic_exports_unmarked(self):
        app = start(self.stub, ratio="1")
        try:
            self.assertEqual(app.get("/ok")[0], 200)
            self.assertEqual(app.get("/orders/4821/charge")[0], 500)
            self.stub.wait_for(lambda s: len([x for x in s if x["kind"] == "SERVER" and x["attributes"].get("http.route") != "health"]) >= 2)
        finally:
            app.stop()
        spans = [s for s in self.stub.spans() if s["attributes"].get("http.route") != "health"]
        for span in spans:
            self.assertNotIn("autter.tail_retained", span["attributes"])
        self.assertEqual(server_span(spans, "ok")["attributes"]["http.status_code"], 200)
        charge = server_span(spans, "orders/<int:order_id>/charge")
        self.assertEqual(exception_events(charge)[0]["exception.type"], "shop.payments.PaymentDeclined")
        write_fixture(self.stub, "django-unhandled-sampled", [charge["trace_id"]], HERE)
        DjangoRecipe.scenarios["unhandled-sampled"] = {
            "fixture": "django-unhandled-sampled",
            "description": "the same 500 on a head-sampled trace",
            "tailRetained": False,
            "occurrences": 1,
            "mergedRecordings": 2,
            "errorType": "shop.payments.PaymentDeclined",
            "message": "card declined for order 4821",
            "route": "orders/<int:order_id>/charge",
            "statusCode": 500,
            "severity": "error",
            "requestCount": 1,
            "errorCount": 1,
            "inAppFrames": expected_frames(PAYMENTS, "charge_card") + expected_frames(VIEWS, "charge"),
        }

    def test_zero_code_opentelemetry_instrument_at_full_sampling(self):
        # The env-var-only path: opentelemetry-instrument configures the SDK
        # itself, so it must sample everything to keep every error.
        app = start(self.stub, zero_code=True, extra={
            "OTEL_TRACES_SAMPLER": "parentbased_always_on",
            "OTEL_METRICS_EXPORTER": "none",
            "OTEL_LOGS_EXPORTER": "none",
            "DJANGO_SETTINGS_MODULE": "shop.settings",
        })
        try:
            self.assertEqual(app.get("/orders/4821/charge")[0], 500)
            self.stub.wait_for(lambda s: any(x["attributes"].get("http.route") == "orders/<int:order_id>/charge" for x in s))
        finally:
            output = app.stop()
        self.assertNotIn("drops the errors of unsampled traces", output)
        charge = server_span(self.stub.spans(), "orders/<int:order_id>/charge")
        self.assertNotIn("autter.tail_retained", charge["attributes"])
        [event] = exception_events(charge)
        self.assertEqual(event["exception.type"], "shop.payments.PaymentDeclined")
        frames = expected_frames(PAYMENTS, "charge_card") + expected_frames(VIEWS, "charge")
        assert_traceback_names(self, event["exception.stacktrace"], frames)


if __name__ == "__main__":
    unittest.main()
