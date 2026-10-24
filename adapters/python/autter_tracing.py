"""Always-on error spans for Python services on plain OpenTelemetry.

Head sampling keeps a fraction of traces: ``ParentBased(TraceIdRatioBased(0.1))``
drops 90% of them, and every exception recorded on a dropped trace goes with
it. The Python SDK cannot export a span it did not sample (``BatchSpanProcessor``
skips spans without the sampled flag), so keeping errors takes two pieces:

* :class:`RecordUnsampled` wraps the head sampler. A trace it would drop is
  recorded instead (``RECORD_ONLY``): its spans run through the span
  processors but keep the "not sampled" flag, so nothing exports them by
  default and downstream services see the same sampling decision.
* :class:`RetainErrorTraces` wraps the exporting span processor. Sampled spans
  pass straight through. Unsampled spans are held per trace until the trace
  shows an error (a span with an ``exception`` event or ERROR status); then
  the whole local trace is exported: the spans that already ended (the child
  that raised, the database calls before it) and every span of the trace that
  ends later (the request span, which ends last). A trace whose local root
  ends without an error is discarded. Memory is bounded (256 spans per trace,
  5,000 spans and traces in all, 30 s per trace); past that it degrades to
  plain head sampling for the evicted traces.

Spans exported by retention carry ``autter.tail_retained = true``, as
``@autter/runtime-node``'s error-linked trace retention marks its spans. The
ingester keeps them out of the span-fed request counts (they are not a sample
of the traffic) and counts each error on them once, as one event.

:func:`init_tracing` wires both, with :class:`RedactingSpanExporter` (secret
and PII scrubbing through ``redact.py``) and the OTLP/HTTP exporter, from the
standard ``OTEL_*`` environment variables::

    from autter_tracing import init_tracing

    init_tracing()  # before the framework instrumentor runs

Request counts (opt-in: ``init_tracing(count_requests=True)`` or
``AUTTER_COUNT_REQUESTS=true``). Without it the ingester counts the requests
of the traces head sampling kept, so at a 10% ratio request counts read 10%
of the traffic while every error is kept, and error rates read 10 times too
high. :class:`CountRequests` sees every HTTP server span (sampled or not:
:class:`RecordUnsampled` records them all) and records each request once, in
a delta ``http.server.duration`` histogram (ms; ``http.route``,
``http.request.method``, ``http.response.status_code`` from the span) that
the ingester counts every request from. It marks the HTTP server spans it
counted ``autter.metric_has_route = true`` and the resource
``autter.metrics_wired`` / ``autter.metrics_routes``, so the ingester (1.8.0+)
adds no request from those spans: each request is counted once, whether it
was sampled, retained for an error, or not exported. The framework
instrumentations' own ``http.server.duration`` / ``http.server.request.duration``
are dropped from that meter provider (they would count every request a
second time). Needs ``opentelemetry-exporter-otlp-proto-http`` for metrics.

Copy this file and ``redact.py`` into your project. Needs ``opentelemetry-sdk``
(tested with 1.20, 1.27 and 1.41 on Python 3.9, 1.45 on Python 3.14) and, for
:func:`init_tracing`'s default exporter, ``opentelemetry-exporter-otlp-proto-http``.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import weakref
from collections import OrderedDict
from typing import Any, Optional, Sequence

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import Histogram, MeterProvider
from opentelemetry.sdk.metrics.export import AggregationTemporality, MetricExporter, PeriodicExportingMetricReader
from opentelemetry.sdk.metrics.view import DropAggregation, View
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.sampling import (
    ALWAYS_OFF,
    ALWAYS_ON,
    Decision,
    ParentBased,
    Sampler,
    SamplingResult,
    TraceIdRatioBased,
)
from opentelemetry.trace import SpanContext, SpanKind, StatusCode, TraceFlags
from opentelemetry.trace.status import Status

try:  # imported as part of a package
    from .redact import redact_attributes, redact_text
except ImportError:  # copied next to the app as a plain module
    from redact import redact_attributes, redact_text

__all__ = [
    "TAIL_RETAINED_ATTRIBUTE",
    "METRIC_COUNTED_ATTRIBUTE",
    "REQUEST_COUNT_RESOURCE_ATTRIBUTES",
    "CountRequests",
    "request_meter_provider",
    "RecordUnsampled",
    "RetainErrorTraces",
    "RedactingSpanExporter",
    "head_sampler_from_env",
    "init_tracing",
]

LOGGER = logging.getLogger("autter.runtime")

#: Marks spans exported by error retention rather than head sampling. Same
#: key and meaning as @autter/runtime-node's tail retention.
TAIL_RETAINED_ATTRIBUTE = "autter.tail_retained"

#: On an HTTP server span whose request :class:`CountRequests` counted in the
#: delta histogram: the ingester counts that request from the metric only.
#: Same key as @autter/runtime-node's (whose metric carries the route).
METRIC_COUNTED_ATTRIBUTE = "autter.metric_has_route"

#: Resource attributes of a service whose delta HTTP duration histogram counts
#: its requests; the ingester honours :data:`METRIC_COUNTED_ATTRIBUTE` only
#: with both. Never set them without that histogram: marked requests would
#: then be counted by nothing.
REQUEST_COUNT_RESOURCE_ATTRIBUTES = {"autter.metrics_wired": True, "autter.metrics_routes": True}

#: The histogram :class:`CountRequests` records into, exported (renamed by a
#: view) as ``http.server.duration``, the instrument the ingester counts.
_REQUEST_INSTRUMENT = "autter.http.server.duration"
_HTTP_SERVER_DURATIONS = ("http.server.duration", "http.server.request.duration")

MAX_SPANS_PER_TRACE = 256
MAX_BUFFERED_SPANS = 5_000
TRACE_TTL_SECONDS = 30.0
SWEEP_INTERVAL_SECONDS = 10.0


class RecordUnsampled(Sampler):
    """Records what ``delegate`` would drop: DROP becomes RECORD_ONLY.

    RECORD_ONLY spans carry no sampled flag, so they reach span processors but
    no exporter, and propagate "not sampled" downstream. Unlike the SDK's own
    ``AlwaysRecordSampler`` (1.45+), the span keeps the attributes it was
    started with: a dropping sampler hands back none.
    """

    def __init__(self, delegate: Sampler):
        if delegate is None:
            raise ValueError("delegate sampler is required")
        self._delegate = delegate

    def should_sample(
        self,
        parent_context,
        trace_id,
        name,
        kind=None,
        attributes=None,
        links=None,
        trace_state=None,
    ) -> SamplingResult:
        # The SDK calls samplers with six arguments; pass trace_state on only
        # when given, so delegates written against that call keep working.
        if trace_state is None:
            result = self._delegate.should_sample(parent_context, trace_id, name, kind, attributes, links)
        else:
            result = self._delegate.should_sample(
                parent_context, trace_id, name, kind, attributes, links, trace_state
            )
        if result.decision is Decision.DROP:
            return SamplingResult(Decision.RECORD_ONLY, attributes, result.trace_state)
        return result

    def get_description(self) -> str:
        return f"RecordUnsampled{{{self._delegate.get_description()}}}"


def _is_error(span: ReadableSpan) -> bool:
    if span.status is not None and span.status.status_code is StatusCode.ERROR:
        return True
    return any(event.name == "exception" for event in span.events or ())


def _is_local_root(span: ReadableSpan) -> bool:
    # The first span of this process in the trace: no parent, or a parent
    # that arrived from another service.
    return span.parent is None or span.parent.is_remote


class _CopiedSpan(ReadableSpan):
    """A finished span with some fields replaced (spans are immutable once
    ended); keeps the original's dropped-item counts for the exporter."""

    def __init__(self, span: ReadableSpan, **overrides: Any):
        super().__init__(
            name=overrides.get("name", span.name),
            context=overrides.get("context", span.context),
            parent=span.parent,
            resource=span.resource,
            attributes=overrides.get("attributes", span.attributes),
            events=overrides.get("events", span.events),
            links=span.links,
            kind=span.kind,
            # The deprecated property warns; the OTLP exporter reads the scope.
            instrumentation_info=getattr(span, "_instrumentation_info", None),
            status=overrides.get("status", span.status),
            start_time=span.start_time,
            end_time=span.end_time,
            instrumentation_scope=span.instrumentation_scope,
        )
        self._dropped_counts = (
            getattr(span, "dropped_attributes", 0),
            getattr(span, "dropped_events", 0),
            getattr(span, "dropped_links", 0),
        )

    @property
    def dropped_attributes(self) -> int:
        return self._dropped_counts[0]

    @property
    def dropped_events(self) -> int:
        return self._dropped_counts[1]

    @property
    def dropped_links(self) -> int:
        return self._dropped_counts[2]


