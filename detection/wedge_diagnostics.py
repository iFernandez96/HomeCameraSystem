"""Pure parsers for bounded camera-wedge diagnostic probes.

Kept separate from ``detect.py`` so probe output handling is testable without
importing the Jetson SDK. This module must remain Python 3.6 compatible.
"""
import re


def parse_nvargus_rss_kb(text):
    """Return the largest RSS value in ``ps -o pid=,rss=,...`` output."""
    best = 0.0
    for line in text.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) < 2:
            continue
        try:
            rss = float(parts[1])
        except (TypeError, ValueError):
            continue
        best = max(best, rss)
    return best


def parse_free_available_mb(text):
    """Return the ``available`` column from ``free -m`` output."""
    for line in text.splitlines():
        if not line.startswith("Mem:"):
            continue
        parts = line.split()
        if len(parts) >= 7:
            try:
                return float(parts[6])
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def count_argus_pending(text):
    """Count known libargus pending/overflow signatures in kernel output."""
    if not text:
        return 0.0
    return float(len(re.findall(
        r"(Argus OverFlow|too many pending events)",
        text,
        flags=re.IGNORECASE,
    )))
