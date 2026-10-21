"""Autter Runtime on plain OpenTelemetry: docs/INTEGRATIONS.md#python.

Everything is configured by the standard variables:

    OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.autter.dev
    OTEL_EXPORTER_OTLP_HEADERS=x-autter-key=${AUTTER_RUNTIME_KEY}
    OTEL_SERVICE_NAME=shop
    OTEL_RESOURCE_ATTRIBUTES=service.version=${GIT_SHA},deployment.environment=production
    OTEL_TRACES_SAMPLER=parentbased_traceidratio
    OTEL_TRACES_SAMPLER_ARG=0.1
"""

from autter_tracing import init_tracing  # copied from adapters/python, with redact.py
from opentelemetry.instrumentation.django import DjangoInstrumentor


def init_observability() -> None:
    """Errors always exported, other traces at the sampler's ratio. Call once
    per process, before Django loads its middleware."""
    init_tracing()
    instrumentor = DjangoInstrumentor()
    if not instrumentor.is_instrumented_by_opentelemetry:  # opentelemetry-instrument did it
        instrumentor.instrument()
