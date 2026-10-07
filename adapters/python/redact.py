"""Secret/PII scrubbing for Python services reporting to Autter Runtime.

Python exceptions routinely carry secrets in their *message* (``str(exc)``)
and therefore in every formatted traceback: ``psycopg2.OperationalError:
connection to postgres://admin:hunter2@db failed``, ``401 Incorrect API key
provided: sk-...``. Scrub before anything leaves the process:

    from redact import redact_text, redact_attributes

    span.add_event("exception", {
        "exception.type": type(exc).__name__,
        "exception.message": redact_text(str(exc)),
        "exception.stacktrace": redact_text("".join(traceback.format_exception(exc))),
    })
    span.set_attributes(redact_attributes(custom_context))

Same patterns as ``redactText``/``redactAttributes`` in @autter/runtime-node;
parity is enforced by the shared ``test-vectors/redaction.json``. Secure by
default; extend with :func:`configure` (your own value/key patterns). The
Autter ingester scrubs again server-side as a second line of defence.

Stdlib only.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

MASK = "[redacted]"

_PRIVATE_KEY_BLOCK = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"
)
_PREFIXED_SECRET = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}"
    r"|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}"
    r"|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}"
    r"|npm_[A-Za-z0-9]{36}|autter_(?:rt|pat)_[A-Za-z0-9_-]{10,}"
    r"|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})"
)
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
_AUTH_SCHEME = re.compile(
    r"\b(?:bearer\s+[A-Za-z0-9._~+/=-]{10,}"
    r"|basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2})",
    re.I,
)
_HEADER_VALUE = re.compile(
    r"((?:^|[^\w-])(?:proxy-)?(?:authorization|(?:set-)?cookie)[\"']?\s*[:=]\s*[\"']?)[^\"'\r\n]+",
    re.I | re.M,
)
_SECRET_ASSIGNMENT = re.compile(
    r"(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key"
    r"|credential|signature|session[_-]?id|sessionid|ssn)"
    r"([\"']?\s*[:=]\s*)"
    r"(\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s\"'&,;)}\]\[<>]+)",
    re.I,
)
_URL_CREDENTIALS = re.compile(
    r"\b([a-z][a-z0-9+.-]{0,31}://)(?:[^\s/:@\"'<>]*:[^\s/\"'<>]*|[^\s/:@\"'<>]{16,})@", re.I
)
_CARD = re.compile(
    r"\b(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))(?:[ -]?\d){9,15}\b"
)
_EMAIL = re.compile(r"[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}", re.I)

_SENSITIVE_KEYS = [
    re.compile(p)
    for p in (
        r"e-?mail",
        r"pass(word|wd|phrase)|^pass$|(^|[._-])pwd$",
        r"token",
        r"secret",
        r"credential",
        r"(api|access|secret|private|consumer|client|signing|encryption)-?[_.]?key",
        r"authori[sz]ation|^auth(-|_|$)|bearer",
        r"cookie",
        r"(^|[._-])session$|^(j|php)?sess(ion)?id$|^sid$|connect\.sid",
        r"phone|msisdn",
        r"(^|[^a-z])ssn($|[^a-z])|social[-_ ]?security",
        r"cvv|cvc|card([-_. ]?(number|num|no))?$",
        r"credit[-_.]?card",
        r"connection[-_.]?string|(^|[._-])dsn$",
        r"recovery[-_.]?code|\botp\b|magic[-_.]?link",
    )
]
# Numeric GenAI usage counters keep their value even though "token" matches.
_USAGE_KEY = re.compile(r"(^|\.)(input|output|total|prompt|completion)_?tokens$|token_count$", re.I)

_extra_values: list[re.Pattern[str]] = []
_extra_keys: list[re.Pattern[str]] = []
_enabled = True

_MAX_DEPTH = 8
_MAX_ITEMS = 1000


def configure(
    *,
    value_patterns: Iterable[str | re.Pattern[str]] = (),
    key_patterns: Iterable[str | re.Pattern[str]] = (),
    enabled: bool = True,
) -> None:
    """Add your own patterns on top of the built-ins (replaces earlier extras).

    ``value_patterns`` are masked wherever they occur inside strings;
    ``key_patterns`` mask whole values whose key matches (case-insensitive).
    ``enabled=False`` turns scrubbing off (not recommended).
    """
    global _extra_values, _extra_keys, _enabled
    _extra_values = [p if isinstance(p, re.Pattern) else re.compile(p, re.I) for p in value_patterns]
    _extra_keys = [p if isinstance(p, re.Pattern) else re.compile(p, re.I) for p in key_patterns]
    _enabled = enabled


def _luhn_valid(candidate: str) -> bool:
    digits = [int(c) for c in candidate if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _mask_assignment(match: re.Match[str]) -> str:
    key, sep, value = match.group(1), match.group(2), match.group(3)
    if value[:1] in ("'", '"'):
        return f"{key}{sep}{value[0]}{MASK}{value[0]}"
    return f"{key}{sep}{MASK}"


def redact_text(value: str) -> str:
    """Scrub secrets/PII embedded in one string; the rest survives."""
    if not _enabled or not isinstance(value, str) or not value:
        return value
    out = _PRIVATE_KEY_BLOCK.sub(MASK, value)
    out = _PREFIXED_SECRET.sub(MASK, out)
    out = _JWT.sub(MASK, out)
    out = _AUTH_SCHEME.sub(MASK, out)
    out = _HEADER_VALUE.sub(lambda m: m.group(1) + MASK, out)
    out = _SECRET_ASSIGNMENT.sub(_mask_assignment, out)
    out = _URL_CREDENTIALS.sub(lambda m: m.group(1) + MASK + "@", out)
    out = _CARD.sub(lambda m: MASK if _luhn_valid(m.group(0)) else m.group(0), out)
    out = _EMAIL.sub(MASK, out)
    for pattern in _extra_values:
        out = pattern.sub(MASK, out)
    return out


def is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(p.search(lowered) for p in _SENSITIVE_KEYS) or any(p.search(key) for p in _extra_keys)


def _redact_value(key: str, value: Any, depth: int) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        if _USAGE_KEY.search(key) and value >= 0:
            return value
        return MASK if is_sensitive_key(key) else value
    if is_sensitive_key(key):
        return MASK
    if isinstance(value, str):
        return redact_text(value)
    if depth >= _MAX_DEPTH:
        return MASK
    if isinstance(value, Mapping):
        return _redact_mapping(value, depth + 1)
    if isinstance(value, (list, tuple)):
        return [_redact_value("", item, depth + 1) for item in list(value)[:_MAX_ITEMS]]
    return redact_text(str(value))


def _redact_mapping(mapping: Mapping[Any, Any], depth: int) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for i, (key, value) in enumerate(mapping.items()):
        if i >= _MAX_ITEMS:
            out["__redaction_truncated__"] = MASK
            break
        out[str(key)] = _redact_value(str(key), value, depth)
    return out


def redact_attributes(attributes: Mapping[str, Any] | None) -> dict[str, Any]:
    """Copy of ``attributes`` with sensitive keys masked (any depth) and
    secrets scrubbed inside string values. Never mutates the input."""
    if not attributes:
        return {}
    if not _enabled:
        return dict(attributes)
    return _redact_mapping(attributes, 0)
