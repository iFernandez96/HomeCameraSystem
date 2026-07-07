"""Direct unit tests for the WorkerHealth liveness tracker."""
from __future__ import annotations

import logging
import time

import pytest

import app.services.health as health_mod
from app.log import RateLimitedLog
from app.services.health import WorkerHealth, seconds_since_last_frame


def test_starts_dead():
    h = WorkerHealth()
    assert h.is_alive() is False
    assert h.last_seen_s() is None


def test_heartbeat_marks_alive():
    h = WorkerHealth(alive_window_s=30.0)
    h.heartbeat()
    assert h.is_alive() is True
    last = h.last_seen_s()
    assert last is not None
    assert 0.0 <= last < 0.5


def test_alive_window_expires():
    h = WorkerHealth(alive_window_s=0.01)
    h.heartbeat()
    time.sleep(0.05)
    assert h.is_alive() is False


def test_heartbeat_resets_window():
    h = WorkerHealth(alive_window_s=0.05)
    h.heartbeat()
    time.sleep(0.03)
    h.heartbeat()
    time.sleep(0.03)
    # Without the second heartbeat we'd be dead at ~0.06 s. Second heartbeat
    # at 0.03 s pushes the window forward.
    assert h.is_alive() is True


def test_metrics_returns_none_when_dead():
    h = WorkerHealth()
    h.last_metrics = {"fps": 5.0}  # simulate prior state
    # is_alive() is False because last_heartbeat == 0.0; metrics()
    # must hide the stale snapshot — otherwise a UI poll right after
    # a worker crash would see the worker pill flip to OFFLINE while
    # `worker_metrics` still showed 5 fps.
    assert h.metrics() is None


def test_heartbeat_with_metrics_stores_them():
    h = WorkerHealth(alive_window_s=30.0)
    h.heartbeat({"fps": 4.5, "gear": "active"})
    assert h.metrics() == {"fps": 4.5, "gear": "active"}


def test_bare_heartbeat_preserves_prior_metrics():
    """A bare ping (no metrics arg) must update the timestamp without
    erasing the most recent metrics snapshot. Pinned in iter-81 at
    the route layer; this is the symmetric direct-class assertion."""
    h = WorkerHealth(alive_window_s=30.0)
    h.heartbeat({"fps": 4.5, "gear": "active"})
    h.heartbeat()  # bare ping
    assert h.metrics() == {"fps": 4.5, "gear": "active"}


def test_metrics_overwrites_on_full_heartbeat():
    """A new metrics-bearing heartbeat replaces the prior snapshot
    wholesale — no merge. The worker is the source of truth for
    each tick; merging would surface ghost fields after a worker
    restart."""
    h = WorkerHealth(alive_window_s=30.0)
    h.heartbeat({"fps": 4.5, "gear": "active"})
    h.heartbeat({"fps": 1.0, "gear": "idle"})
    assert h.metrics() == {"fps": 1.0, "gear": "idle"}


def test_metrics_hidden_after_window_expires():
    h = WorkerHealth(alive_window_s=0.01)
    h.heartbeat({"fps": 5.0})
    assert h.metrics() == {"fps": 5.0}
    time.sleep(0.05)
    # Window expired — metrics() returns None even though
    # last_metrics is still set on the instance.
    assert h.metrics() is None
    assert h.last_metrics == {"fps": 5.0}  # internal state unchanged


def test_snapshot_returns_consistent_tuple_at_threshold():
    """iter-176: `snapshot(now)` reads (alive, last_seen_s, metrics)
    against a single timestamp. Pre-iter-176, `/api/status` called the
    three accessors independently and could land on a boundary where
    `is_alive()` returned True (elapsed < window) but a follow-on
    `last_seen_s()` returned >window because `time.time()` ticked
    between the two reads. This test simulates that boundary
    explicitly by passing `now` values that straddle the window."""
    h = WorkerHealth(alive_window_s=30.0)
    h.last_heartbeat = 1000.0
    h.last_metrics = {"fps": 5.0, "gear": "active"}

    # `now` just inside the window: alive, has metrics.
    alive, last_seen, metrics = h.snapshot(now=1029.99)
    assert alive is True
    assert last_seen == pytest.approx(29.99)
    assert metrics == {"fps": 5.0, "gear": "active"}

    # `now` just past the window: dead, metrics hidden, but
    # last_seen still reports the actual elapsed seconds.
    alive, last_seen, metrics = h.snapshot(now=1030.01)
    assert alive is False
    assert last_seen == pytest.approx(30.01)
    assert metrics is None


