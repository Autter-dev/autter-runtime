"""Version compatibility check for Python services sending to Autter Runtime.

Plain OpenTelemetry SDKs talk to the Autter ingester directly, so nothing in
the SDK knows whether the ingester can store what it sends (OTLP logs need
ingester >= 1.4.0, memory metrics >= 1.3.3, ...). This module asks once:

* ``warn_if_incompatible(endpoint, ["operation_logging"])`` - fire-and-forget
  background check at startup; logs ONE warning per incompatible feature on
  the ``autter.runtime`` logger, naming both versions and the fix. Never
  raises, never blocks (daemon thread). Disabled by ``AUTTER_COMPAT_CHECK=0``.
* ``python3 compat.py doctor --endpoint https://ingest.example.com`` - one-shot
  report: versions, storage readiness (``/healthz``), the ingest key ("not
  checked" without one) and, when the ingester can't be reached, where the
  path breaks (DNS, TCP, TLS, HTTP). Exit 0 ready, 1 a problem, 2 unreachable.
* ``python3 compat.py verify --service checkout`` - sends one tagged test
  span, error and log record and reads them back, naming the first failing
  step. The test event never opens an issue. Exit 0 delivered, 1 a step
  failed, 2 unreachable.

Stdlib only, like the rest of this adapter. ``MANIFEST`` is a copy of the
single source of truth, ``packages/otlp-ingester/src/compat-manifest.json``;
``test_compat.py`` fails if they drift.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable, Optional

MANIFEST: dict[str, Any] = json.loads(
    r"""
{
    "manifestVersion": 1,
    "docs": "https://github.com/Autter-dev/autter-runtime/blob/main/docs/COMPATIBILITY.md",
    "upgrade": {
        "ingester": "docker pull ghcr.io/autter-dev/otlp-ingester:latest and restart it (ClickHouse migrations run at boot)",
        "sdk": "npm install {package}@latest"
    },
    "features": [
        {
            "id": "llm_calls",
            "title": "LLM call tracking",
            "ingester": "1.1.0",
            "migrations": [
                "0004-llm-calls"
            ],
            "sdks": {
                "@autter/runtime-node": "1.1.0",
                "@autter/runtime-next": "1.1.0"
            }
        },
        {
            "id": "endpoint_latency",
            "title": "Endpoint latency regression detection",
            "ingester": "1.3.1",
            "migrations": [
                "0005-latency-histograms"
            ],
            "sdks": {
                "@autter/runtime-node": "1.3.0",
                "@autter/runtime-next": "1.3.0"
            }
        },
        {
            "id": "browser_network_events",
            "title": "Browser network, timing and outcome capture",
            "ingester": "1.3.2",
            "migrations": [],
            "sdks": {
                "@autter/runtime-browser": "1.3.2",
                "@autter/runtime-next": "1.3.2"
            },
            "browserEvents": [
                "request_failure",
                "timing",
                "outcome"
            ]
        },
        {
            "id": "profiles",
            "title": "Profile ingestion",
            "ingester": "1.3.2",
            "migrations": [
                "0006-profile-samples"
            ],
            "route": "/v1/profiles",
            "sdks": {}
        },
        {
            "id": "source_maps",
            "title": "Source map upload",
            "ingester": "1.3.2",
            "migrations": [
                "0007-source-maps"
            ],
            "route": "/v1/sourcemaps",
            "sdks": {}
        },
        {
            "id": "memory_metrics",
            "title": "Memory pressure detection",
            "ingester": "1.3.3",
            "migrations": [
                "0008-memory-signals",
                "0010-memory-temporality"
            ],
            "sdks": {
                "@autter/runtime-node": "1.3.3",
                "@autter/runtime-next": "1.3.3"
            }
        },
        {
            "id": "platform_events",
            "title": "Platform OOM/restart events",
            "ingester": "1.3.3",
            "migrations": [
                "0008-memory-signals"
            ],
            "route": "/v1/platform-events",
            "sdks": {}
        },
        {
            "id": "csp_violations",
            "title": "Browser CSP violation capture",
            "ingester": "1.3.4",
            "migrations": [],
            "sdks": {
                "@autter/runtime-browser": "1.3.3",
                "@autter/runtime-next": "1.3.4"
            },
            "browserEvents": [
                "csp_violation"
            ]
        },
        {
            "id": "operation_logging",
            "title": "Operation logging",
            "ingester": "1.4.0",
            "migrations": [
                "0011-runtime-logs"
            ],
            "route": "/v1/logs",
            "sdks": {
                "@autter/runtime-node": "1.4.0",
                "@autter/runtime-next": "1.4.0"
            }
        },
        {
            "id": "request_summaries",
            "title": "Request summaries and the per-route request rollup",
            "ingester": "1.5.0",
            "migrations": [
                "0012-runtime-logs-requests",
                "0014-runtime-request-1m"
            ],
            "route": "/v1/logs",
            "sdks": {
                "@autter/runtime-node": "1.5.0",
                "@autter/runtime-next": "1.5.0",
                "@autter/runtime-edge": "1.0.0"
            }
        },
        {
            "id": "coded_errors",
            "title": "Coded errors and code-based grouping",
            "ingester": "1.5.0",
            "migrations": [
                "0013-occurrence-codes"
            ],
            "sdks": {
                "@autter/runtime-node": "1.5.0",
                "@autter/runtime-next": "1.5.0",
                "@autter/runtime-browser": "1.4.0",
                "@autter/runtime-edge": "1.0.0"
            }
        },
        {
            "id": "breadcrumbs",
            "title": "Breadcrumbs: the steps before an error",
            "ingester": "1.6.0",
            "migrations": [],
            "sdks": {
                "@autter/runtime-browser": "1.6.0",
                "@autter/runtime-node": "1.6.0",
                "@autter/runtime-next": "1.6.0"
            }
        },
        {
            "id": "source_map_debug_ids",
            "title": "Source map debug ids",
            "ingester": "1.6.0",
            "migrations": [
                "0017-source-maps-debug-id"
            ],
            "route": "/v1/sourcemaps/check",
            "sdks": {
                "@autter/runtime-browser": "1.6.0",
                "@autter/runtime-next": "1.6.0"
            }
        },
        {
            "id": "fingerprint_override",
            "title": "Fingerprint override",
            "ingester": "1.6.0",
            "migrations": [],
            "sdks": {
                "@autter/runtime-browser": "1.6.0",
                "@autter/runtime-node": "1.6.0",
                "@autter/runtime-next": "1.6.0",
                "@autter/runtime-edge": "1.1.0"
            }
        },
        {
            "id": "browser_trace_propagation",
            "title": "Browser trace propagation (browser errors linked to server traces)",
            "ingester": "1.6.0",
            "migrations": [],
            "sdks": {
                "@autter/runtime-browser": "1.6.0",
                "@autter/runtime-next": "1.6.0",
                "@autter/runtime-node": "1.6.0"
            }
        },
        {
            "id": "sourcemap_upload_keys",
            "title": "Upload-only keys for source maps (autter_rtu_)",
            "ingester": "1.7.0",
            "migrations": [],
            "route": "/v1/sourcemaps",
            "sdks": {}
        },
        {
            "id": "source_map_verify",
            "title": "Source map check by debug id (autter-runtime sourcemaps verify)",
            "ingester": "1.7.0",
            "migrations": [
                "0017-source-maps-debug-id"
            ],
            "route": "/v1/sourcemaps/check",
            "sdks": {}
        },
        {
            "id": "ingest_drop_counts",
            "title": "Rejected and dropped records per repository",
            "ingester": "1.8.0",
            "migrations": [
                "0018-runtime-ingest-drops"
            ],
            "sdks": {}
        },
        {
            "id": "telemetry_sender_via",
            "title": "How each service's telemetry arrives (SDK, OpenTelemetry Collector or browser relay)",
            "ingester": "1.8.0",
            "migrations": [
                "0019-sdk-versions-via"
            ],
            "sdks": {}
        },
        {
            "id": "frame_resolution_counts",
            "title": "Resolved and unresolved browser frames per occurrence",
            "ingester": "1.8.0",
            "migrations": [
                "0020-occurrence-frame-resolution"
            ],
            "sdks": {}
        },
        {
            "id": "ingest_suppression",
            "title": "Suppression rules: drop or sample matching errors at ingest",
            "ingester": "1.9.0",
            "migrations": [],
            "sdks": {}
        },
        {
            "id": "loop_collapse",
            "title": "Loop collapse: a looping error stored as one sample a minute with an exact count",
            "ingester": "1.9.0",
            "migrations": [
                "0021-occurrence-collapsed-count"
            ],
            "sdks": {}
        },
        {
            "id": "edge_request_counts",
            "title": "Edge requests counted from their request summaries",
            "ingester": "1.10.0",
            "migrations": [],
            "route": "/v1/logs",
            "sdks": {
                "@autter/runtime-edge": "1.3.0"
            }
        },
        {
            "id": "caught_errors",
            "title": "Caught errors and deliberate fallbacks recorded as handled occurrences",
            "ingester": "1.11.0",
            "migrations": [],
            "sdks": {
                "@autter/runtime-node": "1.9.0",
                "@autter/runtime-edge": "1.4.0",
                "@autter/runtime-next": "1.9.0",
                "@autter/runtime-browser": "1.8.0"
            }
        },
        {
            "id": "route_percentiles",
            "title": "Per-route p95 and p99 latency in the 1-minute rollups",
            "ingester": "1.11.0",
            "migrations": [
                "0022-route-latency-1m"
            ],
            "sdks": {}
        },
        {
            "id": "server_source_maps",
            "title": "Server bundles symbolicated, with source context lines",
            "ingester": "1.11.0",
            "migrations": [],
            "route": "/v1/sourcemaps",
            "sdks": {
                "@autter/runtime-cli": "1.3.0",
                "@autter/runtime-node": "1.9.0",
                "@autter/runtime-edge": "1.4.0",
                "@autter/runtime-next": "1.9.0"
            }
        },
        {
            "id": "cause_fingerprint",
            "title": "Wrapped errors grouped with their root cause (cause-v1)",
            "ingester": "1.11.0",
            "migrations": [],
            "sdks": {
                "@autter/runtime-node": "1.9.0",
                "@autter/runtime-edge": "1.4.0",
                "@autter/runtime-next": "1.9.0"
            }
        },
        {
            "id": "llm_cache_tokens",
            "title": "Cache-aware LLM cost (prompt-cache reads and writes)",
            "ingester": "1.16.0",
            "migrations": [
                "0024-llm-cache-tokens"
            ],
            "sdks": {
                "@autter/runtime-node": "1.14.0"
            }
        }
    ]
}
"""
)

INGESTER_VERSION_HEADER = "x-autter-ingester-version"
PYTHON_FEATURES = ("llm_calls", "endpoint_latency", "memory_metrics", "operation_logging")
DEFAULT_ENDPOINT = "https://otlp.autter.dev"
LOGGER = logging.getLogger("autter.runtime")

_VERSION_RE = re.compile(r"^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]+)?")


def _parse(version: Optional[str]):
    if not isinstance(version, str):
        return None
    match = _VERSION_RE.match(version.strip())
    if not match:
        return None
    return (int(match[1]), int(match[2]), int(match[3]), 0 if match[4] else 1)


def version_at_least(version: Optional[str], minimum: str) -> Optional[bool]:
    """True/False when comparable, None when the version is unknown."""
    left, right = _parse(version), _parse(minimum)
    if left is None or right is None:
        return None
    return left >= right


def _feature(feature_id: str) -> Optional[dict]:
    return next((f for f in MANIFEST["features"] if f["id"] == feature_id), None)


def ingester_upgrade_hint() -> str:
    return f"Upgrade the ingester: {MANIFEST['upgrade']['ingester']}. See {MANIFEST['docs']}"


def evaluate(features: Iterable[str], ingester: Optional[dict]) -> list[dict]:
    """Incompatibilities for the features in use (same rules as compat.ts).

    ``ingester`` is ``{"version": str|None, "schema": {"status", "applied"},
    "routes": {route: bool}}``. Unknown never produces an issue.
    """
    issues: list[dict] = []
    if not ingester:
        return issues
    seen: set[str] = set()
    fix = ingester_upgrade_hint()
    for feature_id in features:
        if feature_id in seen:
            continue
        seen.add(feature_id)
        feature = _feature(feature_id)
        if feature is None:
            continue
        version = ingester.get("version")
        at_least = version_at_least(version, feature["ingester"])
        if at_least is False:
            issues.append({
                "feature": feature_id, "kind": "ingester_too_old",
                "required": feature["ingester"], "actual": version, "fix": fix,
                "message": f"{feature['title']} needs ingester >= {feature['ingester']}; yours is {version}. {fix}",
            })
            continue
        route = feature.get("route")
        if version is None and route and (ingester.get("routes") or {}).get(route) is False:
            actual = "1.4.0 or older (no /v1/compat)"
            issues.append({
                "feature": feature_id, "kind": "ingester_too_old",
                "required": feature["ingester"], "actual": actual, "fix": fix,
                "message": f"{feature['title']} needs ingester >= {feature['ingester']}; yours is {actual} "
                           f"and has no {route} route, so this data is dropped. {fix}",
            })
            continue
        schema = ingester.get("schema")
        if at_least and schema and feature["migrations"]:
            applied = set(schema.get("applied") or [])
            missing = [m for m in feature["migrations"] if m not in applied]
            status = schema.get("status")
            if status == "failed" or (status == "ready" and missing):
                what = ", ".join(missing or feature["migrations"])
                schema_fix = ("Check the ingester's CLICKHOUSE_URL/credentials and its logs, then restart it so "
                              f"the boot migrations run. See {MANIFEST['docs']}")
                issues.append({
                    "feature": feature_id, "kind": "schema_not_applied",
                    "required": ", ".join(feature["migrations"]), "actual": status, "fix": schema_fix,
                    "message": f"{feature['title']} needs ClickHouse migration {what}, which ingester {version} "
                               f"has not applied (schema {status}). {schema_fix}",
                })
    return issues


def _request(method: str, url: str, timeout: float, body: Optional[bytes] = None,
             headers: Optional[dict] = None):
    """(status, headers, text) or None on any failure."""
    req = urllib.request.Request(url, data=body, method=method, headers={
        "accept": "application/json", "user-agent": "autter-runtime-python-compat",
        **({"content-type": "application/json"} if body is not None else {}),
        **(headers or {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - user-configured endpoint
            return res.status, res.headers, res.read(256 * 1024).decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        try:
            text = err.read(64 * 1024).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            text = ""
        return err.code, err.headers, text
    except Exception:  # noqa: BLE001 - never raise from a diagnostic
        return None


def fetch_ingester_compat(endpoint: str, probe_routes: Iterable[str] = (), timeout: float = 3.0):
    """``(info, error)``: what the ingester supports, or ``(None, reason)``.

    A 404 on /v1/compat means an ingester from before version reporting
    (1.4.0 or older); ``probe_routes`` then learns which routes exist.
    """
    base = endpoint.rstrip("/")
    result = _request("GET", f"{base}/v1/compat", timeout)
    if result is None:
        return None, f"could not reach {base}/v1/compat"
    status, headers, text = result
    header_version = headers.get(INGESTER_VERSION_HEADER) if headers else None
    if status == 200:
        try:
            report = json.loads(text)
            version = report["ingester"]["version"]
            if _parse(version) is None:
                raise ValueError(version)
            info: dict = {"version": version}
            schema = report.get("schema") or {}
            if schema.get("status") in ("ready", "pending", "failed", "unconfigured"):
                info["schema"] = {"status": schema["status"], "applied": list(schema.get("applied") or [])}
            return info, None
        except Exception:  # noqa: BLE001
            if _parse(header_version):
                return {"version": header_version}, None
            return None, "unrecognised /v1/compat response"
    if status == 404:
        if _parse(header_version):
            return {"version": header_version}, None
        routes = {}
        for route in probe_routes:
            probe = _request("POST", f"{base}{route}", timeout, b"{}")
            if probe is not None:
                routes[route] = probe[0] != 404
        return {"version": None, "legacy": True, "routes": routes}, None
    return None, f"/v1/compat answered {status}"


def _routes_for(features: Iterable[str]) -> list[str]:
    routes = []
    for feature_id in features:
        route = (_feature(feature_id) or {}).get("route")
        if route and route not in routes:
            routes.append(route)
    return routes


_warned: set[str] = set()
_lock = threading.Lock()


def _env_disabled() -> bool:
    return os.environ.get("AUTTER_COMPAT_CHECK", "").strip().lower() in ("0", "false", "off")


def check_once(endpoint: str, features: Iterable[str], logger: Optional[logging.Logger] = None) -> list[dict]:
    """Synchronous check; logs each new issue once per process. Never raises."""
    try:
        features = list(features)
        info, error = fetch_ingester_compat(endpoint, _routes_for(features))
        log = logger or LOGGER
        if info is None:
            log.debug("autter compat check skipped: %s", error)
            return []
        issues = evaluate(features, info)
        for issue in issues:
            key = f"{issue['feature']}:{issue['kind']}"
            with _lock:
                if key in _warned:
                    continue
                _warned.add(key)
            log.warning("[autter-runtime] %s", issue["message"])
        return issues
    except Exception:  # noqa: BLE001 - never break the host app
        return []


def warn_if_incompatible(
    endpoint: str,
    features: Iterable[str],
    *,
    enabled: bool = True,
    logger: Optional[logging.Logger] = None,
) -> Optional[threading.Thread]:
    """Fire-and-forget background check (daemon thread). Returns the thread
    (for tests) or None when disabled."""
    if not enabled or _env_disabled():
        return None
    thread = threading.Thread(
        target=check_once, args=(endpoint, list(features), logger), name="autter-compat-check", daemon=True
    )
    thread.start()
    return thread


# ── key, storage and connectivity ─────────────────────────────────────────

_NOT_A_KEY = ("", "undefined", "null", "none")


def key_from_env(env: Optional[dict] = None) -> Optional[str]:
    """The ingest key a Python service sends: ``AUTTER_RUNTIME_KEY``, else
    the bearer token or ``x-autter-key`` in ``OTEL_EXPORTER_OTLP_[TRACES_]HEADERS``."""
    env = os.environ if env is None else env
    direct = (env.get("AUTTER_RUNTIME_KEY") or "").strip()
    if direct.lower() not in _NOT_A_KEY:
        return direct
    for name in ("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_HEADERS"):
        for pair in (env.get(name) or "").split(","):
            if "=" not in pair:
                continue
            header, value = pair.split("=", 1)
            value = urllib.parse.unquote(value).strip()
            header = header.strip().lower()
            token = value[7:].strip() if header == "authorization" and value.lower().startswith("bearer ") else (
                value if header == "x-autter-key" else "")
            if token.lower() not in _NOT_A_KEY:
                return token
    return None


def _reason(text: str) -> str:
    try:
        body = json.loads(text)
        parts = [body.get(k) for k in ("error", "detail") if isinstance(body.get(k), str) and body.get(k)]
        return ": ".join(parts)[:300]
    except Exception:  # noqa: BLE001
        return " ".join((text or "").split())[:300]


def check_key(endpoint: str, key: str, timeout: float = 5.0) -> tuple[str, Optional[str]]:
    """``(state, reason)``: accepted, rejected, client_key, storage_unavailable,
    unverified or unknown. An empty OTLP batch: authenticates, stores nothing."""
    res = _request("POST", f"{endpoint.rstrip('/')}/v1/traces", timeout, b'{"resourceSpans":[]}',
                   {"authorization": f"Bearer {key}"})
    if res is None:
        return "unknown", None
    status, headers, text = res
    reason = _reason(text) or None
    if 200 <= status < 300:
        return "accepted", None
    if status == 401:
        return "rejected", reason
    if status == 403:
        return "client_key", reason
    if status == 503:
        return ("unverified" if headers and headers.get("retry-after") else "storage_unavailable"), reason
    return "unknown", reason


_STORAGE_TEXT = {
    "up": "ready: ClickHouse accepts writes",
    "down": "ClickHouse is unreachable or failing writes (retryable): ingest answers 503 and exporters retry",
    "auth_failed": "ClickHouse refuses the ingester's credentials: fix CLICKHOUSE_USER/CLICKHOUSE_PASSWORD on the ingester",
    "schema_missing": "ClickHouse tables are missing: check the ingester logs for the boot migrations, then restart it",
    "unconfigured": "no ClickHouse configured (CLICKHOUSE_URL unset): every ingest request is refused with 503",
}


def check_storage(endpoint: str, timeout: float = 5.0) -> Optional[dict]:
    """``GET /healthz``: ``{"state", "ok", "writeChecked", "detail"}`` or None."""
    res = _request("GET", f"{endpoint.rstrip('/')}/healthz", timeout)
    if res is None:
        return None
    status, _headers, text = res
    try:
        reported = json.loads(text).get("clickhouse")
    except Exception:  # noqa: BLE001
        reported = None
    if not isinstance(reported, str):
        if 200 <= status < 300:
            return {"state": "up", "ok": True, "writeChecked": False,
                    "detail": "reachable (this ingester predates 1.12 and does not check writes; `verify` does)"}
        if status == 503:
            return {"state": "down", "ok": False, "writeChecked": False, "detail": "/healthz answered 503: the ingester is not ready"}
        return {"state": "unknown", "ok": True, "writeChecked": False, "detail": f"not checked: /healthz answered {status}"}
    ok = 200 <= status < 300 and reported == "up"
    return {"state": reported, "ok": ok, "writeChecked": True, "detail": _STORAGE_TEXT.get(reported, f"ClickHouse {reported}")}


def diagnose_connectivity(endpoint: str, timeout: float = 5.0) -> dict:
    """Where the path to the ingester breaks: dns, tcp, tls, http."""
    import socket
    import ssl
    import time

    parsed = urllib.parse.urlparse(endpoint)
    host = parsed.hostname or ""
    secure = parsed.scheme == "https"
    port = parsed.port or (443 if secure else 80)
    steps: list[dict] = []

    def fail(step: str, detail: str, hint: str) -> dict:
        steps.append({"step": step, "ok": False, "detail": detail})
        return {"ok": False, "host": host, "port": port, "steps": steps,
                "failed": {"step": step, "detail": detail, "hint": hint}}

    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    proxy_note = (" HTTPS_PROXY is set: the OTLP exporter uses it only if your HTTP stack does;"
                  " allow the ingester host directly if this network requires the proxy.") if proxy else ""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except Exception as err:  # noqa: BLE001
        return fail("dns", f"{host} does not resolve ({err})",
                    "Check the host name in the endpoint; on a VPN or in a container, check its DNS settings.")
    addresses = []
    for family, _t, _p, _c, sockaddr in sorted(infos, key=lambda i: 0 if i[0] == socket.AF_INET else 1):
        if sockaddr[0] not in [a[1][0] for a in addresses]:
            addresses.append((family, sockaddr))
    steps.append({"step": "dns", "ok": True, "detail": f"{host} -> {', '.join(a[1][0] for a in addresses)}"})
    reached = None
    failures = []
    for family, sockaddr in addresses[:3]:
        start = time.monotonic()
        try:
            with socket.create_connection((sockaddr[0], port), timeout=timeout):
                reached = sockaddr[0]
                steps.append({"step": "tcp", "ok": True, "detail": f"connected to {sockaddr[0]}:{port} ({int((time.monotonic() - start) * 1000)} ms)"})
                break
        except socket.timeout:
            failures.append(f"{sockaddr[0]}:{port} timed out after {int(timeout * 1000)} ms")
        except OSError as err:
            failures.append(f"{sockaddr[0]}:{port} {err.strerror or err}")
    if reached is None:
        timed_out = any("timed out" in f for f in failures)
        hint = ("Packets to this address get no answer: an outbound firewall, security group or egress rule drops them,"
                " or (IPv6) the network has no IPv6 route." if timed_out else
                "The connection was refused: check the port, or that the ingester is running.")
        return fail("tcp", "; ".join(failures), hint + proxy_note)
    if secure:
        try:
            context = ssl.create_default_context()
            with socket.create_connection((reached, port), timeout=timeout) as raw:
                with context.wrap_socket(raw, server_hostname=host):
                    pass
            steps.append({"step": "tls", "ok": True, "detail": f"certificate valid for {host}"})
        except ssl.SSLCertVerificationError as err:
            return fail("tls", f"TLS certificate not trusted ({err.verify_message})",
                        "A proxy may be intercepting TLS, or the CA is private: set SSL_CERT_FILE / REQUESTS_CA_BUNDLE to its CA bundle.")
        except Exception as err:  # noqa: BLE001
            return fail("tls", f"TLS handshake with {host} failed ({err})", "A middlebox may be blocking the handshake.")
    res = _request("GET", f"{endpoint.rstrip('/')}/livez", timeout)
    if res is None:
        return fail("http", f"no HTTP answer from {endpoint.rstrip('/')}/livez",
                    "The connection opens but no HTTP response comes back: a proxy or load balancer may be holding it." + proxy_note)
    steps.append({"step": "http", "ok": True, "detail": f"GET /livez answered {res[0]}"})
    return {"ok": True, "host": host, "port": port, "steps": steps}


def doctor(endpoint: str, features: Optional[list[str]] = None, timeout: float = 5.0,
           key: Optional[str] = None) -> tuple[dict, int]:
    """One-shot report and exit code (0 ready, 1 a problem, 2 unreachable)."""
    # What a Python service sends over plain OTLP: traces (LLM spans),
    # metrics (latency histograms, process memory) and logs.
    features = features or list(PYTHON_FEATURES)
    endpoint = endpoint.rstrip("/")
    info, error = fetch_ingester_compat(endpoint, _routes_for(features), timeout)
    issues = evaluate(features, info)
    key_state, key_reason = check_key(endpoint, key, timeout) if key else ("not_checked", None)
    storage = check_storage(endpoint, timeout) if info is not None else None
    report = {"endpoint": endpoint, "ingester": info, "error": error, "features": features, "issues": issues,
              "key": key_state, "keyDetail": key_reason, "storage": storage}
    if info is None:
        report["connectivity"] = diagnose_connectivity(endpoint, timeout)
        return report, 2
    bad_key = key_state in ("rejected", "client_key", "storage_unavailable", "unverified")
    return report, 1 if issues or bad_key or (storage is not None and not storage["ok"]) else 0


# ── verify ────────────────────────────────────────────────────────────────

VERIFY_STEPS = ("key", "network", "ingester", "storage", "auth", "ingest", "stored", "trace", "release", "logs")

_AUTH_FIX = {
    401: "Check AUTTER_RUNTIME_KEY: it must be a server key (autter_rt_...) of this repository, not revoked.",
    403: "Python services need a server key (autter_rt_...); client keys are for browsers, upload keys for source maps.",
    429: "The ingester is rate limiting this key or address; wait and run verify again.",
    503: "The ingester could not check the key or store data right now; run again in a few seconds.",
}


def _attr(key: str, value: str) -> dict:
    return {"key": key, "value": {"stringValue": value}}


def verify(endpoint: str, key: Optional[str], service: str, environment: str = "verify",
           release: Optional[str] = None, wait: float = 20.0, timeout: float = 5.0,
           poll: float = 0.5) -> tuple[dict, int]:
    """Send one tagged test event and read it back; ``(report, exit code)``."""
    import time

    endpoint = endpoint.rstrip("/")
    trace_id = os.urandom(16).hex()
    steps: list[dict] = []
    report = {"endpoint": endpoint, "service": service, "environment": environment, "release": release,
              "traceId": trace_id, "steps": steps, "firstFailure": None}

    def done(code: Optional[int] = None) -> tuple[dict, int]:
        names = [s["step"] for s in steps]
        for name in VERIFY_STEPS:
            if name not in names:
                steps.append({"step": name, "status": "skip", "detail": "not run: an earlier step failed"})
        steps.sort(key=lambda s: VERIFY_STEPS.index(s["step"]))
        report["firstFailure"] = next((s for s in steps if s["status"] == "fail"), None)
        return report, code if code is not None else (1 if report["firstFailure"] else 0)

    def add(step: str, status: str, detail: str, fix: Optional[str] = None) -> None:
        steps.append({"step": step, "status": status, "detail": detail, **({"fix": fix} if fix else {})})

    if not key:
        add("key", "fail", "no ingest key: --key not given, AUTTER_RUNTIME_KEY not set, no bearer token in OTEL_EXPORTER_OTLP_HEADERS",
            "Set AUTTER_RUNTIME_KEY (or OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20<key>) to a server key.")
        return done()
    if key.startswith(("autter_rtc_", "autter_rtu_")):
        add("key", "fail", "the key is a client or upload key", _AUTH_FIX[403])
        return done()
    add("key", "pass", f"{key[:10]}... ({len(key)} characters)")

    net = diagnose_connectivity(endpoint, timeout)
    if not net["ok"]:
        add("network", "fail", f"{net['failed']['step'].upper()}: {net['failed']['detail']}", net["failed"]["hint"])
        return done(2)
    add("network", "pass", f"{', '.join(s['step'].upper() for s in net['steps'])} ok ({net['host']}:{net['port']})")

    info, error = fetch_ingester_compat(endpoint, (), timeout)
    if info is None:
        add("ingester", "fail", f"the server answered but is not an Autter ingester ({error})",
            "Point --endpoint at the ingester's base URL, without /v1/traces.")
        return done()
    issues = evaluate(PYTHON_FEATURES, info)
    add("ingester", "warn" if issues else "pass",
        f"@autter/otlp-ingester@{info.get('version') or '1.4.0 or older'}"
        + (f"; {'; '.join(i['message'] for i in issues)}" if issues else ""))

    storage = check_storage(endpoint, timeout)
    if storage is not None and not storage["ok"]:
        add("storage", "fail", f"ClickHouse {storage['state']}", storage["detail"])
        return done()
    add("storage", "pass" if storage and storage["writeChecked"] else "warn",
        storage["detail"] if storage else "not checked: /healthz did not answer")

    auth = {"authorization": f"Bearer {key}"}
    res = _request("GET", f"{endpoint}/v1/verify", timeout, headers=auth)
    lookup_supported = True
    if res is not None and res[0] == 404:
        lookup_supported = False
        res = _request("POST", f"{endpoint}/v1/traces", timeout, b'{"resourceSpans":[]}', auth)
    if res is None or res[0] >= 300:
        status = res[0] if res else 0
        add("auth", "fail", f"{status}: {_reason(res[2]) or 'refused'}" if res else "no answer", _AUTH_FIX.get(status))
        return done()
    add("auth", "pass", "key accepted")

    resource = {"attributes": [_attr("service.name", service), _attr("deployment.environment", environment),
                               *([_attr("service.version", release)] if release else []),
                               _attr("autter.verify.id", trace_id)]}
    end = time.time_ns()
    span = {"traceId": trace_id, "spanId": os.urandom(8).hex(), "name": "autter verify", "kind": 1,
            "startTimeUnixNano": str(end - 1_000_000), "endTimeUnixNano": str(end),
            "attributes": [_attr("autter.verify", "true")]}
    if lookup_supported:
        span["status"] = {"code": 2, "message": "autter verify test event"}
        span["events"] = [{"name": "exception", "timeUnixNano": str(end), "attributes": [
            _attr("exception.type", "AutterVerifyTestEvent"),
            _attr("exception.message", "Test event from compat.py verify (never opens an issue)"),
            _attr("autter.severity", "info")]}]
    body = json.dumps({"resourceSpans": [{"resource": resource, "scopeSpans": [{"scope": {"name": "autter-verify"}, "spans": [span]}]}]})
    res = _request("POST", f"{endpoint}/v1/traces", timeout, body.encode(), auth)
    if res is None or res[0] >= 300:
        status = res[0] if res else 0
        add("ingest", "fail", f"/v1/traces {status}: {_reason(res[2]) or 'refused'}" if res else "no answer from /v1/traces",
            _AUTH_FIX.get(status))
        return done()
    try:
        partial = json.loads(res[2]).get("partialSuccess") or {}
    except Exception:  # noqa: BLE001
        partial = {}
    if int(partial.get("rejectedSpans") or 0) > 0:
        add("ingest", "fail", f"/v1/traces rejected {partial.get('rejectedSpans')} span(s): {partial.get('errorMessage', '')}")
        return done()
    summary = res[1].get("x-autter-ingest") if res[1] else None
    add("ingest", "pass", f"/v1/traces {res[0]}" + (f": {summary}" if summary else ""))

    if not lookup_supported:
        add("stored", "warn", f"not checked: ingester {info.get('version')} has no /v1/verify (upgrade it to read the event back)")
        return done()

    def lookup() -> Optional[dict]:
        got = _request("GET", f"{endpoint}/v1/verify/{trace_id}", timeout, headers=auth)
        if got is None or got[0] != 200:
            return None
        try:
            return json.loads(got[2]).get("stored")
        except Exception:  # noqa: BLE001
            return None

    started = time.monotonic()
    stored = None
    while True:
        stored = lookup()
        if stored and stored["spans"]["rows"] > 0 and stored["occurrences"]["rows"] > 0:
            break
        if time.monotonic() - started >= wait:
            break
        time.sleep(poll)
    if not stored or stored["spans"]["rows"] == 0 or stored["occurrences"]["rows"] == 0:
        add("stored", "fail", "accepted but not found in storage" if stored else "could not read it back (GET /v1/verify)",
            "Check the ingester's logs for write errors and its /healthz `writes` section.")
        return done()
    add("stored", "pass", f"{stored['spans']['rows']} span and {stored['occurrences']['rows']} error stored after {time.monotonic() - started:.1f} s")
    add("trace", "pass", f"the error is linked to its span by trace id {trace_id}")
    if not release:
        add("release", "warn", "no release set: errors are not tied to a deploy",
            "Set OTEL_RESOURCE_ATTRIBUTES=service.version=<git sha> in the service; run verify with --release.")
    elif release in stored["occurrences"]["releases"]:
        add("release", "pass", f"release {release} stored on the error and the span")
    else:
        add("release", "fail", f"sent release {release}, stored {stored['occurrences']['releases']}",
            "Something between the service and the ingester rewrites resource attributes.")

    if stored.get("logs") is None:
        add("logs", "skip", "not checked: this ingester stores no OTLP logs (needs ingester >= 1.4.0)")
        return done()
    log_body = json.dumps({"resourceLogs": [{"resource": resource, "scopeLogs": [{"scope": {"name": "autter-verify"}, "logRecords": [{
        "timeUnixNano": str(time.time_ns()), "severityNumber": 9, "severityText": "INFO",
        "body": {"stringValue": "autter verify test log record"}, "traceId": trace_id,
        "attributes": [_attr("autter.verify", "true")]}]}]}]})
    res = _request("POST", f"{endpoint}/v1/logs", timeout, log_body.encode(), auth)
    if res is None or res[0] >= 300:
        status = res[0] if res else 0
        add("logs", "fail", f"/v1/logs {status}: {_reason(res[2]) or 'refused'}" if res else "no answer from /v1/logs",
            "This ingester has no /v1/logs: upgrade it." if status == 404 else _AUTH_FIX.get(status))
        return done()
    started = time.monotonic()
    rows = 0
    while True:
        stored = lookup()
        rows = ((stored or {}).get("logs") or {}).get("rows", 0)
        if rows or time.monotonic() - started >= wait:
            break
        time.sleep(poll)
    if rows:
        add("logs", "pass", f"{rows} log record stored")
    else:
        add("logs", "fail", "/v1/logs accepted the record but it was not stored", "Check the ingester's logs for runtime_logs write errors.")
    return done()


_MARK = {"pass": "ok  ", "fail": "FAIL", "warn": "warn", "skip": "--  "}


def _default_endpoint() -> str:
    return (os.environ.get("AUTTER_ENDPOINT") or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or DEFAULT_ENDPOINT)


def main(argv: Optional[list[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="compat.py", description="Autter Runtime setup checks")
    sub = parser.add_subparsers(dest="command", required=True)
    doc = sub.add_parser("doctor", help="versions, storage and the key, in one report")
    doc.add_argument("--endpoint", default=_default_endpoint())
    doc.add_argument("--key", default=None, help="ingest key (default: $AUTTER_RUNTIME_KEY or OTEL_EXPORTER_OTLP_HEADERS)")
    doc.add_argument("--features", default="", help="comma-separated ids: "
                     + ", ".join(f["id"] for f in MANIFEST["features"]))
    doc.add_argument("--json", action="store_true")
    doc.add_argument("--timeout", type=float, default=5.0)
    ver = sub.add_parser("verify", help="send a test event end to end and name the first failing step")
    ver.add_argument("--endpoint", default=_default_endpoint())
    ver.add_argument("--key", default=None, help="ingest key (default: $AUTTER_RUNTIME_KEY or OTEL_EXPORTER_OTLP_HEADERS)")
    ver.add_argument("--service", default=os.environ.get("OTEL_SERVICE_NAME") or os.environ.get("AUTTER_SERVICE") or "autter-verify")
    ver.add_argument("--environment", default="verify")
    ver.add_argument("--release", default=os.environ.get("AUTTER_RELEASE") or os.environ.get("GIT_SHA"))
    ver.add_argument("--wait", type=float, default=20.0, help="seconds to wait for the event to be stored")
    ver.add_argument("--timeout", type=float, default=5.0)
    ver.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    key = args.key or key_from_env()

    if args.command == "verify":
        report, code = verify(args.endpoint, key, args.service, args.environment, args.release, args.wait, args.timeout)
        if args.json:
            print(json.dumps(report, indent=2))
            return code
        print("Autter Runtime verify (Python)")
        print(f"  endpoint   {report['endpoint']}")
        print(f"  service    {report['service']} (environment {report['environment']}, "
              f"{'release ' + report['release'] if report['release'] else 'no release'})")
        print()
        for step in report["steps"]:
            print(f"  {_MARK[step['status']]} {step['step']:<9} {step['detail']}")
            if step["status"] in ("fail", "warn") and step.get("fix"):
                print(f"                 -> {step['fix']}")
        print()
        failure = report["firstFailure"]
        print(f"First failing step: {failure['step']}. {failure.get('fix') or ''}".strip() if failure else
              f'Delivered: a test event from "{report["service"]}" was accepted and stored (environment '
              f'"{report["environment"]}"; it never opens an issue).')
        return code

    features = [f.strip() for f in args.features.split(",") if f.strip()] or None
    report, code = doctor(args.endpoint, features, args.timeout, key)
    if args.json:
        print(json.dumps(report, indent=2))
        return code
    info = report["ingester"]
    print("Autter Runtime doctor (Python)")
    print(f"  endpoint   {report['endpoint']}")
    if info is None:
        print(f"  ingester   unreachable or unidentified ({report['error']})")
    elif info.get("version"):
        print(f"  ingester   @autter/otlp-ingester@{info['version']}")
        if info.get("schema"):
            print(f"  schema     {info['schema']['status']}")
    else:
        print("  ingester   1.4.0 or older (no /v1/compat endpoint; upgrade for a full report)")
    storage = report["storage"]
    if storage:
        print(f"  storage    {'' if storage['ok'] else 'NOT READY: '}{storage['detail']}")
    reason = f" ({report['keyDetail']})" if report.get("keyDetail") else ""
    print("  key        " + {
        "accepted": "accepted",
        "rejected": f"REJECTED (401{reason}): check AUTTER_RUNTIME_KEY / OTEL_EXPORTER_OTLP_HEADERS",
        "client_key": f"refused (403{reason}): Python services need a server key (autter_rt_...)",
        "storage_unavailable": "accepted, but the ingester's ClickHouse is unavailable (503)",
        "unverified": "could not be checked: the ingester's key validator is unavailable (503); exporters retry",
        "unknown": f"could not be verified{reason}",
        "not_checked": "not checked (pass --key or set AUTTER_RUNTIME_KEY)",
    }[report["key"]])
    connectivity = report.get("connectivity")
    if connectivity:
        print("\nConnection")
        for step in connectivity["steps"]:
            print(f"  {'ok  ' if step['ok'] else 'FAIL'} {step['step']:<5} {step['detail']}")
        if connectivity.get("failed"):
            print(f"  -> {connectivity['failed']['hint']}")
    for issue in report["issues"]:
        print(f"  - {issue['message']}")
    if code == 2:
        failed = (connectivity or {}).get("failed")
        print(f"Could not reach the ingester: the {failed['step'].upper()} step failed." if failed else
              "Could not check the ingester. Pass --endpoint <url>.")
    elif code == 1:
        print("Not ready: the ingester cannot store data right now." if storage and not storage["ok"] else
              "Not ready: the key was not accepted." if report["key"] not in ("accepted", "not_checked") and not report["issues"] else
              "Incompatible: see the problems above.")
    elif report["key"] == "not_checked":
        print("Versions compatible and storage ready. Key not checked: pass --key, or run `compat.py verify`.")
    else:
        print("Ready: versions compatible, storage ready, key accepted.")
    return code


if __name__ == "__main__":
    sys.exit(main())
