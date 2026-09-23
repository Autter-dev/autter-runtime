"""Optional diagnostic exception sampler for Python services.

The hook sees every Python exception event, including deliberately handled
ones. It has substantial overhead and must be explicitly enabled. Pass an
``emit(name, stack)`` callback that records a standard OTel exception event
with ``autter.handled=true`` and ``autter.sampled=true`` on an always-on span.
"""

from __future__ import annotations

import random
import re
import sys
import threading
import time
import traceback
from collections.abc import Callable


def install_caught_sampler(
    emit: Callable[[str, str], None], *, sample_rate: float = 0.01, max_per_minute: int = 10
) -> Callable[[], None]:
    if not 0 <= sample_rate <= 1 or max_per_minute < 1:
        raise ValueError("invalid caught exception sampling limits")
    previous = sys.gettrace()
    previous_threads = threading.gettrace()
    seen: set[int] = set()
    window = -1
    sent = 0
    enabled = True

    def hook(frame, event, arg):
        nonlocal window, sent
        if not enabled or event != "exception":
            return hook
        exc_type, exc_value, tb = arg
        current = int(time.monotonic() // 60)
        if current != window:
            window, sent = current, 0
            seen.clear()
        identity = id(exc_value)
        if identity in seen or sent >= max_per_minute or random.random() >= sample_rate:
            return hook
        seen.add(identity)
        sent += 1
        stack = "".join(traceback.format_exception(exc_type, exc_value, tb, limit=8))[:8000]
        stack = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[redacted]", stack, flags=re.I)
        try:
            emit(exc_type.__name__, stack)
        except Exception:
            pass  # Diagnostics must not change application behavior.
        return hook

    sys.settrace(hook)
    threading.settrace(hook)

    def stop() -> None:
        nonlocal enabled
        enabled = False
        sys.settrace(previous)
        threading.settrace(previous_threads)

    return stop