def _retained(span: ReadableSpan) -> ReadableSpan:
    """The span with the sampled flag (what the export processor checks, and
    the truth: retention sampled it) and the tail-retention marker."""
    ctx = span.context
    sampled = SpanContext(
        ctx.trace_id,
        ctx.span_id,
        is_remote=ctx.is_remote,
        trace_flags=TraceFlags(ctx.trace_flags | TraceFlags.SAMPLED),
        trace_state=ctx.trace_state,
    )
    attributes = dict(span.attributes or {})
    attributes[TAIL_RETAINED_ATTRIBUTE] = True
    return _CopiedSpan(span, context=sampled, attributes=attributes)


class _TraceBuffer:
    __slots__ = ("spans", "retained", "first_seen")

    def __init__(self, now: float):
        self.spans: list = []
        self.retained = False
        self.first_seen = now


class RetainErrorTraces(SpanProcessor):
    """Exports unsampled traces that error, through ``processor``.

    Use with :class:`RecordUnsampled`, wrapping the processor that exports
    (``BatchSpanProcessor``): sampled spans go to it unchanged; an unsampled
    trace goes to it, whole, the moment one of its spans ends with an
    ``exception`` event or ERROR status, each span marked
    ``autter.tail_retained``. Errors recorded after the trace's local root
    ended start a new buffer for the stragglers, so those still export.
    """

    def __init__(
        self,
        processor: SpanProcessor,
        *,
        max_spans_per_trace: int = MAX_SPANS_PER_TRACE,
        max_buffered_spans: int = MAX_BUFFERED_SPANS,
        trace_ttl_seconds: float = TRACE_TTL_SECONDS,
    ):
        if max_spans_per_trace < 1 or max_buffered_spans < 1 or trace_ttl_seconds <= 0:
            raise ValueError("invalid error retention limits")
        self._processor = processor
        self._max_spans_per_trace = max_spans_per_trace
        self._max_buffered = max_buffered_spans
        self._ttl = trace_ttl_seconds
        self._at_fork_reinit()
        if hasattr(os, "register_at_fork"):
            # A forked worker (gunicorn, Celery prefork) gets a fresh lock and
            # buffer; the BatchSpanProcessor restarts its own thread.
            reinit = weakref.WeakMethod(self._at_fork_reinit)

            def after_in_child() -> None:
                method = reinit()
                if method is not None:
                    method()

            os.register_at_fork(after_in_child=after_in_child)

    def _at_fork_reinit(self) -> None:
        self._lock = threading.Lock()
        self._traces: "OrderedDict[int, _TraceBuffer]" = OrderedDict()
        self._buffered = 0
        self._next_sweep = time.monotonic() + SWEEP_INTERVAL_SECONDS

    def on_start(self, span, parent_context=None) -> None:
        self._processor.on_start(span, parent_context=parent_context)

    def _on_ending(self, span) -> None:  # SDK 1.39+ hook
        on_ending = getattr(self._processor, "_on_ending", None)
        if on_ending is not None:
            on_ending(span)

    def on_end(self, span: ReadableSpan) -> None:
        ctx = span.context
        if ctx is None:
            return
        if ctx.trace_flags.sampled:
            # Head-sampled: exported as usual, never marked.
            self._processor.on_end(span)
            return
        forward: list = []
        now = time.monotonic()
        with self._lock:
            if now >= self._next_sweep:
                self._sweep(now)
            entry = self._entry(ctx.trace_id, now)
            if entry.retained:
                forward.append(span)
            elif _is_error(span):
                entry.retained = True
                forward.extend(entry.spans)
                forward.append(span)
                self._buffered -= len(entry.spans)
                entry.spans = []
            elif len(entry.spans) < self._max_spans_per_trace:
                entry.spans.append(span)
                self._buffered += 1
                self._evict_over_budget()
            # The local root ended healthy: the request is over and an error
            # in it would have shown by now. A retained entry stays until the
            # sweep, so late spans of the trace still export.
            if not entry.retained and _is_local_root(span):
                self._drop(ctx.trace_id)
        for item in forward:
            self._processor.on_end(_retained(item))

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._processor.force_flush(timeout_millis)

    def shutdown(self) -> None:
        with self._lock:
            self._traces.clear()
            self._buffered = 0
        self._processor.shutdown()

    def _entry(self, trace_id: int, now: float) -> _TraceBuffer:
        entry = self._traces.get(trace_id)
        if entry is None:
            if len(self._traces) >= self._max_buffered:
                self._drop(next(iter(self._traces)))
            entry = _TraceBuffer(now)
            self._traces[trace_id] = entry
        return entry

    def _drop(self, trace_id: int) -> None:
        entry = self._traces.pop(trace_id, None)
        if entry is not None:
            self._buffered -= len(entry.spans)

    def _evict_over_budget(self) -> None:
        if self._buffered <= self._max_buffered:
            return
        # Oldest traces first, whole traces at a time so what stays is
        # coherent. Entries without buffered spans keep their rescue state.
        for trace_id in [tid for tid, entry in self._traces.items() if entry.spans]:
            self._drop(trace_id)
            if self._buffered <= self._max_buffered:
                return

    def _sweep(self, now: float) -> None:
        self._next_sweep = now + SWEEP_INTERVAL_SECONDS
        cutoff = now - self._ttl
        for trace_id in [tid for tid, entry in self._traces.items() if entry.first_seen <= cutoff]:
            self._drop(trace_id)


