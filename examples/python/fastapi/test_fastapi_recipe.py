"""The FastAPI recipe, run for real: uvicorn in its own process, configured
only by the OTEL_* variables, exporting OTLP/HTTP to a stub.

    pip install -r requirements.txt
    python -m unittest -v test_fastapi_recipe.py   # from this directory
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

SERVICE = "shop-fastapi"
APP = os.path.join(HERE, "app.py")
INVENTORY = os.path.join(HERE, "inventory.py")
GROUPS = sys.version_info >= (3, 11)


def server_span(spans: list[dict], route: str) -> dict:
    matches = [s for s in spans if s["kind"] == "SERVER" and s["attributes"].get("http.route") == route]
    assert len(matches) == 1, f"{len(matches)} server spans for {route}"
    return matches[0]


class FastAPIRecipe(unittest.TestCase):
    def test_unsampled_traffic_still_exports_every_error(self):
        stub = OtlpStub()
        self.addCleanup(stub.close)
        port = free_port()
        app = App([sys.executable, "-m", "uvicorn", "app:app", "--port", str(port)],
                  recipe_env(stub, SERVICE), HERE, port)
        expected_servers = 3 if GROUPS else 2
        try:
            self.assertEqual(app.get("/ok")[0], 200)
            self.assertEqual(app.post("/carts/12/checkout")[0], 500)
            self.assertEqual(app.get("/carts/12/quote")[0], 200)
            if GROUPS:
                self.assertEqual(app.get("/carts/12/availability")[0], 500)
            self.assertEqual(app.get("/items/9")[0], 404)
            stub.wait_for(lambda s: len([x for x in s if x["kind"] == "SERVER"]) >= expected_servers)
        finally:
            output = app.stop()
        spans = stub.spans()

        routes = sorted(s["attributes"]["http.route"] for s in spans if s["kind"] == "SERVER")
        expected = ["/carts/{cart_id}/checkout", "/carts/{cart_id}/quote"]
        if GROUPS:
            expected.insert(0, "/carts/{cart_id}/availability")
        self.assertEqual(routes, expected, output)
        for span in spans:
            self.assertIs(span["attributes"]["autter.tail_retained"], True)
            self.assertEqual(span["resource"]["service.name"], SERVICE)
            self.assertEqual(span["resource"]["service.version"], RELEASE)
        self.assertEqual(stub.trace_requests()[0]["headers"].get("x-autter-key"), TEST_KEY)

        # Unhandled → 500, recorded by the ASGI middleware on the request span.
        checkout = server_span(spans, "/carts/{cart_id}/checkout")
        self.assertEqual(checkout["attributes"]["http.status_code"], 500)
        self.assertEqual(checkout["status_code"], 2)
        [event] = exception_events(checkout)
        self.assertEqual(event["exception.type"], "inventory.OutOfStock")
        self.assertEqual(event["exception.message"], "sku-1: 2 requested, 0 left")
        checkout_frames = expected_frames(INVENTORY, "reserve") + expected_frames(APP, "checkout")
        assert_traceback_names(self, event["exception.stacktrace"], checkout_frames)
        self.assertIn("starlette/", event["exception.stacktrace"])
        # The ASGI "http send" span of the 500 is errored too, with no
        # exception: the ingester folds it into the request's error.
        sends = [s for s in spans if s["parent_span_id"] == checkout["span_id"] and s["status_code"] == 2]
        self.assertEqual([s["name"] for s in sends], ["POST /carts/{cart_id}/checkout http send"])
        self.assertEqual(exception_events(sends[0]), [])

        # Handled inside a sync route (run in the thread pool): the request
        # span is still the current span there.
        quote = server_span(spans, "/carts/{cart_id}/quote")
        self.assertEqual(quote["attributes"]["http.status_code"], 200)
        self.assertEqual(quote["status_code"], 0)
        [event] = exception_events(quote)
        self.assertEqual(event["exception.type"], "inventory.PricingTimeout")
        self.assertIs(event["autter.handled"], True)
        quote_frames = expected_frames(INVENTORY, "price") + expected_frames(APP, "quote")
        assert_traceback_names(self, event["exception.stacktrace"], quote_frames)

        write_fixture(stub, "fastapi-unhandled", [checkout["trace_id"]], HERE)
        write_fixture(stub, "fastapi-handled", [quote["trace_id"]], HERE)
        scenarios = {
            "unhandled": {
                "fixture": "fastapi-unhandled",
                "description": "POST /carts/12/checkout → 500; the request span records it, its http send span is errored without an exception",
                "tailRetained": True,
                "occurrences": 1,
                "errorType": "inventory.OutOfStock",
                "message": "sku-1: 2 requested, 0 left",
                "route": "/carts/{cart_id}/checkout",
                "statusCode": 500,
                "severity": "error",
                "requestCount": 1,
                "errorCount": 1,
                "inAppFrames": checkout_frames,
            },
            "handled": {
                "fixture": "fastapi-handled",
                "description": "GET /carts/12/quote → 200; a sync route records the handled exception",
                "tailRetained": True,
                "occurrences": 1,
                "errorType": "inventory.PricingTimeout",
                "message": "pricing for cart 12 timed out after 2.5s",
                "route": "/carts/{cart_id}/quote",
                "statusCode": 200,
                "severity": "error",
                "handled": True,
                "inAppFrames": quote_frames,
            },
        }

        if GROUPS:
            # 3.11+: the TaskGroup's ExceptionGroup, with both sub-exceptions.
            availability = server_span(spans, "/carts/{cart_id}/availability")
            [event] = exception_events(availability)
            self.assertEqual(event["exception.type"], "ExceptionGroup")
            self.assertEqual(event["exception.message"], "unhandled errors in a TaskGroup (2 sub-exceptions)")
            stack = event["exception.stacktrace"]
            self.assertIn("+ Exception Group Traceback (most recent call last):", stack)
            self.assertIn("asyncio/taskgroups.py", stack)
            group_frames = expected_frames(APP, "availability")
            for frame in group_frames:
                self.assertIn(f'|   File "{frame["filename"]}", line {frame["lineno"]}, in {frame["function"]}', stack)
            for frame in expected_frames(INVENTORY, "check_warehouse"):
                self.assertIn(f'|   File "{frame["filename"]}", line {frame["lineno"]}, in {frame["function"]}', stack)
            self.assertIn("ConnectionError: warehouse north unreachable", stack)
            self.assertIn("ConnectionError: warehouse south unreachable", stack)
            write_fixture(stub, "fastapi-exception-group", [availability["trace_id"]], HERE)
            scenarios["exception-group"] = {
                "fixture": "fastapi-exception-group",
                "description": "GET /carts/12/availability → 500; asyncio.TaskGroup raises an ExceptionGroup of two ConnectionErrors",
                "tailRetained": True,
                "occurrences": 1,
                "errorType": "ExceptionGroup",
                "message": "unhandled errors in a TaskGroup (2 sub-exceptions)",
                "route": "/carts/{cart_id}/availability",
                "statusCode": 500,
                "severity": "error",
                "requestCount": 1,
                "errorCount": 1,
                "inAppFrames": group_frames,
            }

        write_expectations("fastapi", HERE, package_versions(
            "fastapi", "starlette", "uvicorn", "opentelemetry-sdk", "opentelemetry-instrumentation-fastapi",
            "opentelemetry-exporter-otlp-proto-http",
        ), scenarios)


if __name__ == "__main__":
    unittest.main()
