"""Decide when to kick MediaMTX on persistent capture failure.

Background — what this guards against:
    The encoder pipeline lives in MediaMTX's `runOnInit` GStreamer
    `gst-launch-1.0 nvarguscamerasrc ! ... ! rtspclientsink`. We've seen
    this pipeline stay alive in the cgroup (so systemd thinks mediamtx is
    healthy) while no longer producing frames — libargus hangs, or
    NvMMLite hits an internal block error, or the H.264 encoder gets
    stuck. Detection then sees nothing but Capture() timeouts.

    The detection worker has its own systemd-restart trigger (100
    consecutive failures → exit(1) → systemd restart), but that only
    cycles detect.py — and detect immediately reconnects to the same
    dead RTSP path and times out again. The fix has to restart mediamtx,
    not detect.

How this works:
    The watchdog tallies consecutive `Capture()` failures and, once a
    failure threshold trips AND we're past a cooldown window since the
    previous restart attempt, signals "kick mediamtx now." After a
    successful capture the failure tally resets. If we're past the
    cooldown but failures keep accumulating, the watchdog signals again.

    Pure stdlib so the module is unit-testable without jetson_inference
    or any host-only dependency.

    Must stay Python-3.6-compatible — JetPack 4.x ships 3.6 on the host
    where detect.py imports this module. Don't add `from __future__
    import annotations` or PEP-604 unions.
"""
import logging

log = logging.getLogger(__name__)


class MediaMtxWatchdog:
    """Decide whether to restart mediamtx after a burst of capture failures.

    Args:
        fail_threshold: consecutive failures that must accumulate before
            the watchdog fires. At ~2 s per Capture() timeout, the
            default 30 means roughly a 60 s observation window.
        cooldown_s: minimum gap between restart signals, so a single bad
            burst only kicks mediamtx once even if recovery takes a few
            seconds.
    """

    def __init__(self, fail_threshold: int = 30, cooldown_s: float = 60.0):
        self.fail_threshold = fail_threshold
        self.cooldown_s = cooldown_s
        self.failures = 0
        # `-inf` so the first restart is never blocked by the cooldown
        # check — any real wall-clock `now` is ≥ -inf + cooldown_s.
        self.last_restart_at = float("-inf")
        self.restart_count = 0

    def on_capture_ok(self) -> None:
        """Reset the failure tally — RTSP is alive again."""
        self.failures = 0

    def on_capture_fail(self) -> None:
        """Bump the consecutive-failure tally."""
        self.failures += 1

    def should_restart(self, now: float) -> bool:
        """True iff failures have reached the threshold AND we're past
        the cooldown window since the last restart signal. The caller is
        responsible for actually performing the restart and then calling
        `mark_restarted(now)` so the watchdog can enter cooldown."""
        if self.failures < self.fail_threshold:
            return False
        return (now - self.last_restart_at) >= self.cooldown_s

    def mark_restarted(self, now: float) -> None:
        """Record that mediamtx was kicked at `now`.

        iter-300 (camera-library/algorithm auditor convergent #1):
        Pre-iter-300 this also reset `self.failures = 0`. That created
        a 60 s "blind window" if the kick didn't recover the stream:
        failures had to re-accumulate to the 30-fail threshold AFTER
        the cooldown expired before a second kick could fire — total
        downtime 120 s per failed-recovery cycle.

        Now we only record the timestamp + bump the count. The
        cooldown gate in `should_restart` still prevents back-to-back
        re-fires inside the cooldown window. The `on_capture_ok` path
        is the only legitimate place to clear the failure tally —
        and that fires on a real frame, which is the actual signal of
        recovery."""
        self.last_restart_at = now
        self.restart_count += 1