def _http_method(span: ReadableSpan) -> Optional[str]:
    attributes = span.attributes or {}
    method = attributes.get("http.request.method") or attributes.get("http.method")
    return str(method) if method else None


def _counted_request(span: ReadableSpan) -> bool:
    """An HTTP server span: what the HTTP instrumentations open per request."""
    return span.kind is SpanKind.SERVER and _http_method(span) is not None


def _request_point(span: ReadableSpan) -> dict:
    attributes = span.attributes or {}
    point = {"http.request.method": _http_method(span)}
    route = attributes.get("http.route")
    if isinstance(route, str) and route:
        point["http.route"] = route
    status = attributes.get("http.response.status_code", attributes.get("http.status_code"))
    try:
        if status is not None:
            point["http.response.status_code"] = int(status)
    except (TypeError, ValueError):
        pass
    return point


class CountRequests(SpanProcessor):
    """Counts every HTTP request once, sampled or not, in a delta histogram.

    Wraps the exporting processor (``RetainErrorTraces(...)``) under a
    provider whose sampler is :class:`RecordUnsampled`, so it sees every span.
    For each HTTP server span (kind SERVER with ``http.request.method`` or
    ``http.method``) that is its process's local root it records one point in
    ``meter_provider``'s request histogram (see :func:`request_meter_provider`),
    and it passes every HTTP server span on marked
    :data:`METRIC_COUNTED_ATTRIBUTE`, nested ones included. The ingester then
    counts each such request from the metric and none from its spans: one
    count per request, with a 5xx counted failed by the metric, and an error
    recorded in a request that answered below 500 counted once from its span.
    The resource must carry :data:`REQUEST_COUNT_RESOURCE_ATTRIBUTES`.
    ``force_flush`` and ``shutdown`` reach the meter provider too.
    """

    def __init__(self, processor: SpanProcessor, meter_provider: MeterProvider):
        self._processor = processor
        self._meter_provider = meter_provider
        self._histogram = meter_provider.get_meter("autter.runtime").create_histogram(
            _REQUEST_INSTRUMENT,
            unit="ms",
            description="Duration of HTTP server requests, one point per request",
        )

    def on_start(self, span, parent_context=None) -> None:
        self._processor.on_start(span, parent_context=parent_context)

    def _on_ending(self, span) -> None:  # SDK 1.39+ hook
        on_ending = getattr(self._processor, "_on_ending", None)
        if on_ending is not None:
            on_ending(span)

    def on_end(self, span: ReadableSpan) -> None:
        if _counted_request(span) and span.start_time is not None and span.end_time is not None:
            if _is_local_root(span):
                try:
                    self._histogram.record(max(span.end_time - span.start_time, 0) / 1e6, _request_point(span))
                except Exception:  # never fail the request over a metric
                    LOGGER.debug("[autter-runtime] request count not recorded", exc_info=True)
            attributes = dict(span.attributes or {})
            attributes[METRIC_COUNTED_ATTRIBUTE] = True
            span = _CopiedSpan(span, attributes=attributes)
        self._processor.on_end(span)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        spans = self._processor.force_flush(timeout_millis)
        return self._meter_provider.force_flush(timeout_millis) and spans

    def shutdown(self) -> None:
        self._processor.shutdown()
        self._meter_provider.shutdown()


