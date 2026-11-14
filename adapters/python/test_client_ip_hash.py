"""Opt-in hashed client IP in the Python adapter: ``redact.py``'s
normalisation, source order and HMAC (stdlib, shared vectors) and
``RedactingSpanExporter`` / ``init_tracing()`` (needs opentelemetry-sdk).

Run: python3 -m unittest discover -s adapters/python -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from redact import (  # noqa: E402
    CLIENT_IP_HASH_ATTRIBUTE,
    CLIENT_IP_HASH_LENGTH,
    CLIENT_IP_SALT_MIN_LENGTH,
    CLIENT_IP_SOURCE_KEYS,
    IDENTIFYING_ATTRIBUTE_KEYS,
    client_ip_of,
    hash_client_ip,
    normalize_client_ip,
    usable_client_ip_salt,
)

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "test-vectors", "redaction.json")
with open(VECTORS_PATH, encoding="utf-8") as fh:
    VECTORS = json.load(fh)["clientIpHash"]

SALT = "project-secret-salt-7f3a9c2e41"
CLEAN_ENV = {
    "AUTTER_HASH_CLIENT_IP": "",
    "AUTTER_CLIENT_IP_SALT": "",
    "AUTTER_KEEP_IDENTIFYING_ATTRIBUTES": "",
    "AUTTER_DROP_ATTRIBUTES": "",
}


class SharedVectors(unittest.TestCase):
    def test_constants(self):
        self.assertEqual(CLIENT_IP_HASH_ATTRIBUTE, VECTORS["attribute"])
        self.assertEqual(CLIENT_IP_HASH_LENGTH, VECTORS["length"])
        self.assertNotIn(CLIENT_IP_HASH_ATTRIBUTE, IDENTIFYING_ATTRIBUTE_KEYS)
        for key in CLIENT_IP_SOURCE_KEYS:
            self.assertIn(key, IDENTIFYING_ATTRIBUTE_KEYS)

    def test_normalize(self):
        for case in VECTORS["normalize"]:
            with self.subTest(case["input"]):
                self.assertEqual(normalize_client_ip(case["input"]), case["expect"])
        self.assertIsNone(normalize_client_ip(None))
        self.assertIsNone(normalize_client_ip(42))

    def test_source_order(self):
        for case in VECTORS["source"]:
            with self.subTest(case):
                self.assertEqual(client_ip_of(case["attributes"], case["server"]), case["expect"])

    def test_hash(self):
        for case in VECTORS["hash"]:
            with self.subTest(case["input"]):
                self.assertEqual(hash_client_ip(VECTORS["salt"], normalize_client_ip(case["input"])), case["expect"])

    def test_short_salts_are_refused(self):
        self.assertIsNone(usable_client_ip_salt("x" * (CLIENT_IP_SALT_MIN_LENGTH - 1)))
        self.assertEqual(usable_client_ip_salt("x" * CLIENT_IP_SALT_MIN_LENGTH), "x" * CLIENT_IP_SALT_MIN_LENGTH)
        self.assertIsNone(usable_client_ip_salt(None))


try:
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from opentelemetry.sdk.trace.sampling import ALWAYS_ON
    from opentelemetry.trace import SpanKind

    from autter_tracing import RedactingSpanExporter, init_tracing

    HAVE_OTEL = True
except ImportError:  # pragma: no cover - depends on the environment
    HAVE_OTEL = False


@unittest.skipUnless(HAVE_OTEL, "opentelemetry-sdk is not installed")
class HashingExporter(unittest.TestCase):
    def export(self, env=None, **options):
        exporter = InMemorySpanExporter()
        with mock.patch.dict(os.environ, {**CLEAN_ENV, **(env or {})}):
            wrapped = RedactingSpanExporter(exporter, **options)
        provider = TracerProvider(sampler=ALWAYS_ON, resource=Resource.create({"service.name": "shop"}))
        provider.add_span_processor(SimpleSpanProcessor(wrapped))
        tracer = provider.get_tracer("test")
        # Django/Flask server span: X-Forwarded-For in http.client_ip, the proxy as peer.
        with tracer.start_as_current_span(
            "GET /", kind=SpanKind.SERVER, attributes={"http.client_ip": "203.0.113.9", "net.peer.ip": "10.0.0.2"}
        ):
            pass
        # An outgoing call: the peer is the server called, never hashed.
        with tracer.start_as_current_span("GET api", kind=SpanKind.CLIENT, attributes={"net.peer.ip": "10.0.0.9"}):
            pass
        with tracer.start_as_current_span("manual", attributes={"client.address": "::ffff:198.51.100.7"}):
            pass
        with tracer.start_as_current_span(
            "prehashed", attributes={"client.address": "198.51.100.8", CLIENT_IP_HASH_ATTRIBUTE: "set-upstream"}
        ):
            pass
        provider.shutdown()
        return {span.name: span for span in exporter.get_finished_spans()}

    def assert_no_raw_address(self, spans):
        for span in spans.values():
            for key in IDENTIFYING_ATTRIBUTE_KEYS:
                self.assertNotIn(key, span.attributes)

    def test_off_by_default(self):
        spans = self.export()
        self.assert_no_raw_address(spans)
        self.assertNotIn(CLIENT_IP_HASH_ATTRIBUTE, spans["GET /"].attributes)
        self.assertEqual(spans["prehashed"].attributes[CLIENT_IP_HASH_ATTRIBUTE], "set-upstream")

    def test_hash_with_salt_argument(self):
        spans = self.export(hash_client_ip=True, client_ip_salt=SALT)
        self.assert_no_raw_address(spans)
        self.assertEqual(spans["GET /"].attributes[CLIENT_IP_HASH_ATTRIBUTE], hash_client_ip(SALT, "203.0.113.9"))
        self.assertEqual(spans["manual"].attributes[CLIENT_IP_HASH_ATTRIBUTE], hash_client_ip(SALT, "198.51.100.7"))
        self.assertNotIn(CLIENT_IP_HASH_ATTRIBUTE, spans["GET api"].attributes)
        self.assertEqual(spans["prehashed"].attributes[CLIENT_IP_HASH_ATTRIBUTE], "set-upstream")
        for span in spans.values():
            self.assertNotIn(SALT, json.dumps(dict(span.attributes)))

    def test_environment_and_redact_false(self):
        spans = self.export(env={"AUTTER_HASH_CLIENT_IP": "true", "AUTTER_CLIENT_IP_SALT": SALT}, redact=False)
        self.assert_no_raw_address(spans)
        self.assertEqual(spans["GET /"].attributes[CLIENT_IP_HASH_ATTRIBUTE], hash_client_ip(SALT, "203.0.113.9"))

    def test_without_a_usable_salt_nothing_is_hashed_and_it_warns(self):
        with self.assertLogs("autter.runtime", level="WARNING") as logs:
            spans = self.export(hash_client_ip=True, client_ip_salt="short-salt")
        self.assert_no_raw_address(spans)
        self.assertNotIn(CLIENT_IP_HASH_ATTRIBUTE, spans["GET /"].attributes)
        self.assertEqual(len(logs.output), 1)
        self.assertIn("no salt", logs.output[0])
        self.assertNotIn("short-salt", logs.output[0])

    def test_init_tracing_wires_the_options(self):
        exporter = InMemorySpanExporter()
        with mock.patch.dict(os.environ, CLEAN_ENV):
            provider = init_tracing(
                sampler=ALWAYS_ON,
                exporter=exporter,
                resource=Resource.create({"service.name": "shop"}),
                set_global=False,
                hash_client_ip=True,
                client_ip_salt=SALT,
            )
        with provider.get_tracer("test").start_as_current_span(
            "GET /", kind=SpanKind.SERVER, attributes={"client.address": "203.0.113.9"}
        ):
            pass
        provider.force_flush()
        [span] = exporter.get_finished_spans()
        self.assertEqual(span.attributes[CLIENT_IP_HASH_ATTRIBUTE], hash_client_ip(SALT, "203.0.113.9"))
        self.assertNotIn("client.address", span.attributes)
        provider.shutdown()


if __name__ == "__main__":
    unittest.main()
