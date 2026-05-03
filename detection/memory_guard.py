"""Decide when to pause inference because the host is low on memory.

Background:
    The Jetson Nano 2GB sits at 1.4-1.7 GB used in steady state with
    mediamtx, the Docker server, and the detection worker all running.
    Headroom is thin. A burst of memory pressure (npm/pip in a side
    shell, a long-running snapshot copy, a garbage-collected language
    runtime allocating) can push us into the swap death spiral or the
    OOM killer reaching for `python3 detect.py`.

    This guard reads `/proc/meminfo` periodically and signals the
    detection loop to skip `net.Detect()` when MemAvailable drops below
    a threshold. Capturing frames continues so the RTSP pipeline
    doesn't back up, but inference (the dominant CUDA / CPU consumer)
    pauses until headroom recovers. Hysteresis avoids flapping when
    free memory wobbles right at the line.

Must stay Python 3.6 compatible — host runs JetPack 4.x. No
`from __future__ import annotations`, no PEP-604 unions, no walrus.
"""
import logging

log = logging.getLogger(__name__)

_MEMINFO = "/proc/meminfo"


def read_mem_available_mb():
    """Returns MemAvailable in MB, or None when /proc/meminfo isn't
    readable (e.g. running on macOS for tests)."""
    try:
        with open(_MEMINFO) as f:
            for line in f:
                key, _, rest = line.partition(":")
                if key != "MemAvailable":
                    continue
                value_kb = int(rest.strip().split()[0])
                return value_kb // 1024
    except (OSError, ValueError):
        return None
    return None


class MemoryGuard:
    """Hysteretic memory-pressure gate.

    Args:
        low_mb: enter low-memory mode when MemAvailable falls below this.
        recover_mb: leave low-memory mode only once MemAvailable has
            climbed back to at least this. Must be >= low_mb so the
            guard doesn't oscillate at the threshold.
        check_every: how often the calling loop should call `step()`.
            The guard itself doesn't sleep — it just expects the caller
            to throttle calls (e.g. once every 30 frames).

    The gate is sticky: once `low=True`, it remains low until a
    `step()` call sees `mem_avail >= recover_mb`. This means that even
    if the loop checks rapidly during recovery, we won't bounce out and
    immediately back in.
    """

    def __init__(self, low_mb=80, recover_mb=150, check_every=30):
        if recover_mb < low_mb:
            raise ValueError("recover_mb must be >= low_mb to prevent flapping")
        self.low_mb = low_mb
        self.recover_mb = recover_mb
        self.check_every = check_every
        self.low = False
        self.last_mem_avail_mb = None

    def step(self, mem_avail_mb):
        """Update internal state given a fresh reading. Returns the
        current `low` flag for convenience. Pass `None` (e.g. when
        /proc/meminfo wasn't readable) and the guard simply doesn't
        change state — fail-open: if we can't measure memory, don't
        spuriously pause inference."""
        if mem_avail_mb is None:
            return self.low
        self.last_mem_avail_mb = mem_avail_mb
        if self.low:
            if mem_avail_mb >= self.recover_mb:
                log.warning(
                    "memory_guard: recovered (%d MB available, threshold %d)",
                    mem_avail_mb, self.recover_mb,
                )
                self.low = False
        else:
            if mem_avail_mb < self.low_mb:
                log.warning(
                    "memory_guard: entering low-memory mode (%d MB available, threshold %d)",
                    mem_avail_mb, self.low_mb,
                )
                self.low = True
        return self.low