def _prefers_delta_histograms(exporter: MetricExporter) -> bool:
    preferred = getattr(exporter, "_preferred_temporality", None) or {}
    return preferred.get(Histogram) is AggregationTemporality.DELTA


def request_meter_provider(
    resource: Resource, exporter: Optional[MetricExporter] = None
) -> Optional[MeterProvider]:
    """The meter provider :class:`CountRequests` records into: histograms
    exported with delta temporality (the ingester sums deltas; it ignores
    cumulative points), :class:`CountRequests`' histogram exported as
    ``http.server.duration``, and the framework instrumentations'
    ``http.server.duration`` / ``http.server.request.duration`` dropped. Other
    instruments export as usual.

    ``exporter`` defaults to ``OTLPMetricExporter`` (``OTEL_EXPORTER_OTLP_*``)
    preferring delta histograms. One that does not prefer delta for
    histograms gets ``None`` (with a warning): counting then stays off.
    The export interval is ``OTEL_METRIC_EXPORT_INTERVAL`` (default 60 s; the
    ingester's latency histograms need two minutes or less).
    """
    if exporter is None:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

        exporter = OTLPMetricExporter(preferred_temporality={Histogram: AggregationTemporality.DELTA})
    if not _prefers_delta_histograms(exporter):
        LOGGER.warning(
            "[autter-runtime] request counts are off: the metric exporter does not export histograms "
            "with delta temporality, and the ingester does not count cumulative ones."
        )
        return None
    return MeterProvider(
        resource=resource,
        metric_readers=[PeriodicExportingMetricReader(exporter)],
        views=[
            View(instrument_name=_REQUEST_INSTRUMENT, name="http.server.duration"),
            *(View(instrument_name=name, aggregation=DropAggregation()) for name in _HTTP_SERVER_DURATIONS),
        ],
        # CountRequests.shutdown (run by the TracerProvider's) shuts it down.
        shutdown_on_exit=False,
    )


