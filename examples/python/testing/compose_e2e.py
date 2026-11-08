"""A Python recipe, run as its README says, against the repo's own
``docker compose up`` (the ingester with its built-in local key, ClickHouse
24.8), and the error it sent read back from ClickHouse.

    docker compose up -d --build --wait          # from the repo root
    cd examples/python/flask && pip install -r requirements.txt
    python ../testing/compose_e2e.py flask        # or fastapi, django, celery

The unit tests next to each recipe check what is exported, against a stub;
this checks that it is stored. Exits non-zero on failure.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from otlp_stub import ADAPTER, App, Process, free_port  # noqa: E402

EXAMPLES = os.path.dirname(HERE)
INGESTER = "http://localhost:4318"
LOCAL_DEV_KEY = "autter_rt_local_dev_only"
CLICKHOUSE = os.environ.get("CLICKHOUSE_URL", "http://localhost:8123").rstrip("/")
RUN = f"e2e-{int(time.time() * 1000):x}"

# recipe → (service name, route that fails with 500, error type it records)
RECIPES = {
    "flask": ("billing-flask", "/invoices/31/summary", "ZeroDivisionError"),
    "fastapi": ("shop-fastapi", "/carts/12/availability", None),
    "django": ("shop-django", "/orders/4821/charge", None),
    "celery": ("shop-worker", None, "fulfilment.PrinterOffline"),
}


def readme_env(service: str, extra: dict | None = None) -> dict:
    """The variables the README gives, with the local ingester and key."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("OTEL_", "AUTTER_"))}
    env.update({
        "OTEL_EXPORTER_OTLP_ENDPOINT": INGESTER,
        "OTEL_EXPORTER_OTLP_HEADERS": f"x-autter-key={LOCAL_DEV_KEY}",
        "OTEL_SERVICE_NAME": service,
        "OTEL_RESOURCE_ATTRIBUTES": f"service.version={RUN},deployment.environment=development",
        "OTEL_TRACES_SAMPLER": "parentbased_traceidratio",
        "OTEL_TRACES_SAMPLER_ARG": "0.1",
        "OTEL_BSP_SCHEDULE_DELAY": "200",
        "PYTHONPATH": os.pathsep.join(p for p in (ADAPTER, env.get("PYTHONPATH", "")) if p),
        "PYTHONUNBUFFERED": "1",
    })
    env.update(extra or {})
    return env


def sql(query: str) -> list[dict]:
    req = urllib.request.Request(
        f"{CLICKHOUSE}/?database=autter_runtime",
        data=f"{query} FORMAT JSONEachRow".encode(),
        headers={
            "x-clickhouse-user": os.environ.get("CLICKHOUSE_USER", "default"),
            "x-clickhouse-key": os.environ.get("CLICKHOUSE_PASSWORD", "dev"),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        text = res.read().decode().strip()
    return [json.loads(line) for line in text.splitlines()] if text else []


def wait_for_row(query: str, what: str, timeout: float = 60.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        rows = sql(query)
        if rows:
            print(f"  ✔ stored: {what}: {rows[0]}")
            return rows[0]
        if time.monotonic() > deadline:
            raise AssertionError(f"no row after {timeout:.0f}s: {what}\n  {query}")
        time.sleep(1)


def run_web(recipe: str, service: str, route: str) -> str:
    cwd = os.path.join(EXAMPLES, recipe)
    port = free_port()
    bin_dir = os.path.dirname(sys.executable)
    argv = {
        "flask": [os.path.join(bin_dir, "gunicorn"), "-w", "2", "-b", f"127.0.0.1:{port}", "--no-control-socket", "app:app"],
        "fastapi": [sys.executable, "-m", "uvicorn", "app:app", "--port", str(port)],
        "django": [sys.executable, "manage.py", "runserver", f"127.0.0.1:{port}", "--noreload"],
    }[recipe]
    app = App(argv, readme_env(service), cwd, port)
    try:
        status, _ = app.get(route)
        assert status == 500, f"GET {route} → {status}"
        print(f"  ✔ GET {route} → 500")
        wait_for_row(
            f"SELECT error_type, route FROM runtime_error_occurrences "
            f"WHERE service = '{service}' AND release = '{RUN}' LIMIT 1",
            f"{recipe}: the error from {route}",
        )
    except Exception:
        print(app.stop(), file=sys.stderr)
        raise
    return app.stop()


def run_celery(service: str) -> str:
    cwd = os.path.join(EXAMPLES, "celery")
    queue = tempfile.mkdtemp(prefix="autter-celery-e2e-")
    broker = {
        "CELERY_BROKER_URL": "filesystem://",
        "CELERY_FS_QUEUE": os.path.join(queue, "queue"),
        "CELERY_FS_PROCESSED": os.path.join(queue, "processed"),
        "CELERY_FS_CONTROL": os.path.join(queue, "control"),
    }
    for folder in ("queue", "processed", "control"):
        os.makedirs(os.path.join(queue, folder))
    env = readme_env(service, broker)
    if sys.platform == "darwin":
        env["FORKED_BY_MULTIPROCESSING"] = "1"
    # Publish from an uninstrumented producer (the filesystem queue keeps it).
    producer = Process(
        [sys.executable, "-c", "import tasks; tasks.ship_order.delay(1001)"],
        {**{k: v for k, v in env.items() if not k.startswith("OTEL_")}, **broker},
        cwd,
    )
    producer.process.wait(30)
    assert producer.process.returncode == 0, producer.stop()
    producer.stop()
    worker = Process(
        [os.path.join(os.path.dirname(sys.executable), "celery"), "-A", "tasks", "worker",
         "--pool=prefork", "--concurrency=1", "--loglevel=INFO"],
        env, cwd,
    )
    try:
        wait_for_row(
            f"SELECT error_type, message FROM runtime_error_occurrences "
            f"WHERE service = '{service}' AND release = '{RUN}' LIMIT 1",
            "celery: the failing ship_order task",
        )
    except Exception:
        print(worker.stop(), file=sys.stderr)
        raise
    finally:
        shutil.rmtree(queue, True)
    return worker.stop()


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in RECIPES:
        print(f"usage: compose_e2e.py {'|'.join(RECIPES)}", file=sys.stderr)
        return 2
    recipe = sys.argv[1]
    service, route, _ = RECIPES[recipe]
    print(f"examples/python/{recipe} → {INGESTER} (release {RUN})")
    try:
        run_celery(service) if recipe == "celery" else run_web(recipe, service, route)
    except Exception as err:  # noqa: BLE001 - report and fail
        print(f"\n✖ {err}", file=sys.stderr)
        return 1
    print(f"examples/python/{recipe}: stored")
    return 0


if __name__ == "__main__":
    sys.exit(main())
