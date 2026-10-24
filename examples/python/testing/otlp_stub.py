"""Test harness for the Python recipes: a stub OTLP/HTTP receiver, an app
runner, and the fixture writer for the ingester's tests.

Not part of any recipe. Each recipe's test starts its app exactly as the docs
say (the ``OTEL_*`` variables, ``autter_tracing.py`` and ``redact.py`` on the
path), points the exporter at :class:`OtlpStub`, and reads back what the app
really sent: the protobuf ``ExportTraceServiceRequest`` bodies the OTLP/HTTP
exporter posts to ``/v1/traces``.

With ``AUTTER_CAPTURE_FIXTURES=<dir>`` set, :func:`write_fixture` saves the
spans of chosen traces as OTLP/JSON and protobuf, with local paths replaced
(``/srv/app``, ``/srv/venv/…/site-packages``, ``/usr/local/lib/pythonX.Y``),
for ``packages/otlp-ingester/test-fixtures/python``.
"""

from __future__ import annotations

import base64
import json
import os
import re
import signal
import socket
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import metadata
from typing import Callable, Optional

from google.protobuf import json_format
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLES = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(EXAMPLES))
ADAPTER = os.path.join(REPO, "adapters", "python")

#: A server key shape the docs use; the stub only checks it arrives.
TEST_KEY = "autter_rt_recipe_test_key_0001"
RELEASE = "9c1e4f2a7b3d"

SPAN_KINDS = {0: "UNSPECIFIED", 1: "INTERNAL", 2: "SERVER", 3: "CLIENT", 4: "PRODUCER", 5: "CONSUMER"}


def _value(any_value):
    kind = any_value.WhichOneof("value")
    if kind == "array_value":
        return [_value(v) for v in any_value.array_value.values]
    if kind == "kvlist_value":
        return {kv.key: _value(kv.value) for kv in any_value.kvlist_value.values}
    return getattr(any_value, kind) if kind else None


def _attrs(key_values) -> dict:
    return {kv.key: _value(kv.value) for kv in key_values}


