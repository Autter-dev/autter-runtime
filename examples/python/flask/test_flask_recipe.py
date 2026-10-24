"""The Flask recipe, run for real under gunicorn (two workers, with and
without --preload), configured only by the OTEL_* variables, exporting
OTLP/HTTP to a stub.

    pip install -r requirements.txt
    python -m unittest -v test_flask_recipe.py   # from this directory
"""

from __future__ import annotations

import os
import sys
import time
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

SERVICE = "billing-flask"
APP = os.path.join(HERE, "app.py")
BILLING = os.path.join(HERE, "billing.py")


def server_span(spans: list[dict], route: str) -> dict:
    matches = [s for s in spans if s["kind"] == "SERVER" and s["attributes"].get("http.route") == route]
    assert len(matches) == 1, f"{len(matches)} server spans for {route}"
    return matches[0]


class FlaskRecipe(unittest.TestCase):
    def run_gunicorn(self, *flags: str, extra=None) -> tuple[list[dict], OtlpStub, str]:
        stub = OtlpStub()
        self.addCleanup(stub.close)
        port = free_port()
        gunicorn = os.path.join(os.path.dirname(sys.executable), "gunicorn")
        # --no-control-socket: gunicorn 26 otherwise opens ~/.gunicorn/gunicorn.ctl.
        app = App([gunicorn, "-w", "2", "-b", f"127.0.0.1:{port}", "--no-control-socket", *flags, "app:app"],
                  recipe_env(stub, SERVICE, extra=extra), HERE, port)
        try:
            self.assertEqual(app.get("/ok")[0], 200)
            # Several requests, so both workers are likely to serve some.
            for invoice_id in (31, 32, 33, 34):
                self.assertEqual(app.get(f"/invoices/{invoice_id}/summary")[0], 500)
            self.assertEqual(app.get("/invoices/31/late-fee")[0], 422)
            self.assertEqual(app.get("/invoices/31")[0], 404)
            stub.wait_for(lambda s: len([x for x in s if x["kind"] == "SERVER"]) >= 5)
        finally:
            output = app.stop()
        return stub.spans(), stub, output

    def check(self, spans: list[dict], stub: OtlpStub, output: str) -> dict:
        routes = sorted(s["attributes"]["http.route"] for s in spans if s["kind"] == "SERVER")
        self.assertEqual(routes, ["/invoices/<int:invoice_id>/late-fee"] + ["/invoices/<int:invoice_id>/summary"] * 4, output)
        for span in spans:
            self.assertIs(span["attributes"]["autter.tail_retained"], True)
            self.assertEqual(span["resource"]["service.name"], SERVICE)
            self.assertEqual(span["resource"]["service.version"], RELEASE)
        self.assertEqual(stub.trace_requests()[0]["headers"].get("x-autter-key"), TEST_KEY)

        summaries = [s for s in spans if s["attributes"].get("http.route") == "/invoices/<int:invoice_id>/summary"]
        summary = summaries[0]
        self.assertEqual(summary["attributes"]["http.status_code"], 500)
        self.assertEqual(summary["status_code"], 2)
        [event] = exception_events(summary)
        self.assertEqual(event["exception.type"], "ZeroDivisionError")
        self.assertEqual(event["exception.message"], "division by zero")
        frames = expected_frames(BILLING, "render_invoice") + expected_frames(APP, "summary")
        assert_traceback_names(self, event["exception.stacktrace"], frames)
        self.assertIn("flask/app.py", event["exception.stacktrace"])

        fee = server_span(spans, "/invoices/<int:invoice_id>/late-fee")
        self.assertEqual(fee["attributes"]["http.status_code"], 422)
        self.assertEqual(fee["status_code"], 0)
        [event] = exception_events(fee)
        self.assertEqual(event["exception.type"], "KeyError")
        self.assertEqual(event["exception.message"], "'XYZ'")
        self.assertIs(event["autter.handled"], True)
        fee_frames = expected_frames(BILLING, "late_fee") + expected_frames(APP, "fee")
        assert_traceback_names(self, event["exception.stacktrace"], fee_frames)
        return {"summary": summary, "fee": fee, "frames": frames, "fee_frames": fee_frames}

    def test_gunicorn_workers(self):
        spans, stub, output = self.run_gunicorn()
        found = self.check(spans, stub, output)
        write_fixture(stub, "flask-unhandled", [found["summary"]["trace_id"]], HERE)
        write_fixture(stub, "flask-handled", [found["fee"]["trace_id"]], HERE)
        write_expectations("flask", HERE, package_versions(
            "flask", "werkzeug", "gunicorn", "opentelemetry-sdk", "opentelemetry-instrumentation-flask",
            "opentelemetry-exporter-otlp-proto-http",
        ), {
            "unhandled": {
                "fixture": "flask-unhandled",
                "description": "GET /invoices/31/summary → 500; ZeroDivisionError recorded by the Flask instrumentation",
                "tailRetained": True,
                "occurrences": 1,
                "errorType": "ZeroDivisionError",
                "message": "division by zero",
                "route": "/invoices/<int:invoice_id>/summary",
                "statusCode": 500,
                "severity": "error",
                "requestCount": 1,
                "errorCount": 1,
                "inAppFrames": found["frames"],
            },
            "handled": {
                "fixture": "flask-handled",
                "description": "GET /invoices/31/late-fee → 422; the view records the handled KeyError",
                "tailRetained": True,
                "occurrences": 1,
                "errorType": "KeyError",
                "message": "'XYZ'",
                "route": "/invoices/<int:invoice_id>/late-fee",
                "statusCode": 422,
                "severity": "error",
                "handled": True,
                "inAppFrames": found["fee_frames"],
            },
        })

    def test_gunicorn_preload_forks_after_init(self):
        # --preload runs init_tracing() in the arbiter, before the fork; the
        # workers export through the processors' after-fork restart.
        # macOS only: a forked child that touches the system proxy settings
        # (requests does, on every export) is killed by the Objective-C
        # runtime unless this is set. Plain OpenTelemetry fails the same way;
        # Linux is unaffected.
        extra = {"OBJC_DISABLE_INITIALIZE_FORK_SAFETY": "YES"} if sys.platform == "darwin" else None
        spans, stub, output = self.run_gunicorn("--preload", extra=extra)
        self.check(spans, stub, output)

    def test_count_requests_counts_every_request_once(self):
        # AUTTER_COUNT_REQUESTS=true: every request is one point in the delta
        # http.server.duration histogram, at sampling ratio 0 too; the error
        # traces exported anyway are marked as counted by it.
        stub = OtlpStub()
        self.addCleanup(stub.close)
        port = free_port()
        gunicorn = os.path.join(os.path.dirname(sys.executable), "gunicorn")
        env = recipe_env(stub, SERVICE, extra={"AUTTER_COUNT_REQUESTS": "true", "OTEL_METRIC_EXPORT_INTERVAL": "200"})
        app = App([gunicorn, "-w", "2", "-b", f"127.0.0.1:{port}", "--no-control-socket", "app:app"], env, HERE, port)
        expected = {
            "/ok": 3,
            "/invoices/<int:invoice_id>/summary": 2,
            "/invoices/<int:invoice_id>/late-fee": 1,
            "/invoices/<int:invoice_id>": 1,
        }

        def counted(route):
            return sum(p["count"] for p in stub.histogram_points() if p["attributes"].get("http.route") == route)

        def unrouted():
            return sum(p["count"] for p in stub.histogram_points() if "http.route" not in p["attributes"])

        try:
            for _ in range(3):
                self.assertEqual(app.get("/ok")[0], 200)
            for invoice_id in (31, 32):
                self.assertEqual(app.get(f"/invoices/{invoice_id}/summary")[0], 500)
            self.assertEqual(app.get("/invoices/31/late-fee")[0], 422)
            self.assertEqual(app.get("/invoices/31")[0], 404)
            self.assertEqual(app.get("/no/such/page")[0], 404)
            stub.wait_for(lambda s: len([x for x in s if x["kind"] == "SERVER"]) >= 3)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and (
                any(counted(route) < n for route, n in expected.items()) or unrouted() < 1
            ):
                time.sleep(0.05)
        finally:
            output = app.stop()

        points = stub.histogram_points()
        # Only the helper's histogram: Flask's own http.server.duration is dropped.
        self.assertEqual({(p["name"], p["scope"]) for p in points}, {("http.server.duration", "autter.runtime")}, output)
        for point in points:
            self.assertEqual(point["temporality"], 1)  # AGGREGATION_TEMPORALITY_DELTA
            self.assertIs(point["resource"]["autter.metrics_wired"], True)
            self.assertIs(point["resource"]["autter.metrics_routes"], True)
            self.assertEqual(point["resource"]["service.name"], SERVICE)
        for route, n in expected.items():
            self.assertEqual(counted(route), n, route)
        statuses = sorted((p["attributes"]["http.route"], p["attributes"]["http.response.status_code"], p["count"])
                          for p in points if p["attributes"].get("http.route") in expected)
        self.assertEqual(sum(c for r, status, c in statuses if status == 500), 2)
        # A 404 without a route and the readiness probes on /health count too.
        self.assertEqual(unrouted(), 1)
        self.assertGreaterEqual(counted("/health"), 1)

        spans = [s for s in stub.spans() if s["kind"] == "SERVER"]
        self.assertEqual(len(spans), 3)  # the error traces only, at ratio 0
        for span in spans:
            self.assertIs(span["attributes"]["autter.metric_has_route"], True)
            self.assertIs(span["attributes"]["autter.tail_retained"], True)
            self.assertIs(span["resource"]["autter.metrics_wired"], True)


if __name__ == "__main__":
    unittest.main()
