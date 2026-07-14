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
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

from mediamtx_watchdog import (  # noqa: E402
    ACTION_REBOOT,
    ACTION_RESTART_MEDIAMTX,
    ACTION_RESTART_NVARGUS,
    MediaMtxWatchdog,
)
import detect  # noqa: E402


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
    # act — drive five escalations. Step `now` by a wide margin (100 s) each
    # time so the per-rung dwell is always satisfied regardless of which rung
    # we're on — this test pins the ladder SEQUENCE, not the timing (the
    # per-rung dwell has its own test below).
    for i in range(5):
        _wedge(w)
        seen.append(w.next_action(now=i * 100.0))
    # assert — the full ladder, in order.
    assert seen == [
        ACTION_RESTART_MEDIAMTX,
        ACTION_RESTART_MEDIAMTX,
        ACTION_RESTART_NVARGUS,
        ACTION_RESTART_NVARGUS,
        ACTION_REBOOT,
    ]


def test_given_nvargus_rung_when_only_short_cooldown_elapsed_then_holds_before_reboot():
    """2026-07-09 fix: a nvargus restart needs a long dwell to actually recover
    the libargus session before the ladder advances. Live bug: with a flat
    cooldown the ladder over-ran to reboot while nvargus was still recovering.
    Pin that after a nvargus rung fires, a gap only as long as the (shorter)
    mediamtx dwell does NOT escalate — reboot waits for the full nvargus dwell,
    giving `on_capture_ok` a chance to de-escalate first."""
    # arrange — climb to the first nvargus rung (level 2 fires nvargus).
    w = MediaMtxWatchdog(fail_threshold=1, cooldown_s=10.0)
    _wedge(w); assert w.next_action(now=0.0) == ACTION_RESTART_MEDIAMTX
    _wedge(w); assert w.next_action(now=100.0) == ACTION_RESTART_MEDIAMTX
    _wedge(w); assert w.next_action(now=200.0) == ACTION_RESTART_NVARGUS
    # act — only a mediamtx-length dwell (0.75 * 10 = 7.5 s) after the nvargus
    # kick. The nvargus dwell is 2.5 * 10 = 25 s, so it must NOT fire yet.
    _wedge(w)
    assert w.next_action(now=210.0) is None
    # assert — once the full nvargus dwell elapses, it advances (2nd nvargus).
    assert w.next_action(now=226.0) == ACTION_RESTART_NVARGUS


def test_given_top_of_ladder_when_still_wedged_then_keeps_retrying_reboot():
    # arrange — climb to the top, then keep failing. Wide `now` steps so every
    # per-rung dwell is satisfied (this test pins the top-clamp, not timing).
    w = MediaMtxWatchdog(fail_threshold=1, cooldown_s=10.0)
    for i in range(5):
        _wedge(w)
        w.next_action(now=i * 100.0)
    # act — one more past cooldown.
    _wedge(w)
    # assert — clamps at the reboot rung, doesn't fall off the end.
    assert w.next_action(now=600.0) == ACTION_REBOOT


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


def test_whep_request_uses_same_persistable_ladder_and_cooldown():
    w = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)

    assert w.request_action(now=100.0, failures=3) == ACTION_RESTART_MEDIAMTX
    assert w.snapshot() == {"level": 1, "last_action_at": 100.0}
    assert w.request_action(now=110.0, failures=4) is None
    assert w.level == 1


def test_given_garbage_restore_values_then_safe_defaults():
    # arrange + act — corrupt persisted state must never crash the worker.
    w = MediaMtxWatchdog()
    w.restore("not-an-int", "not-a-float")
    # assert
    assert w.level == 0
    assert w.last_action_at == 0.0


def test_given_future_last_action_at_when_next_action_then_fires_and_self_heals(
    caplog,
):
    # arrange
    w = MediaMtxWatchdog(fail_threshold=1, cooldown_s=60.0)
    w.restore(0, 1030.0, now=1000.0)
    _wedge(w)

    # act
    with caplog.at_level("WARNING"):
        action = w.next_action(now=1000.0)

    # assert
    assert action == ACTION_RESTART_MEDIAMTX
    assert w.snapshot()["last_action_at"] == 1000.0
    assert any(
        rec.getMessage().startswith("watchdog:clock-anomaly")
        for rec in caplog.records
    )


def test_given_future_beyond_sixty_seconds_when_restore_then_timestamp_falls_back():
    # arrange
    w = MediaMtxWatchdog()

    # act
    w.restore(0, 1061.0, now=1000.0)

    # assert
    assert w.last_action_at == 0.0


def test_given_corrupt_last_reboot_at_when_reboot_then_no_typeerror_and_allows_reboot(
    monkeypatch,
):
    # arrange
    calls = []

    def _fake_run(cmd, timeout, stdout, stderr):
        calls.append(cmd)
        return MagicMock()

    monkeypatch.setattr(detect.time, "time", lambda: 2000.0)
    monkeypatch.setattr(detect.subprocess, "run", _fake_run)
    monkeypatch.setattr(detect, "_WATCHDOG_STATE_PATH", None)
    monkeypatch.setattr(detect, "_WATCHDOG_STATE", {"last_reboot_at": "bad"})

    # act
    did_reboot = detect._do_reboot()

    # assert
    assert did_reboot is True
    assert calls == [["sudo", "-n", "systemctl", "reboot"]]
    assert detect._WATCHDOG_STATE["last_reboot_at"] == 2000.0
