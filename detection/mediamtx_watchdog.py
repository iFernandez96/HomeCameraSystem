"""Decide HOW to recover when the camera feed wedges — an escalating,
persistent ladder, not a flat "kick mediamtx".

Background — what this guards against:
    The encoder pipeline lives in MediaMTX's `runOnInit` GStreamer
    `gst-launch-1.0 nvarguscamerasrc ! ... ! rtspclientsink`. We've seen this
    pipeline stay alive in the cgroup (so systemd thinks mediamtx is healthy)
    while no longer producing frames — libargus hangs with "Failed to create
    CaptureSession", or the H.264 encoder gets stuck. Detection then sees
    nothing but Capture() failures.

Why the OLD design failed (root-caused 2026-06-20):
    The previous watchdog kicked mediamtx, and only escalated to a
    nvargus-daemon restart after `restart_count >= 2`. But `restart_count`
    was IN-MEMORY. When the camera is fully wedged, Capture() fails FAST (not
    2 s timeouts), so the worker hits its 100-failure SystemExit in ~60-75 s
    → systemd restarts the worker → a FRESH watchdog with restart_count=0.
    With a 60 s cooldown the worker only ever did ~1 mediamtx kick per life,
    so restart_count never reached 2 and the nvargus escalation was
    UNREACHABLE. Result: an 80x mediamtx restart flap that never cleared the
    Argus wedge (a deep-research-confirmed fact: only a nvargus-daemon restart
    clears it).

How this works now:
    The watchdog walks an escalation LADDER — restart mediamtx (cheap, fixes a
    transient encoder stall) → restart nvargus-daemon (the only thing that
    clears the libargus wedge) → reboot (last resort). Each rung fires once
    per cooldown window. The `level` (ladder index) and `last_action_at` are
    PERSISTED by the caller across worker restarts (see detect.py), so the
    ladder keeps climbing even though the worker is being recycled by systemd —
    the fix for the unreachable-escalation bug above. A real frame
    (`on_capture_ok`) means recovery → de-escalate to the bottom rung.

    Pure stdlib + no I/O so the decision logic is unit-testable without
    jetson_inference or any host-only dependency; the caller owns persistence
    and the actual subprocess side-effects.

    Must stay Python-3.6-compatible — JetPack 4.x ships 3.6 on the host where
    detect.py imports this module. No `from __future__ import annotations`,
    PEP-604 unions, f-strings in a way that matters, walrus, or match.
"""
import logging
import math
import time

log = logging.getLogger(__name__)


# Escalation actions returned by `next_action`. The caller maps each to a
# concrete side-effect (systemctl restart ... / reboot).
ACTION_RESTART_MEDIAMTX = "restart_mediamtx"
ACTION_RESTART_NVARGUS = "restart_nvargus"
ACTION_REBOOT = "reboot"

# Default ladder: try the cheap pipeline restart twice (handles a transient
# encoder/pipeline stall), then the Argus-clearing nvargus-daemon restart
# twice (deep-research-confirmed as the only thing that clears "Failed to
# create CaptureSession"), then a reboot as the last resort. Climbing one rung
# per cooldown, with state persisted across worker restarts, nvargus is reached
# in ~3 cooldowns (~3 min) and reboot only after that all failed.
_DEFAULT_LADDER = (
    ACTION_RESTART_MEDIAMTX,
    ACTION_RESTART_MEDIAMTX,
    ACTION_RESTART_NVARGUS,
    ACTION_RESTART_NVARGUS,
    ACTION_REBOOT,
)

# Per-action dwell BEFORE escalating to the next rung (2026-07-09 fix),
# expressed as MULTIPLES of `cooldown_s` so it scales with the configured base.
# The cooldown that gates the next escalation is governed by the action we LAST
# fired, because different remedies need different time to actually take
# effect: a cheap mediamtx restart recovers in seconds, but a nvargus-daemon
# restart re-negotiates the whole libargus/camera session and needs ~90 s to
# bring frames back. Live finding: with a flat 60 s cooldown the ladder
# escalated again while a nvargus restart was still recovering, over-running
# straight to the reboot rung instead of letting nvargus succeed. Giving the
# nvargus rungs a long dwell (2.5x = 150 s at the default 60 s base) lets
# `on_capture_ok` de-escalate first, so reboot stays a genuine last resort.
# Actions not listed fall back to a 1.0x (`cooldown_s`) dwell.
_DEFAULT_ACTION_COOLDOWN_MULT = {
    ACTION_RESTART_MEDIAMTX: 0.75,
    ACTION_RESTART_NVARGUS: 2.5,
    ACTION_REBOOT: 2.5,
}


