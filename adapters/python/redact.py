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

Identifying attributes (the client's IP address and port, the raw user
agent, the host's id and addresses, the command line and its owner:
:data:`IDENTIFYING_ATTRIBUTE_KEYS`) are dropped rather than scrubbed:
:func:`drop_identifying_attributes`. ``autter_tracing.RedactingSpanExporter``
applies it to every span, also with redaction off. Opt in to a keyed hash of
the client's address instead (``client.address_hash``): :func:`hash_client_ip`.

Stdlib only.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
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
# Lookbehind, not \b: a \b start at every "eyJ" after "-" is quadratic.
_JWT = re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
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
        r"cvv|cvc|(^|[^a-z])card([-_. ]?(number|num|no))?$",
        r"credit[-_.]?card",
        r"connection[-_.]?string|(^|[._-])dsn$",
        r"recovery[-_.]?code|\botp\b|magic[-_.]?link",
    )
]
# Numeric GenAI usage counters keep their value even though "token" matches:
# input/output/total counts, the cache and reasoning subsets (Autter's
# "total" usage contract, OTel GenAI semconv, OpenLLMetry spellings such as
# gen_ai.usage.cache_read_input_tokens), OpenInference llm.token_count.* and
# Vercel AI SDK ai.usage.*Tokens.
_USAGE_KEY = re.compile(
    r"(^|[._])(input|output|total|prompt|completion|cached|cache_read|cache_creation|cache_write"
    r"|reasoning|thinking|long_ttl)_?tokens$"
    r"|token_count$"
    r"|^llm\.token_count\.[a-z_]+(\.[a-z_]+)?$"
    r"|^ai\.usage\.[a-z]*tokens$",
    re.I,
)

#: Attributes that identify a person, a machine or a command line rather than
#: describe a request. Dropped by default from span, event and link
#: attributes and the resource (same list as @autter/runtime-node and the
#: ingester; parity: ``test-vectors/redaction.json``, ``identifying``).
#: Kept on purpose: ``service.instance.id``, ``host.name`` (container and pod
#: names; drop it with ``drop_attributes``), ``process.pid``,
#: ``process.runtime.*``, ``os.type``, ``host.arch``.
IDENTIFYING_ATTRIBUTE_KEYS: tuple[str, ...] = (
    # The client's address (and, on outgoing calls, the peer's), in the old,
    # 1.2x and stable semantic conventions; the server's own IP address.
    "net.peer.ip",
    "net.peer.port",
    "net.sock.peer.addr",
    "net.sock.peer.port",
    "net.host.ip",
    "net.sock.host.addr",
    "network.local.address",
    "http.client_ip",
    "client.address",
    "client.port",
    "network.peer.address",
    "network.peer.port",
    # The raw user-agent string.
    "http.user_agent",
    "user_agent.original",
    # The machine (its id and addresses; host.name is kept).
    "host.id",
    "host.mac",
    "host.ip",
    # The command line and the user running it.
    "process.command_args",
    "process.command",
    "process.command_line",
    "process.owner",
    "process.executable.path",
)

KEEP_IDENTIFYING_ATTRIBUTES_ENV = "AUTTER_KEEP_IDENTIFYING_ATTRIBUTES"
DROP_ATTRIBUTES_ENV = "AUTTER_DROP_ATTRIBUTES"

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
    try:
        text = str(value)
    except Exception:  # a broken __str__ must not break the caller
        return MASK
    return redact_text(text)


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


