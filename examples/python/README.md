# Python recipes

Plain OpenTelemetry for Python services, with errors kept from every trace
(head sampling drops healthy traffic only). The setup guide is
[docs/INTEGRATIONS.md § Python](../../docs/INTEGRATIONS.md#python-django-fastapi-flask-celery).

| Recipe | Runs as | Shows |
| --- | --- | --- |
| [`django`](django) | `manage.py runserver` (WSGI module `shop/wsgi.py`) | `init_tracing()` + `DjangoInstrumentor` in `wsgi.py`; Django's 500, a handled exception, a chained cause with credentials redacted, a span of your own recording the same error, 404s kept out (`shop/middleware.py`); the zero-code `opentelemetry-instrument` variant |
| [`fastapi`](fastapi) | `uvicorn app:app` | `FastAPIInstrumentor`; Starlette's 500, a handled exception in a sync route, an `ExceptionGroup` from `asyncio.TaskGroup` (3.11+), `HTTPException` not recorded |
| [`flask`](flask) | `gunicorn -w 2 app:app`, with and without `--preload` | `FlaskInstrumentor`; Flask's 500, a handled exception, `abort(404)` not recorded |
| [`celery`](celery) | `celery -A tasks worker` (prefork, `worker_process_init`), and a solo worker thread on the memory broker | `CeleryInstrumentor`; failing tasks grouped per task, a handled exception in a task |

Each app imports `autter_tracing` (and through it `redact`) from
[`adapters/python`](../../adapters/python); in your project, copy the two
files next to your code. Run a recipe or its test:

```bash
cd examples/python/django
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
PYTHONPATH=../../../adapters/python \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_EXPORTER_OTLP_HEADERS=x-autter-key=$AUTTER_RUNTIME_KEY \
OTEL_SERVICE_NAME=shop OTEL_TRACES_SAMPLER=parentbased_traceidratio OTEL_TRACES_SAMPLER_ARG=0.1 \
  .venv/bin/python manage.py runserver --noreload

.venv/bin/python -m unittest -v test_django_recipe.py
```

The tests need no services: each starts its app as above, at sampling ratio
0 so that only the always-on error path exports, points the exporter at a
stub OTLP/HTTP receiver ([`testing/otlp_stub.py`](testing/otlp_stub.py)) and
checks the spans it received: the `exception` event's type, message and full
traceback (the source lines marked `# frame:`), the route, the status, the
resource and the key header. With `AUTTER_CAPTURE_FIXTURES=<dir>` they also
save what was exported, local paths replaced, as the fixtures of the
ingester's Python tests
([`packages/otlp-ingester/test-fixtures/python`](../../packages/otlp-ingester/test-fixtures/python)).