class MediaMtxWatchdog:
    """Escalating recovery decision-maker for a wedged camera feed.

    Args:
        fail_threshold: consecutive Capture() failures before a rung may fire
            (a debounce so a single dropped frame doesn't act).
        cooldown_s: minimum gap between actions, so a wedged subsystem is never
            hammered — and the escalation paces ~one rung per cooldown.
        ladder: the escalation sequence (defaults to `_DEFAULT_LADDER`).
        allow_reboot: when False, the reboot rung degrades to a nvargus restart
            (operator opt-out of the nuclear option).
    """

    def __init__(self, fail_threshold=30, cooldown_s=60.0, ladder=None,
                 allow_reboot=True, action_cooldowns=None):
        self.fail_threshold = fail_threshold
        self.cooldown_s = cooldown_s
        self.ladder = tuple(ladder) if ladder is not None else _DEFAULT_LADDER
        self.allow_reboot = allow_reboot
        # Per-action dwell before the NEXT rung; falls back to cooldown_s.
        # Default derives from cooldown_s via the multiplier table so it scales
        # with the configured base (and with tests that inject a small base).
        if action_cooldowns is not None:
            self.action_cooldowns = dict(action_cooldowns)
        else:
            self.action_cooldowns = dict(
                (action, mult * cooldown_s)
                for action, mult in _DEFAULT_ACTION_COOLDOWN_MULT.items()
            )
        self.failures = 0
        # `-inf` so the first action is never blocked by the cooldown check.
        self.last_action_at = float("-inf")
        # Index into the ladder — PERSISTED across worker restarts by the
        # caller so escalation survives the systemd recycle that reset the old
        # in-memory restart_count.
        self.level = 0
        # Total actions taken this run — a greppable flap signal in the journal.
        self.action_count = 0

    def on_capture_ok(self):
        """A real frame arrived — the feed recovered. Clear the failure tally
        and de-escalate to the bottom rung so the NEXT incident starts cheap.
        Returns True if this was a recovery FROM an escalated state (so the
        caller can clear persisted state + log), else False."""
        self.failures = 0
        if self.level != 0:
            log.info(
                "mediamtx_watchdog: frames recovered — de-escalating from "
                "level %d to 0", self.level,
            )
            self.level = 0
            return True
        return False

    def on_capture_fail(self):
        """Bump the consecutive-failure tally."""
        self.failures += 1

    def next_action(self, now):
        """Return the recovery action to take NOW (one of the ACTION_*
        constants) or None. Escalates one rung per fire; cooldown-gated so a
        wedged subsystem is never hammered. The caller executes the returned
        action and then persists `level`/`last_action_at`."""
        if self.failures < self.fail_threshold:
            return None
        return self._fire_action(now, self.failures)

    def request_action(self, now, failures=0):
        """Request one rung for an independently debounced local detector.

        PR-204's WHEP scheduler owns only its consecutive-failure debounce.
        This method deliberately reuses this ladder's persisted level and
        cooldown instead of creating a competing recovery state machine.
        """
        return self._fire_action(now, failures)

    def _fire_action(self, now, triggered_failures):
        elapsed = now - self.last_action_at
        required = self._required_cooldown()
        if elapsed < 0:
            log.warning("watchdog:clock-anomaly delta=%s", elapsed)
            self.last_action_at = now
        elif elapsed < required:
            return None
        action = self._resolve_action(self.level)
        prev_level = self.level
        self.last_action_at = now
        # Give the action a cooldown window to take effect before re-counting.
        self.failures = 0
        self.action_count += 1
        # Climb one rung, clamping at the top (keep retrying the last action
        # until a real frame de-escalates us).
        self.level = min(self.level + 1, len(self.ladder) - 1)
        log.warning(
            "mediamtx_watchdog: camera feed wedged — escalation level %d -> "
            "action=%s (action #%d this run; %d consecutive failures, "
            "threshold %d)",
            prev_level, action, self.action_count, triggered_failures,
            self.fail_threshold,
        )
        return action

    def _required_cooldown(self):
        """Dwell required before firing the CURRENT rung, governed by the
        action we last fired (the previous rung). `level` was already bumped
        past the last-fired rung and is persisted across restarts, so this
        needs no extra persisted field. At level 0 (nothing fired yet) the
        flat `cooldown_s` applies — moot anyway since `last_action_at` starts
        at -inf so the first action never blocks."""
        if self.level <= 0:
            return self.cooldown_s
        last_action = self.ladder[min(self.level - 1, len(self.ladder) - 1)]
        return self.action_cooldowns.get(last_action, self.cooldown_s)

    def _resolve_action(self, level):
        """Map a ladder index to an action, honoring `allow_reboot`."""
        action = self.ladder[min(level, len(self.ladder) - 1)]
        if action == ACTION_REBOOT and not self.allow_reboot:
            # Reboot disabled by the operator → keep hammering the strongest
            # non-reboot remedy (nvargus restart) instead of escalating.
            return ACTION_RESTART_NVARGUS
        return action

    # --- persistence helpers (the caller owns the file) --------------------

    def snapshot(self):
        """Serializable escalation state to persist across worker restarts.
        `last_action_at` is None when never acted (the -inf sentinel doesn't
        round-trip cleanly through JSON)."""
        la = self.last_action_at
        return {
            "level": self.level,
            "last_action_at": None if la == float("-inf") else la,
        }

    def restore(self, level, last_action_at, now=None):
        """Re-seed escalation state loaded from disk on worker startup so the
        ladder continues climbing instead of resetting to mediamtx-only."""
        try:
            self.level = max(0, min(int(level), len(self.ladder) - 1))
        except (TypeError, ValueError):
            self.level = 0
        if last_action_at is None:
            self.last_action_at = float("-inf")
        else:
            try:
                restored = float(last_action_at)
            except (TypeError, ValueError):
                restored = 0.0
            if now is None:
                now = time.time()
            if (not math.isfinite(restored)) or restored > (now + 60.0):
                restored = 0.0
            self.last_action_at = restored
