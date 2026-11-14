"""Identifying attributes (client address, raw user agent, host id, command
line) in the Python adapter: ``redact.py``'s list and filter (stdlib) and
``autter_tracing.RedactingSpanExporter`` / ``init_tracing()`` (needs
opentelemetry-sdk; skipped without it).

Run: python3 -m unittest discover -s adapters/python -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import redact  # noqa: E402
from redact import (  # noqa: E402
    IDENTIFYING_ATTRIBUTE_KEYS,
    drop_attributes_from_env,
    drop_identifying_attributes,
    identifying_keys_to_drop,
    keep_identifying_from_env,
)

VECTORS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "test-vectors", "redaction.json")
with open(VECTORS_PATH, encoding="utf-8") as fh:
    VECTORS = json.load(fh)["identifying"]

CLEAN_ENV = {"AUTTER_KEEP_IDENTIFYING_ATTRIBUTES": "", "AUTTER_DROP_ATTRIBUTES": ""}


def _sample():
    return {key: f"v:{key}" for key in [*VECTORS["drop"], *VECTORS["keep"]]}


class IdentifyingList(unittest.TestCase):
    def test_list_matches_the_shared_vectors(self):
        self.assertEqual(sorted(IDENTIFYING_ATTRIBUTE_KEYS), sorted(VECTORS["drop"]))
        self.assertEqual(len(set(IDENTIFYING_ATTRIBUTE_KEYS)), len(IDENTIFYING_ATTRIBUTE_KEYS))
        for key in VECTORS["keep"]:
            self.assertNotIn(key, IDENTIFYING_ATTRIBUTE_KEYS)
        self.assertNotIn("host.name", IDENTIFYING_ATTRIBUTE_KEYS)

    def test_default_drops_every_listed_key_and_keeps_the_rest(self):
        source = _sample()
        out = drop_identifying_attributes(source)
        self.assertEqual(sorted(out), sorted(VECTORS["keep"]))
        self.assertEqual(out["service.instance.id"], "v:service.instance.id")
        self.assertEqual(len(source), len(VECTORS["drop"]) + len(VECTORS["keep"]), "input not mutated")

    def test_unchanged_input_is_returned_as_is(self):
        attributes = {"http.route": "/x", "service.instance.id": "abc"}
        self.assertIs(drop_identifying_attributes(attributes), attributes)
        self.assertIsNone(drop_identifying_attributes(None))

    def test_keep_true_list_and_extra_drop(self):
        self.assertEqual(identifying_keys_to_drop(True), frozenset())
        self.assertEqual(identifying_keys_to_drop(False), frozenset(VECTORS["drop"]))
        some = identifying_keys_to_drop(["http.user_agent", "host.id", "not.listed"])
        out = drop_identifying_attributes(_sample(), some)
        self.assertEqual(out["http.user_agent"], "v:http.user_agent")
        self.assertEqual(out["host.id"], "v:host.id")
        self.assertNotIn("net.peer.ip", out)
        self.assertNotIn("client.address", out)
        self.assertEqual(out["service.instance.id"], "v:service.instance.id")
        extra = identifying_keys_to_drop(None, ["host.name"])
        self.assertEqual(
            drop_identifying_attributes({"host.name": "web-1", "service.instance.id": "a"}, extra),
            {"service.instance.id": "a"},
        )
        # A key both kept and listed as extra is dropped.
        self.assertIn("host.id", identifying_keys_to_drop(["host.id"], ["host.id"]))

    def test_drop_applies_with_redaction_disabled(self):
        try:
            redact.configure(enabled=False)
            self.assertNotIn("net.peer.ip", drop_identifying_attributes({"net.peer.ip": "203.0.113.9"}))
        finally:
            redact.configure()

    def test_env_parsing(self):
        self.assertIsNone(keep_identifying_from_env(None))
        self.assertIsNone(keep_identifying_from_env("  "))
        for raw in ("true", "TRUE", "1", "yes", "on", "all"):
            self.assertIs(keep_identifying_from_env(raw), True, raw)
        for raw in ("false", "0", "no", "off", "none"):
            self.assertIs(keep_identifying_from_env(raw), False, raw)
        self.assertEqual(keep_identifying_from_env(" http.user_agent, host.id ,,"), ["http.user_agent", "host.id"])
        self.assertIsNone(drop_attributes_from_env(" , "))
        self.assertEqual(drop_attributes_from_env("host.name, k8s.pod.name"), ["host.name", "k8s.pod.name"])


try:
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from opentelemetry.sdk.trace.sampling import ALWAYS_ON
    from opentelemetry.trace import Link, SpanContext, TraceFlags

    import autter_tracing
    from autter_tracing import RedactingSpanExporter, init_tracing

    HAVE_OTEL = True
except ImportError:  # pragma: no cover - depends on the environment
    HAVE_OTEL = False

RESOURCE = {
    "service.name": "shop",
    "service.instance.id": "inst-1",
    "host.name": "web-7f9c",
    "host.id": "machine-1",
    "process.pid": 42,
    "process.command_line": "python app.py --db=postgres://u:p@db",
    "process.owner": "jane",
    "process.runtime.name": "cpython",
}

SPAN = {
    "net.peer.ip": "203.0.113.9",
    "client.address": "203.0.113.9",
    "http.user_agent": "Mozilla/5.0",
    "user_agent.original": "Mozilla/5.0",
    "http.route": "/users/<id>",
    "user.email": "jane@example.com",
}


@unittest.skipUnless(HAVE_OTEL, "opentelemetry-sdk is not installed")
class IdentifyingExporter(unittest.TestCase):
    def export(self, **options):
        exporter = InMemorySpanExporter()
        provider = TracerProvider(sampler=ALWAYS_ON, resource=Resource.create(RESOURCE))
        provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exporter, **options)))
        tracer = provider.get_tracer("test")
        link = Link(
            SpanContext(0x0AF7651916CD43DD8448EB211C80319C, 0xB7AD6B7169203331, is_remote=True, trace_flags=TraceFlags(1)),
            {"network.peer.address": "198.51.100.8", "link.note": "kept"},
        )
        with tracer.start_as_current_span("GET /users", attributes=SPAN, links=[link]) as span:
            span.add_event("peer", {"net.peer.port": 51234, "event.note": "kept"})
        provider.shutdown()
        [span] = exporter.get_finished_spans()
        return span

    def assert_kept_identity(self, span):
        self.assertEqual(span.resource.attributes["service.instance.id"], "inst-1")
        self.assertEqual(span.resource.attributes["host.name"], "web-7f9c")
        self.assertEqual(span.resource.attributes["process.pid"], 42)
        self.assertEqual(span.resource.attributes["process.runtime.name"], "cpython")
        self.assertEqual(span.attributes["http.route"], "/users/<id>")
        self.assertEqual(span.events[0].attributes["event.note"], "kept")
        self.assertEqual(span.links[0].attributes["link.note"], "kept")

    def assert_dropped(self, span, keys):
        bags = [span.attributes, span.resource.attributes, span.events[0].attributes, span.links[0].attributes]
        for key in keys:
            for bag in bags:
                self.assertNotIn(key, bag)

    def test_default_drops_from_spans_events_links_and_resource(self):
        with mock.patch.dict(os.environ, CLEAN_ENV):
            span = self.export()
        self.assert_dropped(span, IDENTIFYING_ATTRIBUTE_KEYS)
        self.assert_kept_identity(span)
        self.assertEqual(span.attributes["user.email"], redact.MASK)

    def test_drop_applies_with_redact_false(self):
        with mock.patch.dict(os.environ, CLEAN_ENV):
            span = self.export(redact=False)
        self.assert_dropped(span, IDENTIFYING_ATTRIBUTE_KEYS)
        self.assert_kept_identity(span)
        self.assertEqual(span.attributes["user.email"], "jane@example.com")

    def test_keep_true_and_list(self):
        with mock.patch.dict(os.environ, CLEAN_ENV):
            everything = self.export(keep_identifying_attributes=True)
            some = self.export(keep_identifying_attributes=["http.user_agent", "process.owner"])
        self.assertEqual(everything.attributes["net.peer.ip"], "203.0.113.9")
        self.assertEqual(everything.resource.attributes["host.id"], "machine-1")
        self.assertEqual(everything.events[0].attributes["net.peer.port"], 51234)
        self.assertEqual(some.attributes["http.user_agent"], "Mozilla/5.0")
        self.assertEqual(some.resource.attributes["process.owner"], "jane")
        self.assert_dropped(some, [k for k in IDENTIFYING_ATTRIBUTE_KEYS if k not in ("http.user_agent", "process.owner")])
        self.assert_kept_identity(some)

    def test_environment_and_extra_drop(self):
        env = {"AUTTER_KEEP_IDENTIFYING_ATTRIBUTES": "client.address", "AUTTER_DROP_ATTRIBUTES": "host.name"}
        with mock.patch.dict(os.environ, env):
            span = self.export()
        self.assertEqual(span.attributes["client.address"], "203.0.113.9")
        self.assertNotIn("host.name", span.resource.attributes)
        self.assertEqual(span.resource.attributes["service.instance.id"], "inst-1")
        self.assert_dropped(span, [k for k in IDENTIFYING_ATTRIBUTE_KEYS if k != "client.address"])

    def test_init_tracing_wires_the_options_also_with_redact_false(self):
        exporter = InMemorySpanExporter()
        with mock.patch.dict(os.environ, CLEAN_ENV):
            provider = init_tracing(
                sampler=ALWAYS_ON,
                exporter=exporter,
                resource=Resource.create(RESOURCE),
                redact=False,
                set_global=False,
                keep_identifying_attributes=["http.user_agent"],
                drop_attributes=["host.name"],
            )
        self.assertNotIn("host.id", provider.resource.attributes)
        self.assertNotIn("host.name", provider.resource.attributes)
        self.assertEqual(provider.resource.attributes["service.instance.id"], "inst-1")
        with provider.get_tracer("test").start_as_current_span("GET /x", attributes=SPAN):
            pass
        provider.force_flush()
        [span] = exporter.get_finished_spans()
        self.assertEqual(span.attributes["http.user_agent"], "Mozilla/5.0")
        self.assertNotIn("net.peer.ip", span.attributes)
        self.assertNotIn("process.command_line", span.resource.attributes)
        self.assertEqual(span.attributes["user.email"], "jane@example.com")
        provider.shutdown()


if __name__ == "__main__":
    unittest.main()