def _env_flag(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes", "on")


def _redacted(span: ReadableSpan) -> ReadableSpan:
    events = [Event(event.name, redact_attributes(event.attributes), event.timestamp) for event in span.events]
    status = span.status
    if status is not None and status.description:
        status = Status(status.status_code, redact_text(status.description))
    return _CopiedSpan(
        span,
        name=redact_text(span.name),
        attributes=redact_attributes(span.attributes),
        events=events,
        status=status,
    )


class RedactingSpanExporter(SpanExporter):
    """Scrubs secrets and PII before spans leave the process.

    Span names, attributes (sensitive keys masked at any depth), event
    attributes (``exception.message`` and ``exception.stacktrace`` included:
    ``str(exc)`` often carries a connection string or an API key) and status
    descriptions go through ``redact.py``, the patterns @autter/runtime-node
    uses. The ingester scrubs again on arrival.
    """

    def __init__(self, exporter: SpanExporter):
        self._exporter = exporter

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._exporter.export([_redacted(span) for span in spans])

    def shutdown(self) -> None:
        self._exporter.shutdown()

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        flush = getattr(self._exporter, "force_flush", None)
        return flush(timeout_millis) if flush is not None else True


_ENV_SAMPLERS = {
    "always_on": lambda ratio: ALWAYS_ON,
    "always_off": lambda ratio: ALWAYS_OFF,
    "traceidratio": lambda ratio: TraceIdRatioBased(ratio),
    "parentbased_always_on": lambda ratio: ParentBased(ALWAYS_ON),
    "parentbased_always_off": lambda ratio: ParentBased(ALWAYS_OFF),
    "parentbased_traceidratio": lambda ratio: ParentBased(TraceIdRatioBased(ratio)),
}


def head_sampler_from_env() -> Sampler:
    """The head sampler ``OTEL_TRACES_SAMPLER`` / ``OTEL_TRACES_SAMPLER_ARG``
    name (the six standard samplers; default ``parentbased_always_on``)."""
    name = (os.environ.get("OTEL_TRACES_SAMPLER") or "parentbased_always_on").strip().lower()
    if name not in _ENV_SAMPLERS:
        LOGGER.warning("[autter-runtime] unknown OTEL_TRACES_SAMPLER %r, using parentbased_always_on", name)
        name = "parentbased_always_on"
    raw = (os.environ.get("OTEL_TRACES_SAMPLER_ARG") or "").strip()
    try:
        ratio = float(raw) if raw else 1.0
    except ValueError:
        LOGGER.warning("[autter-runtime] invalid OTEL_TRACES_SAMPLER_ARG %r, using 1.0", raw)
        ratio = 1.0
    return _ENV_SAMPLERS[name](min(max(ratio, 0.0), 1.0))


def init_tracing(
    *,
    sampler: Optional[Sampler] = None,
    exporter: Optional[SpanExporter] = None,
    resource: Optional[Resource] = None,
    redact: bool = True,
    set_global: bool = True,
    count_requests: Optional[bool] = None,
    metric_exporter: Optional[MetricExporter] = None,
) -> TracerProvider:
    """A TracerProvider that head-samples as configured and always exports
    errors, registered as the global provider.

    * ``sampler``: the head sampler (default: :func:`head_sampler_from_env`),
      wrapped in :class:`RecordUnsampled`.
    * ``exporter``: default ``OTLPSpanExporter()``, which reads
      ``OTEL_EXPORTER_OTLP_ENDPOINT`` (or ``…_TRACES_ENDPOINT``) and
      ``OTEL_EXPORTER_OTLP_HEADERS``.
    * ``resource``: default ``Resource.create()``, which reads
      ``OTEL_SERVICE_NAME`` and ``OTEL_RESOURCE_ATTRIBUTES``.
    * ``redact``: wrap the exporter in :class:`RedactingSpanExporter`.
    * ``count_requests`` (default: ``AUTTER_COUNT_REQUESTS=true``): count
      every HTTP request, sampled or not (:class:`CountRequests`), in a delta
      histogram sent through ``metric_exporter`` (default
      ``OTLPMetricExporter`` preferring delta histograms, which reads the same
      ``OTEL_EXPORTER_OTLP_*`` variables; see :func:`request_meter_provider`).
      With ``set_global`` its meter provider is registered as the global one,
      so add your own instruments (a memory gauge) to it rather than
      registering another. It stays off, with a warning, when a meter
      provider is already registered: its own HTTP duration histograms,
      if delta, would count every request a second time.

    Call it once per process before the framework instrumentor runs (after
    fork in prefork servers: gunicorn without ``--preload`` imports the WSGI
    module in each worker; Celery's ``worker_process_init``).

    With ``set_global``, a process that already registered an SDK provider
    (a second call, or the app started under ``opentelemetry-instrument``)
    keeps it: it is returned unchanged, with a warning when it was not ours.
    """
    if set_global:
        existing = trace.get_tracer_provider()
        if isinstance(existing, TracerProvider):
            description = existing.sampler.get_description()
            samples_all = description == "AlwaysOnSampler" or description.startswith("ParentBased{root:AlwaysOnSampler")
            if not isinstance(existing.sampler, RecordUnsampled) and not samples_all:
                LOGGER.warning(
                    "[autter-runtime] init_tracing(): an OpenTelemetry TracerProvider is already registered "
                    "(opentelemetry-instrument?) and is left as it is. Its sampler (%s) drops the errors of "
                    "unsampled traces: run it with OTEL_TRACES_SAMPLER=parentbased_always_on, or start the "
                    "app without opentelemetry-instrument.",
                    description,
                )
            return existing
    if resource is None:
        resource = Resource.create()
    meter_provider = None
    if count_requests if count_requests is not None else _env_flag("AUTTER_COUNT_REQUESTS"):
        if set_global and isinstance(metrics.get_meter_provider(), MeterProvider):
            LOGGER.warning(
                "[autter-runtime] init_tracing(count_requests=True): a MeterProvider is already registered, so "
                "request counts are off. Register none before init_tracing(): its meter provider replaces it."
            )
        else:
            counted = resource.merge(Resource(REQUEST_COUNT_RESOURCE_ATTRIBUTES))
            meter_provider = request_meter_provider(counted, metric_exporter)
            if meter_provider is not None:
                # Only with the histogram: these tell the ingester that marked
                # requests are counted by the metric, not by their spans.
                resource = counted
    if exporter is None:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        exporter = OTLPSpanExporter()
    if redact:
        exporter = RedactingSpanExporter(exporter)
    provider = TracerProvider(
        sampler=RecordUnsampled(sampler if sampler is not None else head_sampler_from_env()),
        resource=resource,
    )
    processor: SpanProcessor = RetainErrorTraces(BatchSpanProcessor(exporter))
    if meter_provider is not None:
        processor = CountRequests(processor, meter_provider)
    provider.add_span_processor(processor)
    if set_global:
        if meter_provider is not None:
            metrics.set_meter_provider(meter_provider)
        trace.set_tracer_provider(provider)
    return provider
