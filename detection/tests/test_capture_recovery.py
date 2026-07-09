"""iter-300 regression tests for detect.py capture-loop recovery.

Background — what's being pinned here:

The user reported "live feed needs to be so much more robust. It keeps
breaking" after a 14-hour outage where MediaMTX's publisher pipeline
silently died and the worker's mediamtx_watchdog never recovered it.
Investigation: 1460 capture timeouts in one hour produced 0 watchdog
restart attempts. Root cause in `detect.py`:

    try:
        img = camera.Capture(timeout=2000)
        consecutive_failures = 0          # <-- ran on Capture-returns-None
        mediamtx_watchdog.on_capture_ok() # <-- ran on Capture-returns-None
    except Exception as e:
        ...
    if img is None:
        consecutive_failures = _handle_capture_failure(
            "timeout (None)", consecutive_failures, ...
        )

A Capture that returned None hit both the success-reset (top of try)
AND the failure-handler (None check). Failures never accumulated past
1 because on_capture_ok() reset the watchdog tally each iteration.

iter-300 fix moved the success reset BELOW the None check. These tests
pin the corrected ordering by simulating the loop on a fake camera that
returns None forever — the watchdog MUST trip its 30-fail threshold and
the giving-up SystemExit MUST fire at 100.

Run from `detection/`:
    /tmp/homecam-venv/bin/python -m pytest tests/test_capture_recovery.py -q

The test mocks `jetson_inference` + `jetson_utils` in sys.modules so
detect.py imports cleanly on the dev host (which has neither).
"""
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# detect.py / mediamtx_watchdog.py / metrics.py sit one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Mock the host-only Jetson SDK imports BEFORE importing detect.
# detect.py does `import jetson_inference` + `import jetson_utils` at
# module top, so without these stubs the import would ImportError on
# any non-Jetson host (CI, dev machine, etc).
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import detect  # noqa: E402
from mediamtx_watchdog import MediaMtxWatchdog  # noqa: E402
from metrics import Metrics  # noqa: E402


class _FakeLiveness:
    """Stand-in for the iter-8 Liveness object — bump() is a no-op."""

    def __init__(self):
        self.bumps = 0

    def bump(self):
        self.bumps += 1


def test_given_capture_returns_none_n_times_when_handler_runs_then_failures_accumulate():
    # arrange
    watchdog = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)
    metrics = Metrics()
    liveness = _FakeLiveness()
    consecutive_failures = 0

    # act — simulate 29 consecutive None-returns from camera.Capture().
    # The handler is what the FIXED detect.py main loop calls when
    # `img is None`. Pre-iter-300 the handler also fired but the
    # success-reset above it ran on every iteration, masking the
    # accumulation. Now the handler is the ONLY path that touches
    # the watchdog on a None return.
    for _ in range(29):
        consecutive_failures = detect._handle_capture_failure(
            "timeout (None)",
            consecutive_failures,
            metrics,
            watchdog,
            liveness,
        )

    # assert — failures should have accumulated.
    assert consecutive_failures == 29
    assert watchdog.failures == 29
    # One short of the 30-fail threshold; the ladder doesn't act yet.
    assert watchdog.next_action(now=100.0) is None


def test_given_30_consecutive_capture_failures_when_handler_runs_then_watchdog_acts(
    monkeypatch,
):
    # arrange — stub the subprocess restart AND the diagnostics probes so the
    # test doesn't systemctl restart anything or shell out on the dev host.
    monkeypatch.setattr(detect, "restart_mediamtx", lambda: True)
    monkeypatch.setattr(detect, "_capture_wedge_diagnostics", lambda action: None)
    watchdog = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)
    metrics = Metrics()
    liveness = _FakeLiveness()
    consecutive_failures = 0

    # act — 30 None-captures in a row. The 30th call trips the threshold →
    # next_action returns the first rung (restart_mediamtx), executes it, and
    # climbs the ladder one step (resetting the failure tally for the cooldown).
    for _ in range(30):
        consecutive_failures = detect._handle_capture_failure(
            "timeout (None)",
            consecutive_failures,
            metrics,
            watchdog,
            liveness,
        )

    # assert — exactly one action fired (cheap mediamtx restart), the ladder
    # climbed to level 1, and the metric recorded it.
    assert watchdog.action_count == 1
    assert watchdog.level == 1
    assert metrics.mediamtx_restarts == 1
    # consecutive_failures (the local) keeps incrementing; only the watchdog's
    # internal failure tally resets when it acts.
    assert consecutive_failures == 30


