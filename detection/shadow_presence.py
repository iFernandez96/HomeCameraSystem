"""Crash-isolated shadow runner for the presence emit gate.

This module is intentionally small and Python 3.6-compatible. It lets the
worker run a second ``PresenceTracker`` beside the active one, ledger its
transition decisions with ``shadow=true``, and discard the result.
"""
import time


class ShadowPresenceRunner(object):
    """Best-effort shadow wrapper around a PresenceTracker-like object."""

    def __init__(self, tracker, ledger_append, warn, enabled=False,
                 iou_threshold=None, max_keys=None, clip_duration_s=None,
                 presence_gap_s=None, min_gap_s=None, clock=None,
                 warn_interval_s=60.0):
        self.tracker = tracker
        self.ledger_append = ledger_append
        self.warn = warn
        self.enabled = bool(enabled)
        self.iou_threshold = iou_threshold
        self.max_keys = max_keys
        self.clip_duration_s = clip_duration_s
        self.presence_gap_s = presence_gap_s
        self.min_gap_s = min_gap_s
        self.clock = clock if clock is not None else time.time
        self.warn_interval_s = warn_interval_s
        self.errors = 0
        self._last_warn_at = None

    def observe(self, key, box, now, clip_duration_s, presence_gap_s,
                min_gap_s):
        """Feed the shadow tracker and ledger its transition, if any.

        Returns True when a shadow call ran cleanly, False when disabled or
        swallowed. The return value is for tests/metrics only; callers must not
        use it for active emit decisions.
        """
        if not self.enabled:
            return False
        use_clip_duration_s = self._override(self.clip_duration_s,
                                             clip_duration_s)
        use_presence_gap_s = self._override(self.presence_gap_s,
                                            presence_gap_s)
        use_min_gap_s = self._override(self.min_gap_s, min_gap_s)
        try:
            emit, decision = self.tracker.should_emit_with_decision(
                key, box, now, use_clip_duration_s,
                use_presence_gap_s, use_min_gap_s,
            )
            if decision.get("ledger"):
                self.ledger_append("presence", {
                    "transition": decision.get("transition"),
                    "key": key,
                    "reason": decision.get("reason"),
                    "iou": decision.get("iou"),
                    "emit": bool(emit),
                    "shadow": True,
                })
            return True
        except Exception as e:
            self.errors += 1
            self._warn_once_per_interval(e)
        return False

    def _override(self, value, fallback):
        if value is None:
            return fallback
        return value

    def _warn_once_per_interval(self, err):
        now = self.clock()
        if (
            self._last_warn_at is not None
            and (now - self._last_warn_at) < self.warn_interval_s
        ):
            return
        self._last_warn_at = now
        self.warn(
            "shadow presence failed (errors={}): {}: {}".format(
                self.errors, type(err).__name__, err,
            )
        )
