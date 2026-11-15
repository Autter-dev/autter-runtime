"""Records the FastAPI TestClient fixtures of the ingester's Python tests
(``fastapi-testclient*.otlp.{json,pb}``): the FastAPI recipe app
(examples/python/fastapi) exercised in-process through
``fastapi.testclient.TestClient``, as a test suite does, exporting OTLP/HTTP
to the recipes' stub receiver (examples/python/testing/otlp_stub.py).

    cd examples/python/fastapi
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt httpx
    .venv/bin/python ../../../packages/otlp-ingester/test-fixtures/python/record_fastapi_testclient.py

Two captures, each in its own process (the app calls ``init_tracing()`` at
import): ``fastapi-testclient`` with no ``deployment.environment`` (a test
run that names none), and ``fastapi-testclient-staging`` with
``deployment.environment=staging``. Both keep the raw user agent
(``AUTTER_KEEP_IDENTIFYING_ATTRIBUTES=http.user_agent,user_agent.original``),
as a plain OpenTelemetry sender or an adapter before 1.19.0 sends it; the
current adapter drops it before export, which the ingester's tests model by
removing it. Sampling ratio 0: only the always-on error path exports.

Not run by CI (TestClient needs httpx, which the recipe does not install).
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
RECIPE = os.path.join(REPO, "examples", "python", "fastapi")
TESTING = os.path.join(REPO, "examples", "python", "testing")
ADAPTER = os.path.join(REPO, "adapters", "python")

CAPTURES = {
    "fastapi-testclient": "service.version=9c1e4f2a7b3d",
    "fastapi-testclient-staging": "service.version=9c1e4f2a7b3d,deployment.environment=staging",
}


def capture(name: str) -> None:
    """In the child: run the app under TestClient and write the fixture."""
    sys.path[:0] = [TESTING, RECIPE, ADAPTER]
    from otlp_stub import OtlpStub, package_versions, write_fixture

    stub = OtlpStub()
    os.environ.update({
        "OTEL_EXPORTER_OTLP_ENDPOINT": stub.url,
        "OTEL_EXPORTER_OTLP_HEADERS": "x-autter-key=autter_rt_recipe_test_key_0001",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        "OTEL_SERVICE_NAME": "shop-fastapi",
        "OTEL_RESOURCE_ATTRIBUTES": CAPTURES[name],
        "OTEL_TRACES_SAMPLER": "parentbased_traceidratio",
        "OTEL_TRACES_SAMPLER_ARG": "0",
        "OTEL_BSP_SCHEDULE_DELAY": "200",
        "AUTTER_KEEP_IDENTIFYING_ATTRIBUTES": "http.user_agent,user_agent.original",
        "AUTTER_COUNT_REQUESTS": "false",
    })
    os.chdir(RECIPE)
    from fastapi.testclient import TestClient
    from opentelemetry import trace

    import app as recipe

    # raise_server_exceptions=False: answer 500 as the server would, instead
    # of re-raising in the test, so the request span records the exception.
    client = TestClient(recipe.app, raise_server_exceptions=False)
    assert client.post("/carts/12/checkout").status_code == 500
    assert client.get("/carts/12/quote").status_code == 200
    trace.get_tracer_provider().force_flush()
    deadline = time.monotonic() + 20
    while True:
        spans = stub.spans()
        servers = [s for s in spans if s["kind"] == "SERVER"]
        if len(servers) >= 2:
            break
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out; got {[s['name'] for s in spans]}")
        time.sleep(0.05)
    for server in servers:
        print(name, server["name"], {k: v for k, v in server["attributes"].items() if "host" in k or "server" in k or "agent" in k or "peer" in k})
    write_fixture(stub, name, sorted({s["trace_id"] for s in servers}), RECIPE)
    print(name, package_versions("fastapi", "starlette", "httpx", "opentelemetry-sdk", "opentelemetry-instrumentation-fastapi"))
    stub.close()


def main() -> None:
    if len(sys.argv) == 2:
        capture(sys.argv[1])
        return
    for name in CAPTURES:
        env = {k: v for k, v in os.environ.items() if not k.startswith("OTEL_")}
        env["AUTTER_CAPTURE_FIXTURES"] = HERE
        subprocess.run([sys.executable, os.path.abspath(__file__), name], env=env, check=True)


if __name__ == "__main__":
    main()