def test_snapshot_returns_none_tuple_before_first_heartbeat():
    """`(False, None, None)` when no heartbeat has ever landed."""
    h = WorkerHealth()
    alive, last_seen, metrics = h.snapshot(now=42.0)
    assert alive is False
    assert last_seen is None
    assert metrics is None


def test_snapshot_uses_time_time_when_now_omitted():
    """The default path reads `time.time()` once and uses it for all
    three derivations — same behaviour as pre-iter-176 callers, just
    consolidated."""
    h = WorkerHealth(alive_window_s=30.0)
    h.heartbeat({"fps": 1.0})
    alive, last_seen, metrics = h.snapshot()
    assert alive is True
    assert last_seen is not None
    assert last_seen < 1.0  # just heartbeated
    assert metrics == {"fps": 1.0}


def test_given_future_wall_heartbeat_when_age_derived_then_last_seen_is_zero():
    # Given / arrange — a heartbeat was accepted before the wall clock jumped
    # backward, making the saved wall timestamp appear to be in the future.
    wall_now = {"t": 1000.0}
    monotonic_now = {"t": 500.0}
    h = WorkerHealth(
        alive_window_s=30.0,
        clock=lambda: wall_now["t"],
        monotonic_clock=lambda: monotonic_now["t"],
    )
    h.heartbeat({"fps": 4.0})
    wall_now["t"] = 900.0

    # When / act
    alive, last_seen, metrics = h.snapshot()

    # Then / assert — the derived age is clamped, not reported negative.
    assert alive is True
    assert last_seen == pytest.approx(0.0)
    assert metrics == {"fps": 4.0}


def test_given_future_last_frame_ts_when_heartbeat_lands_then_discarded_with_warning(
    monkeypatch,
    caplog,
):
    # Given / arrange — the worker sends an implausible future frame timestamp.
    wall_now = {"t": 1000.0}
    monotonic_now = {"t": 500.0}
    gate_now = {"t": 1000.0}
    monkeypatch.setattr(
        health_mod,
        "_future_last_frame_warn_gate",
        RateLimitedLog(60.0, clock=lambda: gate_now["t"]),
    )
    h = WorkerHealth(
        alive_window_s=30.0,
        clock=lambda: wall_now["t"],
        monotonic_clock=lambda: monotonic_now["t"],
    )

    # When / act
    with caplog.at_level(logging.WARNING, logger="app.services.health"):
        h.heartbeat({"fps": 4.0, "last_frame_ts": wall_now["t"] + 61.0})

    # Then / assert — the bad input is absent from the stored metrics and
    # operators get one rate-limited warning.
    assert h.metrics() == {"fps": 4.0}
    assert seconds_since_last_frame(h.metrics(), now=wall_now["t"]) is None
    warnings = [
        rec for rec in caplog.records
        if "discarded implausible future last_frame_ts" in rec.getMessage()
    ]
    assert len(warnings) == 1


def test_given_wall_clock_jumps_backward_when_liveness_checked_then_worker_stays_alive():
    # Given / arrange — a heartbeat was received, then wall time moved backward.
    wall_now = {"t": 1000.0}
    monotonic_now = {"t": 500.0}
    h = WorkerHealth(
        alive_window_s=30.0,
        clock=lambda: wall_now["t"],
        monotonic_clock=lambda: monotonic_now["t"],
    )
    h.heartbeat({"fps": 4.0})
    wall_now["t"] = 100.0
    monotonic_now["t"] = 505.0

    # When / act
    alive, last_seen, metrics = h.snapshot()

    # Then / assert — liveness follows monotonic time, not shifted wall time.
    assert alive is True
    assert last_seen == pytest.approx(5.0)
    assert metrics == {"fps": 4.0}


def test_given_wall_clock_jumps_forward_when_liveness_checked_then_worker_stays_alive():
    # Given / arrange — wall time jumps far past the alive window, while only
    # five monotonic seconds have elapsed since heartbeat receipt.
    wall_now = {"t": 1000.0}
    monotonic_now = {"t": 500.0}
    h = WorkerHealth(
        alive_window_s=30.0,
        clock=lambda: wall_now["t"],
        monotonic_clock=lambda: monotonic_now["t"],
    )
    h.heartbeat({"fps": 4.0})
    wall_now["t"] = 100000.0
    monotonic_now["t"] = 505.0

    # When / act
    alive, last_seen, metrics = h.snapshot()

    # Then / assert
    assert alive is True
    assert last_seen == pytest.approx(5.0)
    assert metrics == {"fps": 4.0}
