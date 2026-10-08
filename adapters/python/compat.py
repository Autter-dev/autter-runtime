"""Version compatibility check for Python services sending to Autter Runtime.

Plain OpenTelemetry SDKs talk to the Autter ingester directly, so nothing in
the SDK knows whether the ingester can store what it sends (OTLP logs need
ingester >= 1.4.0, memory metrics >= 1.3.3, ...). This module asks once:

* ``warn_if_incompatible(endpoint, ["operation_logging"])`` - fire-and-forget
  background check at startup; logs ONE warning per incompatible feature on
  the ``autter.runtime`` logger, naming both versions and the fix. Never
  raises, never blocks (daemon thread). Disabled by ``AUTTER_COMPAT_CHECK=0``.
* ``python3 compat.py doctor --endpoint https://ingest.example.com`` - one-shot
  report; exit 0 compatible, 1 mismatch, 2 ingester unreachable.

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


def _request(method: str, url: str, timeout: float, body: Optional[bytes] = None):
    """(status, headers, text) or None on any failure."""
    req = urllib.request.Request(url, data=body, method=method, headers={
        "accept": "application/json", "user-agent": "autter-runtime-python-compat",
        **({"content-type": "application/json"} if body is not None else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - user-configured endpoint
            return res.status, res.headers, res.read(256 * 1024).decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.headers, ""
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


def doctor(endpoint: str, features: Optional[list[str]] = None, timeout: float = 5.0) -> tuple[dict, int]:
    """One-shot report and exit code (0 ok, 1 mismatch, 2 unreachable)."""
    # What a Python service sends over plain OTLP: traces (LLM spans),
    # metrics (latency histograms, process memory) and logs.
    features = features or list(PYTHON_FEATURES)
    info, error = fetch_ingester_compat(endpoint, _routes_for(features), timeout)
    issues = evaluate(features, info)
    report = {"endpoint": endpoint.rstrip("/"), "ingester": info, "error": error, "features": features, "issues": issues}
    return report, 2 if info is None else 1 if issues else 0


def main(argv: Optional[list[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="compat.py", description="Autter Runtime version compatibility check")
    sub = parser.add_subparsers(dest="command", required=True)
    doc = sub.add_parser("doctor", help="check the ingester against the features you use")
    doc.add_argument("--endpoint", default=os.environ.get("AUTTER_ENDPOINT")
                     or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or DEFAULT_ENDPOINT)
    doc.add_argument("--features", default="", help="comma-separated ids: "
                     + ", ".join(f["id"] for f in MANIFEST["features"]))
    doc.add_argument("--json", action="store_true")
    doc.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args(argv)
    features = [f.strip() for f in args.features.split(",") if f.strip()] or None
    report, code = doctor(args.endpoint, features, args.timeout)
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
    for issue in report["issues"]:
        print(f"  - {issue['message']}")
    print({0: "Compatible.", 1: "Incompatible: see the problems above.",
           2: "Could not check the ingester. Pass --endpoint <url>."}[code])
    return code


if __name__ == "__main__":
    sys.exit(main())
