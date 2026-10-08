"""Tests for the Python adapter's version compatibility check (stdlib only).

Run: python3 -m unittest discover -s adapters/python -v
"""

from __future__ import annotations

import io
import json
import logging
import os
import sys
import threading
import time
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import compat  # noqa: E402

MANIFEST_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "packages", "otlp-ingester", "src", "compat-manifest.json"
)


def serve(routes):
    """routes: {(method, path): (status, body, headers)}; default 404."""

    class Handler(BaseHTTPRequestHandler):
        def _reply(self):
            length = int(self.headers.get("content-length") or 0)
            if length:
                self.rfile.read(length)
            status, body, headers = routes.get((self.command, self.path), (404, "", {}))
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body.encode())

        do_GET = do_POST = _reply

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def report(version, applied=None):
    return json.dumps({"ingester": {"version": version}, "schema": {"status": "ready", "applied": applied or []}})


class Manifest(unittest.TestCase):
    def test_embedded_manifest_matches_the_source_of_truth(self):
        with open(MANIFEST_PATH, encoding="utf-8") as fh:
            self.assertEqual(compat.MANIFEST, json.load(fh))

    def test_versions(self):
        self.assertTrue(compat.version_at_least("1.4.0", "1.4.0"))
        self.assertFalse(compat.version_at_least("1.4.0-rc.1", "1.4.0"))
        self.assertTrue(compat.version_at_least("v1.10.0", "1.9.0"))
        self.assertIsNone(compat.version_at_least("latest", "1.0.0"))


class Check(unittest.TestCase):
    def setUp(self):
        compat._warned.clear()
        self.stream = io.StringIO()
        self.logger = logging.getLogger(f"autter.test.{self.id()}")
        self.logger.addHandler(logging.StreamHandler(self.stream))
        self.logger.setLevel(logging.DEBUG)
        self.logger.propagate = False

    def test_old_ingester_warns_once_with_versions_and_fix(self):
        server, url = serve({("GET", "/v1/compat"): (200, report("1.3.4"), {})})
        try:
            for _ in range(2):
                thread = compat.warn_if_incompatible(url, ["operation_logging"], logger=self.logger)
                thread.join(5)
            lines = [l for l in self.stream.getvalue().splitlines() if "Operation logging" in l]
            self.assertEqual(len(lines), 1)
            self.assertRegex(lines[0], r"Operation logging needs ingester >= 1\.4\.0; yours is 1\.3\.4\. Upgrade the ingester: docker pull")
        finally:
            server.shutdown()

    def test_no_warning_when_compatible(self):
        applied = ["0004-llm-calls", "0005-latency-histograms", "0008-memory-signals",
                   "0010-memory-temporality", "0011-runtime-logs"]
        server, url = serve({("GET", "/v1/compat"): (200, report("1.4.0", applied), {})})
        try:
            issues = compat.check_once(url, compat.PYTHON_FEATURES, logger=self.logger)
            self.assertEqual(issues, [])
            self.assertNotIn("[autter-runtime]", self.stream.getvalue())
        finally:
            server.shutdown()

    def test_legacy_ingester_probe(self):
        server, url = serve({("POST", "/v1/traces"): (401, "", {})})  # /v1/compat and /v1/logs: 404
        try:
            issues = compat.check_once(url, ["operation_logging"], logger=self.logger)
            self.assertEqual(len(issues), 1)
            self.assertIn("no /v1/logs route", issues[0]["message"])
        finally:
            server.shutdown()

    def test_unreachable_never_raises_or_blocks(self):
        started = time.monotonic()
        thread = compat.warn_if_incompatible("http://127.0.0.1:9", ["operation_logging"], logger=self.logger)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(thread.daemon)
        thread.join(5)
        self.assertNotIn("[autter-runtime]", self.stream.getvalue())
        self.assertEqual(compat.check_once("not a url", ["operation_logging"]), [])

    def test_disabled_by_env(self):
        os.environ["AUTTER_COMPAT_CHECK"] = "0"
        try:
            self.assertIsNone(compat.warn_if_incompatible("http://127.0.0.1:9", ["operation_logging"]))
        finally:
            del os.environ["AUTTER_COMPAT_CHECK"]

    def test_doctor_exit_codes(self):
        server, url = serve({("GET", "/v1/compat"): (200, report("1.3.2"), {})})
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                code = compat.main(["doctor", "--endpoint", url, "--features", "memory_metrics"])
            self.assertEqual(code, 1)
            self.assertIn("Memory pressure detection needs ingester >= 1.3.3; yours is 1.3.2", out.getvalue())
        finally:
            server.shutdown()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(compat.main(["doctor", "--endpoint", "http://127.0.0.1:9", "--timeout", "1"]), 2)


if __name__ == "__main__":
    unittest.main()
