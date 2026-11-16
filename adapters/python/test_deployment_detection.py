"""Test runs, the running commit and the release in ``init_tracing()``, and
the ``autter.test_client`` mark on test-client requests (autter_tracing.py).
Needs opentelemetry-sdk; skipped without it.

Every test here sets the environment variables it depends on and clears the
rest (the commit variables, the opt-outs, ``PYTEST_*``), so the suite gives
the same answers under unittest, under pytest and on CI (which sets
``GITHUB_SHA``). Test-runner detection is patched where a test needs a
process that is (or is not) a test run.

Run: python3 -m unittest discover -s adapters/python -v
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from opentelemetry.sdk.metrics import Histogram
    from opentelemetry.sdk.metrics.export import AggregationTemporality, MetricExporter, MetricExportResult
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from opentelemetry.sdk.trace.sampling import ALWAYS_ON
    from opentelemetry.trace import SpanKind
except ImportError as error:  # pragma: no cover - depends on the environment
    raise unittest.SkipTest(f"opentelemetry-sdk is not installed ({error})")

import autter_tracing  # noqa: E402
from autter_tracing import (  # noqa: E402
    COMMIT_ENV_VARS,
    TEST_CLIENT_ATTRIBUTE,
    RedactingSpanExporter,
    detect_commit,
    detect_test_runner,
    init_tracing,
)

HERE = os.path.dirname(os.path.abspath(__file__))
SHA = "4f2c9e1a7b3d5f60718293a4b5c6d7e8f9012345"
OTHER_SHA = "9c1e4f2a7b3d"

#: Cleared before every test, then set from the test's own values.
_CONTROLLED = (
    *COMMIT_ENV_VARS,
    "AUTTER_RELEASE",
    "AUTTER_DETECT_RELEASE",
    "AUTTER_DETECT_TEST_ENV",
    "AUTTER_COUNT_REQUESTS",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_SERVICE_NAME",
    "PYTEST_VERSION",
    "PYTEST_CURRENT_TEST",
)


class _Env:
    """``os.environ`` with only ``values`` set among :data:`_CONTROLLED`;
    restored on exit."""

    def __init__(self, **values: str):
        self._values = values
        self._patch = mock.patch.dict(os.environ, {})

    def __enter__(self):
        self._patch.__enter__()
        for name in _CONTROLLED:
            os.environ.pop(name, None)
        os.environ.update(self._values)
        return self

    def __exit__(self, *exc):
        return self._patch.__exit__(*exc)


class CapturingMetricExporter(MetricExporter):
    def __init__(self):
        super().__init__(preferred_temporality={Histogram: AggregationTemporality.DELTA})
        self.batches = []

    def export(self, metrics_data, timeout_millis=10_000, **kwargs):
        self.batches.append(metrics_data)
        return MetricExportResult.SUCCESS

    def force_flush(self, timeout_millis=10_000):
        return True

    def shutdown(self, timeout_millis=30_000, **kwargs):
        pass

    def resources(self):
        return [rm.resource.attributes for batch in self.batches for rm in batch.resource_metrics]


def _start(env=None, runner=None, **kwargs):
    """init_tracing() with ``env`` (everything else in :data:`_CONTROLLED`
    unset) in a process whose test runner is ``runner`` (``None``: not a test
    run). Returns the provider."""
    with _Env(**(env or {})), mock.patch.object(autter_tracing, "detect_test_runner", return_value=runner):
        kwargs.setdefault("count_requests", False)
        return init_tracing(exporter=InMemorySpanExporter(), set_global=False, **kwargs)


def _resource(env=None, runner=None, **kwargs):
    provider = _start(env, runner, **kwargs)
    attributes = dict(provider.resource.attributes)
    provider.shutdown()
    return attributes


class TestRunnerDetection(unittest.TestCase):
    def test_pytest_is_detected_from_its_variables_and_its_module(self):
        no_modules = {}
        self.assertEqual(detect_test_runner({"PYTEST_VERSION": "8.4.2"}, no_modules, ["app.py"]), "pytest")
        self.assertEqual(
            detect_test_runner({"PYTEST_CURRENT_TEST": "test_app.py::test_x (call)"}, no_modules, ["app.py"]), "pytest"
        )
        self.assertEqual(detect_test_runner({}, {"pytest": object()}, ["app.py"]), "pytest")

    def test_django_manage_py_test_is_detected(self):
        self.assertEqual(detect_test_runner({}, {}, ["manage.py", "test"]), "manage.py test")
        self.assertEqual(detect_test_runner({}, {}, ["/srv/app/manage.py", "test", "shop"]), "manage.py test")

    def test_near_misses_are_not_a_test_run(self):
        for environ, modules, argv in (
            ({}, {}, ["manage.py", "runserver"]),
            ({}, {}, ["manage.py"]),
            ({}, {}, ["manage.py", "testserver"]),  # Django's dev server with fixtures
            ({}, {}, ["notmanage.py", "test"]),
            ({}, {}, ["gunicorn", "app:app"]),
            ({}, {"_pytest": object(), "pytest_asyncio": object()}, ["app.py"]),
            ({"PYTEST_VERSION": "", "PYTEST_CURRENT_TEST": ""}, {}, ["app.py"]),
            ({"PYTEST_ADDOPTS": "-q"}, {}, ["app.py"]),
            ({}, {}, []),
        ):
            with self.subTest(environ=environ, modules=sorted(modules), argv=argv):
                self.assertIsNone(detect_test_runner(environ, modules, argv))

    def test_defaults_read_the_process(self):
        with _Env(PYTEST_CURRENT_TEST="x"):
            self.assertEqual(detect_test_runner(), "pytest")


class TestEnvironment(unittest.TestCase):
    def test_a_test_run_without_an_environment_reports_test_and_says_so_once(self):
        with self.assertLogs("autter.runtime", "INFO") as logs:
            resource = _resource(runner="pytest")
        self.assertEqual(resource["deployment.environment.name"], "test")
        self.assertNotIn("deployment.environment", resource, "only the current semantic-conventions name")
        lines = [line for line in logs.output if "test run detected" in line]
        self.assertEqual(len(lines), 1)
        self.assertIn("INFO", lines[0])
        self.assertIn("pytest", lines[0])

    def test_a_passed_resource_without_an_environment_also_reports_test(self):
        resource = _resource(runner="manage.py test", resource=Resource.create({"service.name": "shop"}))
        self.assertEqual(resource["deployment.environment.name"], "test")
        self.assertEqual(resource["service.name"], "shop")

    def test_an_explicit_environment_always_wins(self):
        for env, resource, expected in (
            ({"OTEL_RESOURCE_ATTRIBUTES": "deployment.environment=staging"}, None,
             {"deployment.environment": "staging"}),
            ({"OTEL_RESOURCE_ATTRIBUTES": "deployment.environment.name=production"}, None,
             {"deployment.environment.name": "production"}),
            ({}, Resource.create({"deployment.environment": "production"}), {"deployment.environment": "production"}),
            ({}, Resource.create({"deployment.environment.name": "preview"}), {"deployment.environment.name": "preview"}),
        ):
            with self.subTest(env=env, expected=expected):
                with self.assertLogs("autter.runtime", "DEBUG") as logs:
                    autter_tracing.LOGGER.debug("start")
                    attributes = _resource(env, runner="pytest", resource=resource)
                found = {k: attributes[k] for k in ("deployment.environment", "deployment.environment.name") if k in attributes}
                self.assertEqual(found, expected)
                self.assertFalse(any("test run detected" in line for line in logs.output))

    def test_not_a_test_run_adds_no_environment(self):
        resource = _resource(runner=None)
        self.assertNotIn("deployment.environment", resource)
        self.assertNotIn("deployment.environment.name", resource)

    def test_opt_outs(self):
        for env, kwargs in (
            ({"AUTTER_DETECT_TEST_ENV": "false"}, {}),
            ({"AUTTER_DETECT_TEST_ENV": "0"}, {}),
            ({}, {"detect_test_env": False}),
            ({"AUTTER_DETECT_TEST_ENV": "true"}, {"detect_test_env": False}),  # the argument wins
        ):
            with self.subTest(env=env, kwargs=kwargs):
                resource = _resource(env, runner="pytest", **kwargs)
                self.assertNotIn("deployment.environment.name", resource)
                self.assertNotIn("deployment.environment", resource)
        # And the argument turns it on over the variable.
        self.assertEqual(
            _resource({"AUTTER_DETECT_TEST_ENV": "false"}, runner="pytest", detect_test_env=True)[
                "deployment.environment.name"
            ],
            "test",
        )

    def test_request_counts_carry_the_same_environment_commit_and_release(self):
        metric_exporter = CapturingMetricExporter()
        provider = _start({"GIT_SHA": SHA}, runner="pytest", count_requests=True, metric_exporter=metric_exporter)
        attrs = {"http.method": "GET", "http.route": "/ok", "http.status_code": 200}
        with provider.get_tracer("test").start_as_current_span("GET /ok", kind=SpanKind.SERVER, attributes=attrs):
            pass
        provider.force_flush()
        provider.shutdown()
        metric_resources = metric_exporter.resources()
        self.assertTrue(metric_resources, "the request was counted")
        for key, value in (("deployment.environment.name", "test"), ("deployment.commit", SHA), ("service.version", SHA)):
            self.assertEqual(provider.resource.attributes[key], value)
            for metric_resource in metric_resources:  # older SDKs export once more on shutdown
                self.assertEqual(metric_resource[key], value)
        self.assertIs(metric_resources[0]["autter.metrics_wired"], True)


class Commit(unittest.TestCase):
    def test_variables_are_tried_in_order(self):
        self.assertEqual(
            COMMIT_ENV_VARS,
            (
                "AUTTER_COMMIT", "GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA", "CF_PAGES_COMMIT_SHA", "GIT_SHA",
                "GIT_COMMIT", "COMMIT_SHA", "SOURCE_COMMIT", "RENDER_GIT_COMMIT", "RAILWAY_GIT_COMMIT_SHA",
                "HEROKU_SLUG_COMMIT", "SOURCE_VERSION",
            ),
        )
        for index, name in enumerate(COMMIT_ENV_VARS):
            with self.subTest(name=name):
                environ = {name: SHA}
                # A later variable never overrides it.
                environ.update({later: OTHER_SHA for later in COMMIT_ENV_VARS[index + 1:]})
                self.assertEqual(detect_commit(environ), SHA)

    def test_only_7_to_40_hex_characters_count(self):
        self.assertEqual(detect_commit({"GIT_SHA": "abc1234"}), "abc1234")
        self.assertEqual(detect_commit({"GIT_SHA": " " + SHA.upper() + "\n"}), SHA)
        for value in (
            "abc123",  # 6
            SHA + "a",  # 41
            "abc123g",  # not hex
            "refs/heads/main",  # CodeBuild's SOURCE_VERSION on a branch build
            "v1.2.3",
            "0x" + SHA[:38],
            "abc 1234",
            "",
        ):
            with self.subTest(value=value):
                self.assertIsNone(detect_commit({"SOURCE_VERSION": value}))
        # An invalid value is skipped, not fatal: the next variable is used.
        self.assertEqual(detect_commit({"AUTTER_COMMIT": "main", "GITHUB_SHA": SHA}), SHA)

    def test_init_tracing_sets_deployment_commit(self):
        self.assertEqual(_resource({"VERCEL_GIT_COMMIT_SHA": SHA})["deployment.commit"], SHA)
        self.assertNotIn("deployment.commit", _resource({}))
        self.assertNotIn("deployment.commit", _resource({"GIT_SHA": "not-a-sha"}))

    def test_an_explicit_commit_wins(self):
        resource = _resource({"OTEL_RESOURCE_ATTRIBUTES": f"deployment.commit={OTHER_SHA}", "GIT_SHA": SHA})
        self.assertEqual(resource["deployment.commit"], OTHER_SHA)
        self.assertEqual(resource["service.version"], OTHER_SHA)

    def test_commit_detection_never_runs_git(self):
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("subprocess")), mock.patch.object(
            subprocess, "run", side_effect=AssertionError("subprocess")
        ), mock.patch.object(os, "system", side_effect=AssertionError("os.system")):
            self.assertNotIn("deployment.commit", _resource({}))
            self.assertEqual(_resource({"GIT_SHA": SHA})["deployment.commit"], SHA)


class Release(unittest.TestCase):
    def test_autter_release_then_the_full_commit(self):
        self.assertEqual(_resource({"AUTTER_RELEASE": "2026.11.15", "GIT_SHA": SHA})["service.version"], "2026.11.15")
        self.assertEqual(_resource({"GIT_SHA": SHA})["service.version"], SHA)
        self.assertEqual(_resource({"AUTTER_RELEASE": "  ", "GIT_SHA": SHA})["service.version"], SHA)
        self.assertEqual(_resource({"AUTTER_RELEASE": "2026.11.15"})["service.version"], "2026.11.15")
        self.assertNotIn("service.version", _resource({}))

    def test_an_explicit_release_always_wins(self):
        env = {"AUTTER_RELEASE": "from-env", "GIT_SHA": SHA}
        self.assertEqual(
            _resource({**env, "OTEL_RESOURCE_ATTRIBUTES": "service.version=4.2.0"})["service.version"], "4.2.0"
        )
        resource = _resource(env, resource=Resource.create({"service.version": "4.2.1"}))
        self.assertEqual(resource["service.version"], "4.2.1")
        # The commit is still reported.
        self.assertEqual(resource["deployment.commit"], SHA)

    def test_opt_outs(self):
        for env, kwargs in (
            ({"AUTTER_DETECT_RELEASE": "false"}, {}),
            ({}, {"detect_release": False}),
            ({"AUTTER_DETECT_RELEASE": "true"}, {"detect_release": False}),  # the argument wins
        ):
            with self.subTest(env=env, kwargs=kwargs):
                resource = _resource({"AUTTER_RELEASE": "r1", "GIT_SHA": SHA, **env}, **kwargs)
                self.assertNotIn("service.version", resource)
                self.assertEqual(resource["deployment.commit"], SHA, "the commit is reported either way")


def _server_span(attributes, kind=SpanKind.SERVER, **exporter_options):
    exporter = InMemorySpanExporter()
    provider = TracerProvider(sampler=ALWAYS_ON)
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exporter, **exporter_options)))
    with mock.patch.dict(os.environ, {"AUTTER_KEEP_IDENTIFYING_ATTRIBUTES": "", "AUTTER_DROP_ATTRIBUTES": ""}):
        with provider.get_tracer("test").start_as_current_span("GET /x", kind=kind, attributes=attributes):
            pass
    provider.shutdown()
    [span] = exporter.get_finished_spans()
    return span


# What OpenTelemetry's ASGI instrumentation (0.66b1) records for a request
# made through Starlette's / FastAPI's TestClient, in the old and the stable
# HTTP semantic conventions (recorded with the fastapi recipe's pins).
TESTCLIENT_OLD = {
    "http.scheme": "http", "http.host": "testserver", "net.host.port": 80, "http.flavor": "1.1",
    "http.target": "/x", "http.url": "http://testserver/x", "http.method": "GET",
    "http.server_name": "testserver", "http.user_agent": "testclient", "net.peer.ip": "testclient",
    "net.peer.port": 50000, "http.route": "/x", "http.status_code": 200,
}
TESTCLIENT_STABLE = {
    "url.scheme": "http", "server.address": "testserver", "server.port": 80, "network.protocol.version": "1.1",
    "url.path": "/x", "http.request.method": "GET", "user_agent.original": "testclient",
    "client.address": "testclient", "client.port": 50000, "http.route": "/x", "http.response.status_code": 200,
}

# What OpenTelemetry's Django instrumentation (0.66b2) records for a request
# made through Django's test Client, old HTTP semantic conventions. (With the
# stable ones it records no host at all, so nothing marks the request; a
# ``manage.py test`` run still reports environment ``test``.)
DJANGO_CLIENT_OLD = {
    "http.method": "GET", "http.server_name": "testserver", "http.scheme": "http", "net.host.port": 80,
    "http.url": "http://testserver/x", "net.peer.ip": "127.0.0.1", "http.flavor": "1.1", "http.route": "x",
    "http.status_code": 200,
}


class TestClientMark(unittest.TestCase):
    def test_testclient_requests_are_marked_and_the_user_agent_still_dropped(self):
        for attributes in (TESTCLIENT_OLD, TESTCLIENT_STABLE, DJANGO_CLIENT_OLD):
            with self.subTest(keys=sorted(attributes)[:2]):
                span = _server_span(attributes)
                self.assertIs(span.attributes[TEST_CLIENT_ATTRIBUTE], True)
                self.assertNotIn("http.user_agent", span.attributes)
                self.assertNotIn("user_agent.original", span.attributes)
                self.assertNotIn("client.address", span.attributes)

    def test_each_signal_alone_marks_the_span(self):
        cases = [{"http.method": "GET", key: "testclient"} for key in ("http.user_agent", "user_agent.original")]
        cases += [
            {"http.method": "GET", key: "testserver"}
            for key in ("server.address", "net.host.name", "http.host", "http.server_name")
        ]
        for attributes in cases:
            with self.subTest(attributes=attributes):
                self.assertIs(_server_span(attributes).attributes[TEST_CLIENT_ATTRIBUTE], True)

    def test_marked_also_with_redaction_off_and_the_user_agent_kept(self):
        span = _server_span({"http.user_agent": "testclient"}, redact=False)
        self.assertIs(span.attributes[TEST_CLIENT_ATTRIBUTE], True)
        kept = _server_span({"http.user_agent": "testclient"}, keep_identifying_attributes=True)
        self.assertIs(kept.attributes[TEST_CLIENT_ATTRIBUTE], True)
        self.assertEqual(kept.attributes["http.user_agent"], "testclient")

    def test_near_misses_are_not_marked(self):
        for attributes, kind in (
            ({"http.user_agent": "testclient/1.0"}, SpanKind.SERVER),
            ({"http.user_agent": "TestClient"}, SpanKind.SERVER),
            ({"http.user_agent": " testclient"}, SpanKind.SERVER),
            ({"http.user_agent": "python-httpx/0.28 testclient"}, SpanKind.SERVER),
            ({"user_agent.original": "Werkzeug/3.1.3"}, SpanKind.SERVER),  # Flask's test client
            ({"http.host": "testserver:8000"}, SpanKind.SERVER),
            ({"http.host": "testserver.example.com"}, SpanKind.SERVER),
            ({"server.address": "localhost"}, SpanKind.SERVER),
            ({"server.address": "TESTSERVER"}, SpanKind.SERVER),
            ({"http.url": "http://testserver/x"}, SpanKind.SERVER),  # not a host key
            ({"net.peer.ip": "testclient"}, SpanKind.SERVER),  # the client, not the user agent
            ({"peer.service": "testserver", "http.user_agent": "Mozilla/5.0"}, SpanKind.SERVER),
            # A client span calling a test server (an outgoing call), and an internal one.
            ({"http.user_agent": "testclient", "server.address": "testserver"}, SpanKind.CLIENT),
            ({"http.user_agent": "testclient"}, SpanKind.INTERNAL),
        ):
            with self.subTest(attributes=attributes, kind=kind):
                self.assertNotIn(TEST_CLIENT_ATTRIBUTE, _server_span(attributes, kind).attributes)

    def test_init_tracing_marks_retained_error_spans(self):
        exporter = InMemorySpanExporter()
        with _Env(OTEL_TRACES_SAMPLER="always_off"), mock.patch.object(
            autter_tracing, "detect_test_runner", return_value=None
        ):
            provider = init_tracing(exporter=exporter, set_global=False, count_requests=False)
        with self.assertRaises(ValueError):
            with provider.get_tracer("test").start_as_current_span("GET /x", kind=SpanKind.SERVER, attributes=TESTCLIENT_OLD):
                raise ValueError("boom")
        provider.force_flush()
        [span] = exporter.get_finished_spans()
        self.assertIs(span.attributes[TEST_CLIENT_ATTRIBUTE], True)
        self.assertIs(span.attributes[autter_tracing.TAIL_RETAINED_ATTRIBUTE], True)
        self.assertNotIn("http.user_agent", span.attributes)
        # A hint only: a test-client request never decides the environment
        # (a caller could fake it); outside a test run there is none.
        self.assertNotIn("deployment.environment", span.resource.attributes)
        self.assertNotIn("deployment.environment.name", span.resource.attributes)
        provider.shutdown()


_PYTEST_PROBE = textwrap.dedent(
    """
    import os, sys
    sys.path.insert(0, {here!r})
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from autter_tracing import init_tracing

    def test_reports_test():
        provider = init_tracing(exporter=InMemorySpanExporter(), set_global=False, count_requests=False)
        assert provider.resource.attributes["deployment.environment.name"] == "test"
        assert "deployment.environment" not in provider.resource.attributes

    def test_explicit_environment_wins():
        os.environ["OTEL_RESOURCE_ATTRIBUTES"] = "deployment.environment=production"
        provider = init_tracing(exporter=InMemorySpanExporter(), set_global=False, count_requests=False)
        assert provider.resource.attributes["deployment.environment"] == "production"
        assert "deployment.environment.name" not in provider.resource.attributes  # the old name, set by the user, is kept and wins
    """
)


class UnderPytest(unittest.TestCase):
    """Detection inside a real pytest run (a child process; this suite itself
    may run under unittest). Skipped when pytest is not installed."""

    def test_a_real_pytest_run_reports_test(self):
        # find_spec, not import: importing pytest here would make every later
        # init_tracing() in this process a detected test run.
        if importlib.util.find_spec("pytest") is None:
            self.skipTest("pytest is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "test_probe.py")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(_PYTEST_PROBE.format(here=HERE))
            env = {k: v for k, v in os.environ.items() if k not in _CONTROLLED}
            result = subprocess.run(
                [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", path],
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("2 passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
