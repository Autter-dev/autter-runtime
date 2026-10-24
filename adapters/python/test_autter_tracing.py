"""Tests for always-on error spans (autter_tracing.py) with the OTel SDK's
in-memory exporter. Skipped when opentelemetry-sdk is not installed.

Run: python3 -m venv .venv && .venv/bin/pip install -r adapters/python/requirements-test.txt
     .venv/bin/python -m unittest discover -s adapters/python -v
"""

from __future__ import annotations

import os
import sys
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from opentelemetry import context as otel_context
    from opentelemetry import trace
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from opentelemetry.sdk.trace.sampling import (
        ALWAYS_OFF,
        ALWAYS_ON,
        Decision,
        ParentBased,
        TraceIdRatioBased,
    )
    from opentelemetry.trace import NonRecordingSpan, SpanContext, SpanKind, Status, StatusCode, TraceFlags
    from opentelemetry import metrics
    from opentelemetry.sdk.metrics import Histogram, MeterProvider
    from opentelemetry.sdk.metrics.export import AggregationTemporality, MetricExporter, MetricExportResult
except ImportError as error:  # pragma: no cover - depends on the environment
    raise unittest.SkipTest(f"opentelemetry-sdk is not installed ({error})")

import autter_tracing  # noqa: E402
from autter_tracing import (  # noqa: E402
    METRIC_COUNTED_ATTRIBUTE,
    TAIL_RETAINED_ATTRIBUTE,
    CountRequests,
    RecordUnsampled,
    RedactingSpanExporter,
    RetainErrorTraces,
    head_sampler_from_env,
    init_tracing,
    request_meter_provider,
)
from redact import MASK  # noqa: E402


def pipeline(head=ALWAYS_OFF, **limits):
    """A provider wired like init_tracing, exporting synchronously."""
    exporter = InMemorySpanExporter()
    retain = RetainErrorTraces(SimpleSpanProcessor(exporter), **limits)
    provider = TracerProvider(sampler=RecordUnsampled(ParentBased(head)))
    provider.add_span_processor(retain)
    return provider.get_tracer("test"), exporter, retain


def names(exporter):
    return [span.name for span in exporter.get_finished_spans()]


def remote_parent(sampled: bool):
    ctx = SpanContext(
        trace_id=0x0AF7651916CD43DD8448EB211C80319C,
        span_id=0xB7AD6B7169203331,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED if sampled else TraceFlags.DEFAULT),
    )
    return trace.set_span_in_context(NonRecordingSpan(ctx))


class Sampler(unittest.TestCase):
    def test_drop_becomes_record_only_with_the_start_attributes(self):
        sampler = RecordUnsampled(ParentBased(TraceIdRatioBased(0.0)))
        result = sampler.should_sample(None, 0x1234, "GET /orders", SpanKind.SERVER, {"http.method": "GET"})
        self.assertIs(result.decision, Decision.RECORD_ONLY)
        self.assertEqual(dict(result.attributes), {"http.method": "GET"})

    def test_sampled_decisions_pass_through(self):
        result = RecordUnsampled(ALWAYS_ON).should_sample(None, 0x1234, "span", attributes={"a": 1})
        self.assertIs(result.decision, Decision.RECORD_AND_SAMPLE)
        self.assertEqual(dict(result.attributes), {"a": 1})

    def test_unsampled_remote_parent_is_recorded_and_stays_unsampled(self):
        tracer, _, _ = pipeline(head=ALWAYS_ON)
        span = tracer.start_span("handler", context=remote_parent(sampled=False))
        self.assertTrue(span.is_recording())
        self.assertFalse(span.get_span_context().trace_flags.sampled)
        span.end()

    def test_delegates_written_for_six_arguments(self):
        class SixArguments(ALWAYS_OFF.__class__):
            def should_sample(self, parent_context, trace_id, name, kind=None, attributes=None, links=None):
                return super().should_sample(parent_context, trace_id, name, kind, attributes, links)

        result = RecordUnsampled(SixArguments(Decision.DROP)).should_sample(None, 1, "x")
        self.assertIs(result.decision, Decision.RECORD_ONLY)

    def test_description(self):
        self.assertEqual(RecordUnsampled(ALWAYS_OFF).get_description(), "RecordUnsampled{AlwaysOffSampler}")


