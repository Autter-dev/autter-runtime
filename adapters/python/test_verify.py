"""Tests for compat.py doctor (key, storage, connectivity) and verify (stdlib only).

Run: python3 -m unittest discover -s adapters/python -v
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import compat  # noqa: E402

GOOD = "autter_rt_" + "6" * 48
APPLIED = sorted({m for f in compat.MANIFEST["features"] for m in f["migrations"]})


def ingester(storage="up", verify_route=True, store=True, version="1.12.1"):
    """A stateful stub: /v1/compat, /healthz, /livez, /v1/traces, /v1/logs, /v1/verify."""
    state = {"spans": {}, "occurrences": {}, "logs": {}, "posted": []}

    class Handler(BaseHTTPRequestHandler):
        def _json(self, status, body, headers=None):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def _authed(self):
            if self.headers.get("authorization") == f"Bearer {GOOD}":
                return True
            self._json(401, {"error": "invalid ingest key" if self.headers.get("authorization") else "missing ingest key"})
            return False

        def do_GET(self):  # noqa: N802
            if self.path == "/v1/compat":
                return self._json(200, {"ingester": {"version": version}, "schema": {"status": "ready", "applied": APPLIED}})
            if self.path == "/livez":
                return self._json(200, {"ok": True})
            if self.path == "/healthz":
                return self._json(200 if storage == "up" else 503, {"ok": storage == "up", "clickhouse": storage})
            if self.path.startswith("/v1/verify") and verify_route:
                if not self._authed():
                    return None
                trace = self.path[len("/v1/verify/"):] if self.path.startswith("/v1/verify/") else None
                body = {"storage": storage, "delivery": None}
                if trace:
                    body["stored"] = {
                        name: {"rows": len(state[name].get(trace, [])), "services": [],
                               "releases": sorted({r for r in state[name].get(trace, []) if r})}
                        for name in ("spans", "occurrences", "logs")
                    }
                return self._json(200, body)
            return self._json(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path not in ("/v1/traces", "/v1/logs"):
                return self._json(404, {})
            if not self._authed():
                return None
            if storage != "up":
                return self._json(503, {"error": "storage unavailable, retry later"})
            state["posted"].append((self.path, payload))
            for resource in payload.get("resourceSpans", []) + payload.get("resourceLogs", []):
                attrs = {a["key"]: a["value"].get("stringValue") for a in resource["resource"]["attributes"]}
                release = attrs.get("service.version")
                for scope in resource.get("scopeSpans", []):
                    for span in scope["spans"]:
                        if store:
                            state["spans"].setdefault(span["traceId"], []).append(release)
                            if span.get("events"):
                                state["occurrences"].setdefault(span["traceId"], []).append(release)
                for scope in resource.get("scopeLogs", []):
                    for record in scope["logRecords"]:
                        if store:
                            state["logs"].setdefault(record["traceId"], []).append(release)
            return self._json(200, {"partialSuccess": {}}, {"x-autter-ingest": "spans=1 occurrences=1"})

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}", state


def step(report, name):
    return next(s for s in report["steps"] if s["step"] == name)


class KeyFromEnv(unittest.TestCase):
    def test_sources(self):
        self.assertEqual(compat.key_from_env({"AUTTER_RUNTIME_KEY": " k1 "}), "k1")
        self.assertIsNone(compat.key_from_env({"AUTTER_RUNTIME_KEY": "undefined"}))
        self.assertEqual(compat.key_from_env({"OTEL_EXPORTER_OTLP_HEADERS": "x-a=b,Authorization=Bearer%20k2"}), "k2")
        self.assertEqual(compat.key_from_env({"OTEL_EXPORTER_OTLP_TRACES_HEADERS": "authorization=Bearer k3"}), "k3")
        self.assertIsNone(compat.key_from_env({}))


class Doctor(unittest.TestCase):
    def run_main(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = compat.main(list(args))
        return code, out.getvalue()

    def test_storage_unconfigured_is_not_ready(self):
        server, url, _ = ingester(storage="unconfigured")
        try:
            code, out = self.run_main("doctor", "--endpoint", url, "--features", "llm_calls")
            self.assertEqual(code, 1, out)
            self.assertIn("storage    NOT READY: no ClickHouse configured", out)
            self.assertIn("key        not checked", out)
            self.assertNotIn("Compatible.", out)
        finally:
            server.shutdown()

    def test_key_checked_with_the_ingesters_reason(self):
        server, url, _ = ingester()
        try:
            code, out = self.run_main("doctor", "--endpoint", url, "--key", "wrong", "--features", "llm_calls")
            self.assertEqual(code, 1, out)
            self.assertIn("REJECTED (401 (invalid ingest key))", out)
            code, out = self.run_main("doctor", "--endpoint", url, "--key", GOOD, "--features", "llm_calls")
            self.assertEqual(code, 0, out)
            self.assertIn("Ready: versions compatible, storage ready, key accepted.", out)
            code, out = self.run_main("doctor", "--endpoint", url, "--features", "llm_calls")
            self.assertEqual(code, 0, out)
            self.assertIn("Key not checked", out)
        finally:
            server.shutdown()

    def test_unreachable_names_the_failing_step(self):
        code, out = self.run_main("doctor", "--endpoint", "http://127.0.0.1:9", "--timeout", "1")
        self.assertEqual(code, 2, out)
        self.assertIn("FAIL tcp", out)
        self.assertIn("Could not reach the ingester: the TCP step failed.", out)


class Verify(unittest.TestCase):
    def test_every_step_passes(self):
        server, url, state = ingester()
        try:
            report, code = compat.verify(url, GOOD, "worker", release="abc", wait=2, poll=0.05)
            self.assertEqual(code, 0, report)
            for name in compat.VERIFY_STEPS:
                self.assertEqual(step(report, name)["status"], "pass", (name, step(report, name)))
            self.assertIn("spans=1", step(report, "ingest")["detail"])
            [(path, body)] = state["posted"][:1]
            attrs = {a["key"]: a["value"]["stringValue"] for a in body["resourceSpans"][0]["resource"]["attributes"]}
            self.assertEqual(attrs["autter.verify.id"], report["traceId"])
            self.assertEqual(attrs["deployment.environment"], "verify")
        finally:
            server.shutdown()

    def test_first_failing_step(self):
        report, code = compat.verify("http://127.0.0.1:9", None, "svc")
        self.assertEqual((code, report["firstFailure"]["step"]), (1, "key"))
        report, code = compat.verify("http://127.0.0.1:9", GOOD, "svc", timeout=1)
        self.assertEqual((code, report["firstFailure"]["step"]), (2, "network"))
        server, url, _ = ingester()
        try:
            report, code = compat.verify(url, "autter_rt_wrong", "svc", wait=1)
            self.assertEqual((code, report["firstFailure"]["step"]), (1, "auth"))
            self.assertIn("401: invalid ingest key", report["firstFailure"]["detail"])
        finally:
            server.shutdown()
        server, url, _ = ingester(storage="auth_failed")
        try:
            report, code = compat.verify(url, GOOD, "svc", wait=1)
            self.assertEqual((code, report["firstFailure"]["step"]), (1, "storage"))
        finally:
            server.shutdown()
        server, url, _ = ingester(store=False)
        try:
            report, code = compat.verify(url, GOOD, "svc", wait=0.3, poll=0.05)
            self.assertEqual((code, report["firstFailure"]["step"]), (1, "stored"))
        finally:
            server.shutdown()

    def test_older_ingester_gets_no_error_event(self):
        server, url, state = ingester(verify_route=False)
        try:
            report, code = compat.verify(url, GOOD, "svc", wait=1)
            self.assertEqual(code, 0, report)
            self.assertEqual(step(report, "stored")["status"], "warn")
            sent = [body for path, body in state["posted"] if body.get("resourceSpans")]
            self.assertNotIn("events", sent[0]["resourceSpans"][0]["scopeSpans"][0]["spans"][0])
        finally:
            server.shutdown()

    def test_cli_output(self):
        server, url, _ = ingester()
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                code = compat.main(["verify", "--endpoint", url, "--key", GOOD, "--service", "worker", "--wait", "2"])
            self.assertEqual(code, 0, out.getvalue())
            self.assertIn("ok   stored", out.getvalue())
            self.assertIn('Delivered: a test event from "worker"', out.getvalue())
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
