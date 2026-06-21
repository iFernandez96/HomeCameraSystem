"""Unit tests for the escalating MediaMtxWatchdog.

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_mediamtx_watchdog.py -q

Pure-Python module — no jetson_inference / jetson_utils imports. These pin the
escalation ladder + the persistence that makes nvargus-restart REACHABLE
across worker restarts (the 2026-06-20 root cause: in-memory restart_count
reset every systemd restart so escalation never reached nvargus).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mediamtx_watchdog import (  # noqa: E402
    ACTION_REBOOT,
    ACTION_RESTART_MEDIAMTX,
    ACTION_RESTART_NVARGUS,
    MediaMtxWatchdog,
)


def _wedge(w, n=None):
    """Drive `n` (default = threshold) consecutive capture failures."""
    for _ in range(n if n is not None else w.fail_threshold):
        w.on_capture_fail()


def test_given_below_threshold_when_next_action_then_none():
    # arrange
    w = MediaMtxWatchdog(fail_threshold=30)
    _wedge(w, 29)
    # act + assert — one short of the threshold: no action yet.
    assert w.next_action(now=100.0) is None


def test_given_threshold_reached_when_next_action_then_restart_mediamtx_first():
    # arrange
    w = MediaMtxWatchdog(fail_threshold=30)
    _wedge(w)
    # act — first rung of the ladder.
    action = w.next_action(now=100.0)
    # assert — cheap pipeline restart before any heavy hammer.
    assert action == ACTION_RESTART_MEDIAMTX


def test_given_an_action_when_within_cooldown_then_no_refire():
    # arrange
    w = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)
    _wedge(w)
    assert w.next_action(now=0.0) == ACTION_RESTART_MEDIAMTX
    # act — still failing, but only 30 s later (< 60 s cooldown).
    _wedge(w)
    # assert
    assert w.next_action(now=30.0) is None


def test_given_sustained_wedge_when_cooldown_expires_then_escalates_the_ladder():
    """THE core behavior: each cooldown climbs one rung — mediamtx, mediamtx,
    nvargus, nvargus, reboot — so a wedge that mediamtx-restart can't fix
    reaches the nvargus-daemon restart (the only thing that clears libargus)
    and finally a reboot."""
    # arrange
    w = MediaMtxWatchdog(fail_threshold=2, cooldown_s=10.0)
    seen = []
    # act — drive five escalations, each past the cooldown.
    for i in range(5):
        _wedge(w)
        seen.append(w.next_action(now=i * 10.0))
    # assert — the full ladder, in order.
    assert seen == [
        ACTION_RESTART_MEDIAMTX,
        ACTION_RESTART_MEDIAMTX,
        ACTION_RESTART_NVARGUS,
        ACTION_RESTART_NVARGUS,
        ACTION_REBOOT,
    ]


def test_given_top_of_ladder_when_still_wedged_then_keeps_retrying_reboot():
    # arrange — climb to the top, then keep failing.
    w = MediaMtxWatchdog(fail_threshold=1, cooldown_s=10.0)
    for i in range(5):
        _wedge(w)
        w.next_action(now=i * 10.0)
    # act — one more past cooldown.
    _wedge(w)
    # assert — clamps at the reboot rung, doesn't fall off the end.
    assert w.next_action(now=60.0) == ACTION_REBOOT


def test_given_recovery_when_on_capture_ok_then_de_escalates_to_bottom():
    # arrange — escalate two rungs.
    w = MediaMtxWatchdog(fail_threshold=1, cooldown_s=10.0)
    _wedge(w); w.next_action(now=0.0)
    _wedge(w); w.next_action(now=10.0)
    assert w.level == 2
    # act — a real frame arrives.
    was_escalated = w.on_capture_ok()
    # assert — de-escalated, and signals the caller it recovered from a kick.
    assert was_escalated is True
    assert w.level == 0
    assert w.failures == 0


def test_given_no_escalation_when_on_capture_ok_then_returns_false():
    # arrange + act + assert — a normal frame with no prior wedge.
    w = MediaMtxWatchdog()
    w.on_capture_fail()
    assert w.on_capture_ok() is False


def test_given_allow_reboot_false_when_reboot_rung_then_degrades_to_nvargus():
    # arrange — disable reboot; climb to where reboot WOULD fire.
    w = MediaMtxWatchdog(fail_threshold=1, cooldown_s=10.0, allow_reboot=False)
    actions = []
    for i in range(6):
        _wedge(w)
        actions.append(w.next_action(now=i * 10.0))
    # assert — never reboots; pins on nvargus instead.
    assert ACTION_REBOOT not in actions
    assert actions[-1] == ACTION_RESTART_NVARGUS


def test_given_escalation_state_when_snapshot_restored_then_ladder_continues():
    """THE reachability fix: persisting level + last_action_at across a worker
    restart lets the ladder KEEP climbing instead of resetting to mediamtx —
    the bug that left nvargus-restart unreachable."""
    # arrange — worker life #1 does two mediamtx kicks, then 'dies'.
    w1 = MediaMtxWatchdog(fail_threshold=1, cooldown_s=10.0)
    _wedge(w1)
    assert w1.next_action(now=0.0) == ACTION_RESTART_MEDIAMTX
    _wedge(w1)
    assert w1.next_action(now=10.0) == ACTION_RESTART_MEDIAMTX
    snap = w1.snapshot()

    # act — worker life #2 restores the persisted state and keeps failing.
    w2 = MediaMtxWatchdog(fail_threshold=1, cooldown_s=10.0)
    w2.restore(snap["level"], snap["last_action_at"])
    _wedge(w2)
    action = w2.next_action(now=20.0)

    # assert — it ESCALATES to nvargus (level 2), not back to mediamtx.
    assert action == ACTION_RESTART_NVARGUS


def test_given_never_acted_when_snapshot_then_last_action_at_is_none():
    # arrange — snapshot must JSON-round-trip (no -inf sentinel).
    w = MediaMtxWatchdog()
    snap = w.snapshot()
    # assert
    assert snap == {"level": 0, "last_action_at": None}


def test_given_garbage_restore_values_then_safe_defaults():
    # arrange + act — corrupt persisted state must never crash the worker.
    w = MediaMtxWatchdog()
    w.restore("not-an-int", "not-a-float")
    # assert
    assert w.level == 0
    assert w.last_action_at == float("-inf")