def test_given_escalation_when_handler_runs_then_level_persisted_before_action(
    monkeypatch,
):
    """2026-07-09 root-cause fix: the escalation level MUST be persisted
    BEFORE the disruptive recovery action runs.

    Live finding: the worker unit had `Requires=mediamtx.service`, so when the
    watchdog escalated and ran `systemctl restart mediamtx`, systemd propagated
    that restart back and STOPPED the worker ~2.8 s later — before the old
    post-action `_persist_watchdog_level` could write `.watchdog_state.json`.
    Every restart then restored level 0, so the ladder re-fired mediamtx forever
    and never reached the nvargus rung that clears the libargus wedge. The unit
    now uses `Wants=`, and the persist moved ahead of the action so the level
    survives ANY mid-action death (systemd stop OR the SystemExit(100) floor).

    Pin the order: persist THEN diagnostics THEN act."""
    # arrange — record the order of the three escalation side effects.
    calls = []
    monkeypatch.setattr(
        detect, "_persist_watchdog_level", lambda wd: calls.append("persist")
    )
    monkeypatch.setattr(
        detect, "_capture_wedge_diagnostics", lambda action: calls.append("diag")
    )

    def _fake_restart():
        calls.append("restart_mediamtx")
        return True

    monkeypatch.setattr(detect, "restart_mediamtx", _fake_restart)
    watchdog = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)
    metrics = Metrics()
    liveness = _FakeLiveness()
    consecutive_failures = 0

    # act — drive to the first escalation (the 30th failure trips it).
    for _ in range(30):
        consecutive_failures = detect._handle_capture_failure(
            "timeout (None)",
            consecutive_failures,
            metrics,
            watchdog,
            liveness,
        )

    # assert — persist ran, and it ran BEFORE the mediamtx restart (the bug was
    # persist-after-action never landing when systemd killed the worker).
    assert "persist" in calls, calls
    assert "restart_mediamtx" in calls, calls
    assert (
        calls.index("persist")
        < calls.index("diag")
        < calls.index("restart_mediamtx")
    ), calls


def test_given_real_frame_after_failures_when_loop_resets_then_watchdog_clears(
    monkeypatch,
):
    """The fixed loop only calls on_capture_ok() when `img is not None`.
    This test pins that contract: after some failures + a real frame,
    the watchdog tally must drop to 0 (so a future burst gets a fresh
    accumulation window)."""
    # arrange
    monkeypatch.setattr(detect, "restart_mediamtx", lambda: True)
    watchdog = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)
    metrics = Metrics()
    liveness = _FakeLiveness()
    consecutive_failures = 0

    # act — 5 failures, then a real frame (which the FIXED loop body
    # handles by calling on_capture_ok() + resetting the local).
    for _ in range(5):
        consecutive_failures = detect._handle_capture_failure(
            "timeout (None)",
            consecutive_failures,
            metrics,
            watchdog,
            liveness,
        )
    # Mirror the fixed loop's "real frame" branch.
    consecutive_failures = 0
    watchdog.on_capture_ok()

    # assert
    assert watchdog.failures == 0
    assert consecutive_failures == 0


def test_given_100_consecutive_failures_when_handler_runs_then_systemexit_fires(
    monkeypatch,
):
    """The 100-fail SystemExit is the LAST line of defense — if the
    watchdog can't recover MediaMTX (e.g. sudo fails), systemd's
    Restart=on-failure cycles the worker. Pin that the threshold
    works."""
    # arrange — pretend the watchdog restart succeeded so the
    # restart-mediamtx subprocess doesn't actually run; stub diagnostics too.
    monkeypatch.setattr(detect, "restart_mediamtx", lambda: True)
    monkeypatch.setattr(detect, "_capture_wedge_diagnostics", lambda action: None)
    watchdog = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)
    metrics = Metrics()
    liveness = _FakeLiveness()
    consecutive_failures = 0

    # act — 100 failures should NOT exit, 101st should.
    for i in range(100):
        consecutive_failures = detect._handle_capture_failure(
            "timeout (None)",
            consecutive_failures,
            metrics,
            watchdog,
            liveness,
        )
        assert consecutive_failures == i + 1, (
            "consecutive_failures must increment monotonically — pre-iter-300"
            " bug had on_capture_ok() resetting it every iteration"
        )

    # The 101st call (consecutive_failures > 100 after increment) raises.
    with pytest.raises(SystemExit):
        detect._handle_capture_failure(
            "timeout (None)",
            consecutive_failures,
            metrics,
            watchdog,
            liveness,
        )


def test_given_liveness_when_handler_runs_then_bump_fires_on_each_failure():
    """The iter-8 liveness gate keeps the heartbeat thread sending POSTs
    while the worker is alive but stuck on capture failures. Without
    this, a 30 s silence triggers the server's worker_alive=false flag
    prematurely. iter-172 added the bump on failure; iter-300's loop
    fix preserves it."""
    # arrange
    watchdog = MediaMtxWatchdog(fail_threshold=30, cooldown_s=60.0)
    metrics = Metrics()
    liveness = _FakeLiveness()

    # act
    detect._handle_capture_failure(
        "timeout (None)", 0, metrics, watchdog, liveness,
    )

    # assert
    assert liveness.bumps == 1