class Retention(unittest.TestCase):
    def test_healthy_unsampled_trace_is_not_exported(self):
        tracer, exporter, retain = pipeline()
        with tracer.start_as_current_span("GET /ok", kind=SpanKind.SERVER):
            with tracer.start_as_current_span("db.query"):
                pass
        self.assertEqual(names(exporter), [])
        self.assertEqual(len(retain._traces), 0)
        self.assertEqual(retain._buffered, 0)

    def test_error_exports_the_whole_local_trace_marked(self):
        tracer, exporter, _ = pipeline()
        with self.assertRaises(ValueError):
            with tracer.start_as_current_span("GET /orders/:id", kind=SpanKind.SERVER):
                with tracer.start_as_current_span("db.query"):
                    pass
                with tracer.start_as_current_span("charge"):
                    raise ValueError("card declined")
        spans = exporter.get_finished_spans()
        # Ended before the error (buffered), the error, then the request span.
        self.assertEqual([s.name for s in spans], ["db.query", "charge", "GET /orders/:id"])
        self.assertEqual(len({s.context.trace_id for s in spans}), 1)
        for span in spans:
            self.assertIs(span.attributes[TAIL_RETAINED_ATTRIBUTE], True)
            self.assertTrue(span.context.trace_flags.sampled)
        charge = spans[1]
        event = charge.events[0]
        self.assertEqual(event.name, "exception")
        self.assertEqual(event.attributes["exception.type"], "ValueError")
        self.assertEqual(event.attributes["exception.message"], "card declined")
        self.assertIn('raise ValueError("card declined")', event.attributes["exception.stacktrace"])
        self.assertIs(charge.status.status_code, StatusCode.ERROR)
        # Parent links survive the copy, so the ingester sees the chain.
        self.assertEqual(charge.parent.span_id, spans[2].context.span_id)
        self.assertEqual(spans[0].parent.span_id, spans[2].context.span_id)

    def test_handled_exception_event_retains_the_trace(self):
        tracer, exporter, _ = pipeline()
        with tracer.start_as_current_span("GET /retry", kind=SpanKind.SERVER) as span:
            try:
                raise TimeoutError("upstream timed out")
            except TimeoutError as exc:
                span.record_exception(exc, attributes={"autter.handled": True})
        spans = exporter.get_finished_spans()
        self.assertEqual([s.name for s in spans], ["GET /retry"])
        self.assertIs(spans[0].status.status_code, StatusCode.UNSET)
        self.assertIs(spans[0].events[0].attributes["autter.handled"], True)

    def test_error_status_without_an_event_retains_the_trace(self):
        tracer, exporter, _ = pipeline()
        with tracer.start_as_current_span("GET /fail", kind=SpanKind.SERVER) as span:
            span.set_attribute("http.status_code", 503)
            span.set_status(Status(StatusCode.ERROR))
        self.assertEqual(names(exporter), ["GET /fail"])

    def test_head_sampled_traces_export_unmarked(self):
        tracer, exporter, _ = pipeline(head=ALWAYS_ON)
        with tracer.start_as_current_span("GET /ok", kind=SpanKind.SERVER):
            with tracer.start_as_current_span("db.query"):
                pass
        spans = exporter.get_finished_spans()
        self.assertEqual([s.name for s in spans], ["db.query", "GET /ok"])
        for span in spans:
            self.assertNotIn(TAIL_RETAINED_ATTRIBUTE, span.attributes)

    def test_remote_unsampled_parent_local_root(self):
        tracer, exporter, retain = pipeline(head=ALWAYS_ON)
        token = otel_context.attach(remote_parent(sampled=False))
        try:
            with tracer.start_as_current_span("healthy", kind=SpanKind.SERVER):
                pass
            self.assertEqual(len(retain._traces), 0, "a local root under a remote parent ends the buffer")
            with self.assertRaises(KeyError):
                with tracer.start_as_current_span("failing", kind=SpanKind.SERVER):
                    raise KeyError("order-42")
        finally:
            otel_context.detach(token)
        spans = exporter.get_finished_spans()
        self.assertEqual([s.name for s in spans], ["failing"])
        self.assertTrue(spans[0].parent.is_remote)

    def test_spans_ending_after_a_retained_root_still_export(self):
        tracer, exporter, _ = pipeline()
        root = tracer.start_span("job", kind=SpanKind.CONSUMER)
        ctx = trace.set_span_in_context(root)
        late = tracer.start_span("cleanup", context=ctx)
        root.record_exception(RuntimeError("job failed"))
        root.end()
        late.end()
        self.assertEqual(names(exporter), ["job", "cleanup"])

    def test_per_trace_cap_keeps_the_first_spans(self):
        tracer, exporter, _ = pipeline(max_spans_per_trace=2)
        with self.assertRaises(RuntimeError):
            with tracer.start_as_current_span("root"):
                for i in range(4):
                    with tracer.start_as_current_span(f"step-{i}"):
                        pass
                raise RuntimeError("boom")
        self.assertEqual(names(exporter), ["step-0", "step-1", "root"])

    def test_total_budget_evicts_the_oldest_trace(self):
        tracer, exporter, retain = pipeline(max_buffered_spans=3)
        first = tracer.start_span("first-root")
        second = tracer.start_span("second-root")
        for root in (first, second):
            ctx = trace.set_span_in_context(root)
            for i in range(2):
                tracer.start_span(f"{root.name}-child-{i}", context=ctx).end()
        self.assertEqual(retain._buffered, 2, "the first trace was evicted to fit the second")
        first.record_exception(RuntimeError("first"))
        first.end()
        second.record_exception(RuntimeError("second"))
        second.end()
        self.assertEqual(
            names(exporter),
            ["first-root", "second-root-child-0", "second-root-child-1", "second-root"],
        )

    def test_trace_buffers_expire(self):
        clock = [1000.0]
        with mock.patch.object(autter_tracing.time, "monotonic", lambda: clock[0]):
            tracer, exporter, retain = pipeline(trace_ttl_seconds=30)
            root = tracer.start_span("stuck-root")
            tracer.start_span("child", context=trace.set_span_in_context(root)).end()
            self.assertEqual(retain._buffered, 1)
            clock[0] += 45
            tracer.start_span("other").end()  # any span end runs the sweep
            self.assertEqual(retain._buffered, 0)
            self.assertNotIn(root.get_span_context().trace_id, retain._traces)
            root.record_exception(RuntimeError("late"))
            root.end()
        # The expired child is gone; the root still exports its own error.
        self.assertEqual(names(exporter), ["stuck-root"])

    def test_concurrent_requests(self):
        tracer, exporter, retain = pipeline()

        def request(i: int) -> None:
            try:
                with tracer.start_as_current_span(f"req-{i}", kind=SpanKind.SERVER):
                    with tracer.start_as_current_span(f"query-{i}"):
                        pass
                    if i % 5 == 0:
                        raise ValueError(f"bad {i}")
            except ValueError:
                pass

        threads = [threading.Thread(target=lambda n=n: [request(n * 50 + j) for j in range(50)]) for n in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        exported = sorted(names(exporter))
        expected = sorted(n for i in range(400) if i % 5 == 0 for n in (f"req-{i}", f"query-{i}"))
        self.assertEqual(exported, expected)
        self.assertEqual(retain._buffered, 0)

    def test_force_flush_and_shutdown_reach_the_exporter(self):
        exporter = InMemorySpanExporter()
        retain = RetainErrorTraces(BatchSpanProcessor(exporter, schedule_delay_millis=60_000))
        provider = TracerProvider(sampler=RecordUnsampled(ALWAYS_OFF))
        provider.add_span_processor(retain)
        tracer = provider.get_tracer("test")
        with tracer.start_as_current_span("job") as span:
            span.set_status(Status(StatusCode.ERROR, "failed"))
        self.assertTrue(retain.force_flush(5_000))
        self.assertEqual(names(exporter), ["job"])
        provider.shutdown()


class Redaction(unittest.TestCase):
    def test_exception_events_attributes_and_status_are_scrubbed(self):
        exporter = InMemorySpanExporter()
        provider = TracerProvider(sampler=RecordUnsampled(ALWAYS_OFF))
        provider.add_span_processor(RetainErrorTraces(SimpleSpanProcessor(RedactingSpanExporter(exporter))))
        tracer = provider.get_tracer("test")
        with self.assertRaises(ConnectionError):
            with tracer.start_as_current_span("connect", attributes={"db.password": "hunter2", "db.system": "postgresql"}):
                raise ConnectionError("could not connect to postgres://admin:hunter2@db.internal:5432/app")
        span = exporter.get_finished_spans()[0]
        event = span.events[0].attributes
        self.assertNotIn("hunter2", event["exception.message"])
        self.assertIn(f"postgres://{MASK}@db.internal:5432/app", event["exception.message"])
        self.assertNotIn("hunter2", event["exception.stacktrace"])
        self.assertIn("Traceback (most recent call last):", event["exception.stacktrace"])
        self.assertEqual(span.attributes["db.password"], MASK)
        self.assertEqual(span.attributes["db.system"], "postgresql")
        self.assertIs(span.attributes[TAIL_RETAINED_ATTRIBUTE], True)
        self.assertNotIn("hunter2", span.status.description)


class CapturingMetricExporter(MetricExporter):
    """Keeps what the periodic reader exports (histograms delta by default)."""

    def __init__(self, temporality=AggregationTemporality.DELTA):
        super().__init__(preferred_temporality={Histogram: temporality})
        self.batches = []

    def export(self, metrics_data, timeout_millis=10_000, **kwargs):
        self.batches.append(metrics_data)
        return MetricExportResult.SUCCESS

    def force_flush(self, timeout_millis=10_000):
        return True

    def shutdown(self, timeout_millis=30_000, **kwargs):
        pass

    def take(self):
        """{metric name: [(attributes, count, temporality)]} exported since the last take."""
        out = {}
        for batch in self.batches:
            for resource_metrics in batch.resource_metrics:
                for scope_metrics in resource_metrics.scope_metrics:
                    for metric in scope_metrics.metrics:
                        for point in metric.data.data_points:
                            out.setdefault(metric.name, []).append(
                                (
                                    dict(point.attributes),
                                    getattr(point, "count", getattr(point, "value", None)),
                                    getattr(metric.data, "aggregation_temporality", None),
                                )
                            )
        self.batches = []
        return out


def counting_pipeline(head=ALWAYS_OFF):
    """init_tracing(count_requests=True)'s processors, exporting synchronously."""
    exporter = InMemorySpanExporter()
    metric_exporter = CapturingMetricExporter()
    meter_provider = request_meter_provider(Resource.create({"service.name": "orders-api"}), metric_exporter)
    provider = TracerProvider(sampler=RecordUnsampled(ParentBased(head)))
    provider.add_span_processor(CountRequests(RetainErrorTraces(SimpleSpanProcessor(exporter)), meter_provider))
    return provider, exporter, metric_exporter, meter_provider


def http(route, status=200, method="GET", semconv="old"):
    if semconv == "old":
        return {"http.method": method, "http.route": route, "http.status_code": status}
    return {"http.request.method": method, "http.route": route, "http.response.status_code": status}


class RequestCounts(unittest.TestCase):
    def test_every_request_is_counted_once_and_its_exported_spans_say_so(self):
        provider, exporter, metric_exporter, meter_provider = counting_pipeline()
        tracer = provider.get_tracer("test")
        # Unsampled and healthy: never exported, still counted.
        for _ in range(3):
            with tracer.start_as_current_span("GET /orders/:id", kind=SpanKind.SERVER, attributes=http("/orders/:id")):
                with tracer.start_as_current_span("db.query"):
                    pass
        # Head-sampled through a remote parent: exported and counted.
        token = otel_context.attach(remote_parent(sampled=True))
        try:
            with tracer.start_as_current_span("POST /pay", kind=SpanKind.SERVER, attributes=http("/pay", 201, "POST", "new")):
                pass
        finally:
            otel_context.detach(token)
        # Failed: retained, exported, counted with its 500.
        with self.assertRaises(ValueError):
            with tracer.start_as_current_span("GET /boom", kind=SpanKind.SERVER, attributes=http("/boom")) as span:
                span.set_attribute("http.status_code", 500)
                # A server span nested in the request (a framework's own) is
                # marked so it never counts as a request of its own, and adds
                # no point.
                with tracer.start_as_current_span("inner", kind=SpanKind.SERVER, attributes=http("/boom")):
                    raise ValueError("boom")
        # Not HTTP (a gRPC server span): neither counted here nor marked.
        with tracer.start_as_current_span("grpc.Check", kind=SpanKind.SERVER, attributes={"rpc.system": "grpc"}):
            pass
        provider.force_flush()

        points = metric_exporter.take()
        self.assertEqual(set(points), {"http.server.duration"})
        counted = sorted((attrs.get("http.route"), attrs.get("http.response.status_code"), attrs["http.request.method"], count)
                         for attrs, count, _ in points["http.server.duration"])
        self.assertEqual(counted, [("/boom", 500, "GET", 1), ("/orders/:id", 200, "GET", 3), ("/pay", 201, "POST", 1)])
        for _, _, temporality in points["http.server.duration"]:
            self.assertIs(temporality, AggregationTemporality.DELTA)

        spans = {s.name: s for s in exporter.get_finished_spans()}
        self.assertEqual(sorted(spans), ["GET /boom", "POST /pay", "inner"])
        self.assertIs(spans["POST /pay"].attributes[METRIC_COUNTED_ATTRIBUTE], True)
        self.assertNotIn(TAIL_RETAINED_ATTRIBUTE, spans["POST /pay"].attributes)
        for name in ("GET /boom", "inner"):
            self.assertIs(spans[name].attributes[METRIC_COUNTED_ATTRIBUTE], True)
            self.assertIs(spans[name].attributes[TAIL_RETAINED_ATTRIBUTE], True)
        self.assertEqual(spans["inner"].events[0].name, "exception")

        # Delta: the next export holds only what came after.
        with tracer.start_as_current_span("GET /orders/:id", kind=SpanKind.SERVER, attributes=http("/orders/:id")):
            pass
        provider.force_flush()
        self.assertEqual([count for _, count, _ in metric_exporter.take()["http.server.duration"]], [1])
        provider.shutdown()

    def test_the_instrumentations_own_duration_histograms_are_dropped(self):
        metric_exporter = CapturingMetricExporter()
        meter_provider = request_meter_provider(Resource.create(), metric_exporter)
        flask = meter_provider.get_meter("opentelemetry.instrumentation.flask")
        flask.create_histogram("http.server.duration", unit="ms").record(12, {"http.method": "GET"})
        flask.create_histogram("http.server.request.duration", unit="s").record(0.012, {"http.request.method": "GET"})
        flask.create_up_down_counter("http.server.active_requests").add(1)
        meter_provider.get_meter("app").create_counter("orders.created").add(2)
        meter_provider.force_flush()
        points = metric_exporter.take()
        self.assertEqual(set(points), {"http.server.active_requests", "orders.created"})
        meter_provider.shutdown()

    def test_a_cumulative_metric_exporter_leaves_counting_off(self):
        with self.assertLogs("autter.runtime", "WARNING") as logs:
            provider = init_tracing(
                exporter=InMemorySpanExporter(),
                count_requests=True,
                metric_exporter=CapturingMetricExporter(AggregationTemporality.CUMULATIVE),
                set_global=False,
            )
        self.assertTrue(any("delta" in line for line in logs.output))
        self.assertNotIn("autter.metrics_wired", provider.resource.attributes)
        provider.shutdown()


class InitTracing(unittest.TestCase):
    ENV = {
        "OTEL_SERVICE_NAME": "orders-api",
        "OTEL_RESOURCE_ATTRIBUTES": "service.version=4f2c9e1,deployment.environment=staging",
        "OTEL_TRACES_SAMPLER": "parentbased_traceidratio",
        "OTEL_TRACES_SAMPLER_ARG": "0",
    }

    def test_env_configured_pipeline_keeps_errors_only(self):
        exporter = InMemorySpanExporter()
        with mock.patch.dict(os.environ, self.ENV):
            provider = init_tracing(exporter=exporter, set_global=False)
        tracer = provider.get_tracer("test")
        with tracer.start_as_current_span("GET /ok", kind=SpanKind.SERVER):
            pass
        with self.assertRaises(ZeroDivisionError):
            with tracer.start_as_current_span("GET /boom", kind=SpanKind.SERVER):
                1 / 0  # noqa: B018
        provider.force_flush()
        spans = exporter.get_finished_spans()
        self.assertEqual([s.name for s in spans], ["GET /boom"])
        resource = spans[0].resource.attributes
        self.assertEqual(resource["service.name"], "orders-api")
        self.assertEqual(resource["service.version"], "4f2c9e1")
        self.assertEqual(resource["deployment.environment"], "staging")
        self.assertIn("RecordUnsampled{ParentBased", provider.sampler.get_description())
        provider.shutdown()

    def test_head_sampler_from_env(self):
        cases = {
            ("always_on", ""): "AlwaysOnSampler",
            ("always_off", ""): "AlwaysOffSampler",
            ("traceidratio", "0.25"): "TraceIdRatioBased{0.25}",
            ("parentbased_traceidratio", "0.01"): "ParentBased{root:TraceIdRatioBased{0.01}",
            ("parentbased_traceidratio", "nonsense"): "ParentBased{root:TraceIdRatioBased{1.0}",
            ("PARENTBASED_ALWAYS_OFF", ""): "ParentBased{root:AlwaysOffSampler",
            ("jaeger_remote", ""): "ParentBased{root:AlwaysOnSampler",
            ("", ""): "ParentBased{root:AlwaysOnSampler",
        }
        for (name, arg), expected in cases.items():
            with self.subTest(name=name, arg=arg), mock.patch.dict(
                os.environ, {"OTEL_TRACES_SAMPLER": name, "OTEL_TRACES_SAMPLER_ARG": arg}
            ):
                self.assertTrue(head_sampler_from_env().get_description().startswith(expected))

    def test_an_existing_sdk_provider_is_kept(self):
        for sampler, warns in (
            (ParentBased(TraceIdRatioBased(0.1)), True),  # opentelemetry-instrument's ratio sampler
            (ParentBased(ALWAYS_ON), False),  # keeps every error anyway
            (RecordUnsampled(ALWAYS_OFF), False),  # a second init_tracing() call
        ):
            existing = TracerProvider(sampler=sampler)
            with self.subTest(sampler=sampler.get_description()), mock.patch.object(
                trace, "get_tracer_provider", return_value=existing
            ), mock.patch.object(trace, "set_tracer_provider") as set_provider, self.assertLogs(
                "autter.runtime", "DEBUG"
            ) as logs:
                autter_tracing.LOGGER.debug("start")
                self.assertIs(init_tracing(exporter=InMemorySpanExporter()), existing)
                set_provider.assert_not_called()
                warned = any("already registered" in line for line in logs.output)
                self.assertEqual(warned, warns)

    def test_count_requests_wires_the_histogram_the_resource_and_the_marks(self):
        exporter = InMemorySpanExporter()
        metric_exporter = CapturingMetricExporter()
        with mock.patch.dict(os.environ, {**self.ENV, "AUTTER_COUNT_REQUESTS": "true"}):
            provider = init_tracing(exporter=exporter, metric_exporter=metric_exporter, set_global=False)
        tracer = provider.get_tracer("test")
        with tracer.start_as_current_span("GET /ok", kind=SpanKind.SERVER, attributes=http("/ok")):
            pass
        with self.assertRaises(ZeroDivisionError):
            with tracer.start_as_current_span("GET /boom", kind=SpanKind.SERVER, attributes=http("/boom")):
                1 / 0  # noqa: B018
        provider.force_flush()
        self.assertEqual(sorted(a["http.route"] for a, _, _ in metric_exporter.take()["http.server.duration"]), ["/boom", "/ok"])
        spans = exporter.get_finished_spans()
        self.assertEqual([s.name for s in spans], ["GET /boom"])
        self.assertIs(spans[0].attributes[METRIC_COUNTED_ATTRIBUTE], True)
        resource = spans[0].resource.attributes
        self.assertIs(resource["autter.metrics_wired"], True)
        self.assertIs(resource["autter.metrics_routes"], True)
        self.assertEqual(resource["service.name"], "orders-api")
        provider.shutdown()

    def test_count_requests_is_off_by_default(self):
        exporter = InMemorySpanExporter()
        with mock.patch.dict(os.environ, {**self.ENV, "OTEL_TRACES_SAMPLER": "always_on"}):
            provider = init_tracing(exporter=exporter, set_global=False)
        with provider.get_tracer("test").start_as_current_span("GET /ok", kind=SpanKind.SERVER, attributes=http("/ok")):
            pass
        provider.force_flush()
        span = exporter.get_finished_spans()[0]
        self.assertNotIn(METRIC_COUNTED_ATTRIBUTE, span.attributes)
        self.assertNotIn("autter.metrics_wired", span.resource.attributes)
        provider.shutdown()

    def test_count_requests_registers_its_meter_provider_unless_one_is_registered(self):
        proxy = trace.get_tracer_provider()
        for existing, counts in ((metrics.NoOpMeterProvider(), True), (MeterProvider(), False)):
            with self.subTest(existing=type(existing).__name__), mock.patch.object(
                trace, "get_tracer_provider", return_value=proxy
            ), mock.patch.object(trace, "set_tracer_provider"), mock.patch.object(
                metrics, "get_meter_provider", return_value=existing
            ), mock.patch.object(metrics, "set_meter_provider") as set_meter_provider, self.assertLogs(
                "autter.runtime", "DEBUG"
            ) as logs:
                autter_tracing.LOGGER.debug("start")
                provider = init_tracing(
                    exporter=InMemorySpanExporter(), metric_exporter=CapturingMetricExporter(), count_requests=True
                )
                self.assertEqual(set_meter_provider.called, counts)
                if counts:
                    self.assertIsInstance(set_meter_provider.call_args[0][0], MeterProvider)
                self.assertEqual("autter.metrics_wired" in provider.resource.attributes, counts)
                self.assertEqual(any("already registered" in line for line in logs.output), not counts)
                provider.shutdown()

    def test_explicit_sampler_and_resource_win(self):
        exporter = InMemorySpanExporter()
        with mock.patch.dict(os.environ, self.ENV):
            provider = init_tracing(
                sampler=ALWAYS_ON,
                exporter=exporter,
                resource=Resource.create({"service.name": "explicit"}),
                redact=False,
                set_global=False,
            )
        with provider.get_tracer("test").start_as_current_span("GET /ok"):
            pass
        provider.force_flush()
        spans = exporter.get_finished_spans()
        self.assertEqual([s.name for s in spans], ["GET /ok"])
        self.assertEqual(spans[0].resource.attributes["service.name"], "explicit")
        provider.shutdown()


if __name__ == "__main__":
    unittest.main()