def keep_identifying_from_env(raw: str | None) -> bool | list[str] | None:
    """Parse ``AUTTER_KEEP_IDENTIFYING_ATTRIBUTES``: ``true``/``1``/``yes``/
    ``on``/``all`` keep every identifying attribute, ``false``/``0``/``no``/
    ``off``/``none`` keep none, anything else is a comma-separated list of
    keys. Unset or blank: ``None`` (drop them all)."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "on", "all"):
        return True
    if value in ("0", "false", "no", "off", "none"):
        return False
    return [key.strip() for key in raw.split(",") if key.strip()]


def drop_attributes_from_env(raw: str | None) -> list[str] | None:
    """Parse ``AUTTER_DROP_ATTRIBUTES``: a comma-separated list of keys."""
    if not isinstance(raw, str):
        return None
    keys = [key.strip() for key in raw.split(",") if key.strip()]
    return keys or None


def identifying_keys_to_drop(
    keep: bool | Iterable[str] | None = None, extra: Iterable[str] | None = None
) -> frozenset[str]:
    """The keys to drop: :data:`IDENTIFYING_ATTRIBUTE_KEYS` minus ``keep``
    (``True`` keeps them all, a list keeps those keys), plus ``extra`` (a key
    both kept and in ``extra`` is dropped)."""
    if keep is True:
        kept: set[str] = set(IDENTIFYING_ATTRIBUTE_KEYS)
    elif keep is None or keep is False or isinstance(keep, str):
        kept = set()
    else:
        kept = {key for key in keep if isinstance(key, str)}
    dropped = {key for key in IDENTIFYING_ATTRIBUTE_KEYS if key not in kept}
    if extra is not None and not isinstance(extra, str):
        dropped.update(key for key in extra if isinstance(key, str) and key)
    return frozenset(dropped)


_DEFAULT_DROPPED = identifying_keys_to_drop()


def drop_identifying_attributes(attributes: Any, dropped: frozenset[str] | None = None) -> Any:
    """``attributes`` without the identifying keys (``dropped``, default
    :func:`identifying_keys_to_drop`). The same object when none is present;
    otherwise a ``dict`` copy. Never mutates its input. Applies whether or
    not redaction is enabled."""
    keys = _DEFAULT_DROPPED if dropped is None else dropped
    if not attributes or not keys:
        return attributes
    if not any(key in keys for key in attributes):
        return attributes
    return {key: value for key, value in attributes.items() if key not in keys}


#: Opt-in hashed client IP: the attribute, its length in hex characters, the
#: shortest salt accepted and the environment variables. Same values as
#: @autter/runtime-node and the ingester (``test-vectors/redaction.json``,
#: ``clientIpHash``).
CLIENT_IP_HASH_ATTRIBUTE = "client.address_hash"
CLIENT_IP_HASH_LENGTH = 32
CLIENT_IP_SALT_MIN_LENGTH = 16
HASH_CLIENT_IP_ENV = "AUTTER_HASH_CLIENT_IP"
CLIENT_IP_SALT_ENV = "AUTTER_CLIENT_IP_SALT"

#: Where the client address is read from, first valid wins: ``client.address``
#: and ``http.client_ip`` (from ``X-Forwarded-For`` behind a proxy), then the
#: socket peer, on server spans only (behind a proxy it is the proxy; on a
#: client span it is the server being called).
CLIENT_IP_SOURCE_KEYS = ("client.address", "http.client_ip", "net.peer.ip", "network.peer.address", "net.sock.peer.addr")
CLIENT_IP_CLIENT_KEYS = ("client.address", "http.client_ip")

_IPV4_PORT = re.compile(r"^[\d.]+:\d{1,5}$")
_BRACKETED = re.compile(r"^\[([^\]]+)\](?::\d{1,5})?$")
_IPV4 = re.compile(r"^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$")
_IPV6_CHARS = re.compile(r"^[0-9a-f:.]+$")


def normalize_client_ip(raw: Any) -> str | None:
    """The canonical text of an IP address, or ``None`` when ``raw`` is not
    one: the first entry of a comma-separated list, port and brackets
    removed, zone id removed, IPv6 lower-cased and compressed (RFC 5952),
    IPv4-mapped IPv6 turned into IPv4."""
    if not isinstance(raw, str):
        return None
    value = raw.split(",")[0].strip()
    if not value or len(value) > 100:
        return None
    bracketed = _BRACKETED.match(value)
    if bracketed:
        value = bracketed.group(1)
    elif _IPV4_PORT.match(value):
        value = value[: value.rindex(":")]
    if "%" in value:
        value = value[: value.index("%")]
    value = value.lower()
    if _IPV4.match(value):
        return value
    if ":" not in value or not _IPV6_CHARS.match(value):
        return None
    try:
        address = ipaddress.IPv6Address(value)
    except ValueError:
        return None
    if address.ipv4_mapped is not None:
        return str(address.ipv4_mapped)
    return address.compressed


def client_ip_of(attributes: Mapping[str, Any] | None, server_span: bool) -> str | None:
    """The normalised client address of a span or log record: the first
    :data:`CLIENT_IP_SOURCE_KEYS` entry holding a valid IP (the peer keys
    only when ``server_span``)."""
    if not attributes:
        return None
    for key in CLIENT_IP_SOURCE_KEYS if server_span else CLIENT_IP_CLIENT_KEYS:
        ip = normalize_client_ip(attributes.get(key))
        if ip:
            return ip
    return None


def usable_client_ip_salt(salt: Any) -> str | None:
    """``salt`` when it is a string of at least :data:`CLIENT_IP_SALT_MIN_LENGTH` characters."""
    return salt if isinstance(salt, str) and len(salt) >= CLIENT_IP_SALT_MIN_LENGTH else None


def hash_client_ip(salt: str, ip: str) -> str:
    """HMAC-SHA256(salt, ip) as hex, first :data:`CLIENT_IP_HASH_LENGTH`
    characters. ``ip`` is normalised (:func:`normalize_client_ip`). Never
    call it without a secret salt: the IPv4 space can be hashed in full."""
    return hmac.new(salt.encode("utf-8"), ip.encode("utf-8"), hashlib.sha256).hexdigest()[:CLIENT_IP_HASH_LENGTH]
