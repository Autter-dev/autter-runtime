"""Tests for the Python adapter's redaction (stdlib unittest, no deps).

Run: python3 -m unittest discover -s adapters/python -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import redact  # noqa: E402
from caught_exceptions import install_caught_sampler  # noqa: E402
from redact import MASK, configure, redact_attributes, redact_text  # noqa: E402

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "test-vectors", "redaction.json")
with open(VECTORS_PATH, encoding="utf-8") as fh:
    VECTORS = json.load(fh)


def _join(value):
    return "".join(value) if isinstance(value, list) else value


class SharedVectors(unittest.TestCase):
    def test_text_vectors(self):
        for vector in VECTORS["text"]:
            if "python" in vector.get("skip", []):
                continue
            with self.subTest(vector["name"]):
                self.assertEqual(redact_text(_join(vector["input"])), _join(vector["expect"]))

    def test_sensitive_keys_masked_at_any_depth(self):
        for key in VECTORS["keys"]["sensitive"]:
            with self.subTest(key):
                out = redact_attributes({"outer": {"items": [{key: "raw"}]}})
                self.assertEqual(out["outer"]["items"][0][key], MASK)

    def test_safe_keys_survive(self):
        for key in VECTORS["keys"]["safe"]:
            with self.subTest(key):
                self.assertEqual(redact_attributes({"outer": {key: "kept"}})["outer"][key], "kept")


class Attributes(unittest.TestCase):
    def test_nested_values_and_usage_counters(self):
        out = redact_attributes(
            {
                "db": {"dsn": "postgres://u:p@h/db", "args": ["redis://:pw@cache:6379"]},
                "gen_ai.usage.input_tokens": 12,
                "max_tokens": 100,
                "note": "contact jane@example.com",
            }
        )
        self.assertEqual(out["db"]["dsn"], MASK)
        self.assertEqual(out["db"]["args"], [f"redis://{MASK}@cache:6379"])
        self.assertEqual(out["gen_ai.usage.input_tokens"], 12)
        self.assertEqual(out["max_tokens"], MASK)
        self.assertEqual(out["note"], f"contact {MASK}")

    def test_does_not_mutate_input(self):
        original = {"password": "x", "nested": {"token": "y"}}
        redact_attributes(original)
        self.assertEqual(original, {"password": "x", "nested": {"token": "y"}})

    def test_custom_patterns(self):
        configure(value_patterns=[r"CUST-\d{4}"], key_patterns=[r"^tenant_ref$"])
        try:
            self.assertEqual(redact_text("CUST-1234 / CUST-9999"), f"{MASK} / {MASK}")
            self.assertEqual(redact_attributes({"tenant_ref": "t"}), {"tenant_ref": MASK})
        finally:
            configure()

    def test_opt_out(self):
        configure(enabled=False)
        try:
            self.assertEqual(redact_text("password=x"), "password=x")
        finally:
            configure()
        self.assertTrue(redact._enabled)


class CaughtExceptionSampler(unittest.TestCase):
    def test_traceback_message_is_scrubbed_before_emit(self):
        emitted: list[tuple[str, str]] = []

        def connect():
            raise ConnectionError("could not connect to postgres://admin:hunter2@db.internal:5432/app")

        stop = install_caught_sampler(lambda name, stack: emitted.append((name, stack)), sample_rate=1.0)
        try:
            try:
                connect()
            except ConnectionError:
                pass
        finally:
            stop()

        self.assertTrue(emitted, "sampler emitted nothing")
        name, stack = emitted[0]
        self.assertEqual(name, "ConnectionError")
        self.assertNotIn("hunter2", stack)
        self.assertIn(f"postgres://{MASK}@db.internal:5432/app", stack)
        self.assertIn("in connect", stack)


if __name__ == "__main__":
    unittest.main()