class OtlpStub:
    """Records every OTLP/HTTP export; answers 200 like the ingester."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self._lock = threading.Lock()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - http.server API
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                with stub._lock:
                    stub.requests.append({"path": self.path, "headers": dict(self.headers.items()), "body": body})
                self.send_response(200)
                self.send_header("content-type", "application/x-protobuf")
                self.send_header("content-length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def trace_requests(self) -> list[dict]:
        with self._lock:
            return [r for r in self.requests if r["path"] == "/v1/traces"]

    def messages(self) -> list[ExportTraceServiceRequest]:
        return [ExportTraceServiceRequest.FromString(r["body"]) for r in self.trace_requests()]

    def spans(self) -> list[dict]:
        """Every received span, flattened, with its resource attributes."""
        out = []
        for message in self.messages():
            for resource_spans in message.resource_spans:
                resource = _attrs(resource_spans.resource.attributes)
                for scope_spans in resource_spans.scope_spans:
                    for span in scope_spans.spans:
                        out.append({
                            "resource": resource,
                            "scope": scope_spans.scope.name,
                            "name": span.name,
                            "kind": SPAN_KINDS.get(span.kind, str(span.kind)),
                            "trace_id": span.trace_id.hex(),
                            "span_id": span.span_id.hex(),
                            "parent_span_id": span.parent_span_id.hex(),
                            "status_code": span.status.code,
                            "status_message": span.status.message,
                            "attributes": _attrs(span.attributes),
                            "events": [{"name": e.name, "attributes": _attrs(e.attributes)} for e in span.events],
                        })
        return out

    def histogram_points(self) -> list[dict]:
        """Every received histogram data point, flattened (``/v1/metrics``)."""
        with self._lock:
            bodies = [r["body"] for r in self.requests if r["path"] == "/v1/metrics"]
        out = []
        for body in bodies:
            for resource_metrics in ExportMetricsServiceRequest.FromString(body).resource_metrics:
                resource = _attrs(resource_metrics.resource.attributes)
                for scope_metrics in resource_metrics.scope_metrics:
                    for metric in scope_metrics.metrics:
                        if metric.WhichOneof("data") != "histogram":
                            continue
                        for point in metric.histogram.data_points:
                            out.append({
                                "resource": resource,
                                "scope": scope_metrics.scope.name,
                                "name": metric.name,
                                "temporality": metric.histogram.aggregation_temporality,
                                "attributes": _attrs(point.attributes),
                                "count": point.count,
                            })
        return out

    def wait_for(self, predicate: Callable[[list[dict]], bool], timeout: float = 20.0) -> list[dict]:
        deadline = time.monotonic() + timeout
        while True:
            spans = self.spans()
            if predicate(spans):
                return spans
            if time.monotonic() > deadline:
                raise AssertionError(f"timed out waiting for spans; got {[(s['name'], s['trace_id'][:8]) for s in spans]}")
            time.sleep(0.05)


def exception_events(span: dict) -> list[dict]:
    return [e["attributes"] for e in span["events"] if e["name"] == "exception"]


def recipe_env(stub: OtlpStub, service: str, *, ratio: str = "0", extra: Optional[dict] = None) -> dict:
    """The environment the docs give, pointed at the stub. Sampling ratio 0
    by default: nothing is head-sampled, so whatever arrives came through the
    always-on error path."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("OTEL_")}
    env.update({
        "OTEL_EXPORTER_OTLP_ENDPOINT": stub.url,
        "OTEL_EXPORTER_OTLP_HEADERS": f"x-autter-key={TEST_KEY}",
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        "OTEL_SERVICE_NAME": service,
        "OTEL_RESOURCE_ATTRIBUTES": f"service.version={RELEASE},deployment.environment=test",
        "OTEL_TRACES_SAMPLER": "parentbased_traceidratio",
        "OTEL_TRACES_SAMPLER_ARG": ratio,
        # Tests only: export quickly instead of every 5 s.
        "OTEL_BSP_SCHEDULE_DELAY": "200",
        "PYTHONPATH": os.pathsep.join(p for p in (ADAPTER, env.get("PYTHONPATH", "")) if p),
        "PYTHONUNBUFFERED": "1",
    })
    env.update(extra or {})
    return env


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Process:
    """A recipe process (server or worker), as it would run in production."""

    def __init__(self, argv: list[str], env: dict, cwd: str):
        handle, self.log_path = tempfile.mkstemp(prefix="autter-recipe-", suffix=".log")
        self._log = os.fdopen(handle, "wb")
        self.process = subprocess.Popen(argv, env=env, cwd=cwd, stdout=self._log, stderr=subprocess.STDOUT)

    def log(self) -> str:
        self._log.flush()
        with open(self.log_path, "rb") as fh:
            return fh.read().decode("utf-8", "replace")

    def stop(self) -> str:
        if self.process.poll() is None:
            # SIGINT, not SIGTERM: Python runs atexit, so the SDK's shutdown
            # flushes what the batch processor still holds.
            self.process.send_signal(signal.SIGINT)
            try:
                self.process.wait(15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        output = self.log()
        self._log.close()
        os.unlink(self.log_path)
        return output


class App(Process):
    """A recipe web app; ready once ``/health`` answers."""

    def __init__(self, argv: list[str], env: dict, cwd: str, port: int):
        super().__init__(argv, env, cwd)
        self.port = port
        self.base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 30
        while True:
            if self.process.poll() is not None:
                raise AssertionError(f"app exited with {self.process.returncode}:\n{self.stop()}")
            try:
                urllib.request.urlopen(f"{self.base}/health", timeout=1).read()
                break
            except Exception:  # noqa: BLE001 - not up yet
                if time.monotonic() > deadline:
                    raise AssertionError(f"app did not start:\n{self.stop()}")
                time.sleep(0.1)

    def get(self, path: str) -> tuple[int, bytes]:
        return self.request("GET", path)

    def post(self, path: str) -> tuple[int, bytes]:
        return self.request("POST", path)

    def request(self, method: str, path: str) -> tuple[int, bytes]:
        try:
            req = urllib.request.Request(f"{self.base}{path}", method=method, data=b"" if method == "POST" else None)
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as err:
            with err:
                return err.code, err.read()


def marker_lines(path: str) -> dict[str, int]:
    """``# frame: <name>`` markers in a recipe source file → line numbers:
    the lines a traceback must name, so expected frames come from the
    source, not from the parser under test."""
    found = {}
    with open(path, encoding="utf-8") as fh:
        for number, line in enumerate(fh, start=1):
            match = re.search(r"#\s*frame:\s*([\w.<>]+)", line)
            if match:
                found[match.group(1)] = number
    return found


def expected_frames(path: str, *names: str) -> list[dict]:
    """In-app frames innermost first, from the markers of ``path``."""
    lines = marker_lines(path)
    return [{"function": name.split(".")[-1], "filename": path, "lineno": lines[name]} for name in names]


def assert_traceback_names(test, stacktrace: str, frames: list[dict]) -> None:
    """The traceback the app sent names each expected frame at its line."""
    for frame in frames:
        test.assertIn(f'File "{frame["filename"]}", line {frame["lineno"]}, in {frame["function"]}', stacktrace)


# ── Fixture capture ───────────────────────────────────────────────────────


def _path_rewrites(app_dir: str) -> list[tuple[str, str]]:
    version = f"python{sys.version_info.major}.{sys.version_info.minor}"
    paths = sysconfig.get_paths()
    rewrites = [
        (os.path.realpath(paths["purelib"]), f"/srv/venv/lib/{version}/site-packages"),
        (paths["purelib"], f"/srv/venv/lib/{version}/site-packages"),
        (os.path.realpath(paths["stdlib"]), f"/usr/local/lib/{version}"),
        (paths["stdlib"], f"/usr/local/lib/{version}"),
        (os.path.realpath(app_dir), "/srv/app"),
        (app_dir, "/srv/app"),
        (os.path.realpath(ADAPTER), "/srv/app"),
        (ADAPTER, "/srv/app"),
    ]
    return sorted({r for r in rewrites}, key=lambda r: -len(r[0]))


def sanitize_text(text: str, rewrites: list[tuple[str, str]]) -> str:
    for local, public in rewrites:
        text = text.replace(local, public)
    # Anything else under a home directory.
    return re.sub(r"/(?:Users|home)/[^/\s\"']+", "/home/user", text)


def _sanitize_values(key_values, rewrites) -> None:
    for kv in key_values:
        _sanitize_any(kv.value, rewrites)


def _sanitize_any(any_value, rewrites) -> None:
    kind = any_value.WhichOneof("value")
    if kind == "string_value":
        any_value.string_value = sanitize_text(any_value.string_value, rewrites)
    elif kind == "array_value":
        for item in any_value.array_value.values:
            _sanitize_any(item, rewrites)
    elif kind == "kvlist_value":
        _sanitize_values(any_value.kvlist_value.values, rewrites)


#: Resource attributes that describe the capturing machine, not the app.
_MACHINE_ATTRIBUTES = re.compile(r"^(?:host\.|process\.(?:pid|parent_pid|command|executable|owner|runtime\.description)|os\.)")


def capture_dir() -> Optional[str]:
    return os.environ.get("AUTTER_CAPTURE_FIXTURES") or None


def package_versions(*names: str) -> dict:
    return {name: metadata.version(name) for name in names}


def write_fixture(stub: OtlpStub, name: str, trace_ids: list[str], app_dir: str) -> Optional[dict]:
    """Save the spans of ``trace_ids`` as one export request
    (``<name>.otlp.json`` + ``<name>.otlp.pb``); returns the path rewrites'
    view of ``app_dir`` for expectations, or None when not capturing."""
    out_dir = capture_dir()
    if not out_dir:
        return None
    rewrites = _path_rewrites(app_dir)
    merged = ExportTraceServiceRequest()
    wanted = {bytes.fromhex(t) for t in trace_ids}
    for message in stub.messages():
        for resource_spans in message.resource_spans:
            for scope_spans in resource_spans.scope_spans:
                spans = [s for s in scope_spans.spans if s.trace_id in wanted]
                if not spans:
                    continue
                target_resource = next(
                    (r for r in merged.resource_spans if r.resource == resource_spans.resource), None
                )
                if target_resource is None:
                    target_resource = merged.resource_spans.add()
                    target_resource.resource.CopyFrom(resource_spans.resource)
                    target_resource.schema_url = resource_spans.schema_url
                target_scope = next((s for s in target_resource.scope_spans if s.scope == scope_spans.scope), None)
                if target_scope is None:
                    target_scope = target_resource.scope_spans.add()
                    target_scope.scope.CopyFrom(scope_spans.scope)
                    target_scope.schema_url = scope_spans.schema_url
                target_scope.spans.extend(spans)
    for resource_spans in merged.resource_spans:
        keep = [kv for kv in resource_spans.resource.attributes if not _MACHINE_ATTRIBUTES.match(kv.key)]
        del resource_spans.resource.attributes[:]
        resource_spans.resource.attributes.extend(keep)
        _sanitize_values(resource_spans.resource.attributes, rewrites)
        for scope_spans in resource_spans.scope_spans:
            for span in scope_spans.spans:
                span.name = sanitize_text(span.name, rewrites)
                span.status.message = sanitize_text(span.status.message, rewrites)
                _sanitize_values(span.attributes, rewrites)
                for event in span.events:
                    _sanitize_values(event.attributes, rewrites)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{name}.otlp.pb"), "wb") as fh:
        fh.write(merged.SerializeToString())
    as_json = json_format.MessageToDict(merged)
    # OTLP/JSON carries trace and span ids as hex, not protobuf's base64.
    for resource_spans in as_json.get("resourceSpans", []):
        for scope_spans in resource_spans.get("scopeSpans", []):
            for span in scope_spans.get("spans", []):
                for key in ("traceId", "spanId", "parentSpanId"):
                    if key in span:
                        span[key] = base64.b64decode(span[key]).hex()
    with open(os.path.join(out_dir, f"{name}.otlp.json"), "w", encoding="utf-8") as fh:
        json.dump(as_json, fh, indent=1)
        fh.write("\n")
    return {"rewrites": rewrites}


def public_path(path: str, app_dir: str) -> str:
    return sanitize_text(path, _path_rewrites(app_dir))


def write_expectations(framework: str, app_dir: str, packages: dict, scenarios: dict) -> None:
    """``<framework>.expect.json``: what the ingester must make of each
    fixture, with expected frames taken from the source markers."""
    out_dir = capture_dir()
    if not out_dir:
        return
    def publish(node):
        if isinstance(node, dict):
            for key, value in node.items():
                node[key] = public_path(value, app_dir) if key == "filename" else publish(value)
        elif isinstance(node, list):
            for item in node:
                publish(item)
        return node

    publish(scenarios)
    document = {
        "framework": framework,
        "captured": {
            "python": ".".join(map(str, sys.version_info[:3])),
            "packages": packages,
        },
        "scenarios": scenarios,
    }
    with open(os.path.join(out_dir, f"{framework}.expect.json"), "w", encoding="utf-8") as fh:
        json.dump(document, fh, indent=1)
        fh.write("\n")
