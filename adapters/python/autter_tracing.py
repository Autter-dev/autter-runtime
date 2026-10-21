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

from opentelemetry import trace
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
from opentelemetry.trace import SpanContext, StatusCode, TraceFlags
from opentelemetry.trace.status import Status

try:  # imported as part of a package
    from .redact import redact_attributes, redact_text
except ImportError:  # copied next to the app as a plain module
    from redact import redact_attributes, redact_text

__all__ = [
    "TAIL_RETAINED_ATTRIBUTE",
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
    if exporter is None:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        exporter = OTLPSpanExporter()
    if redact:
        exporter = RedactingSpanExporter(exporter)
    provider = TracerProvider(
        sampler=RecordUnsampled(sampler if sampler is not None else head_sampler_from_env()),
        resource=resource if resource is not None else Resource.create(),
    )
    provider.add_span_processor(RetainErrorTraces(BatchSpanProcessor(exporter)))
    if set_global:
        trace.set_tracer_provider(provider)
    return provider
