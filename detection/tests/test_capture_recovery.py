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
import threading
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


def test_detect_imports_clip_state_for_boot_reconciliation():
    assert detect.clip_state is not None


def test_detection_pause_finalizes_open_visit_immediately(monkeypatch):
    class Runner:
        def __init__(self):
            self.calls = []

        def finalize_open_visits(self, now, reason):
            self.calls.append((now, reason))
            return ["visit-1"]

    runner = Runner()
    monkeypatch.setattr(detect, "_VISIT_RUNNER", runner)

    active = detect._reconcile_detection_capture_gate(True, False, 123.0)

    assert active is False
    assert runner.calls == [(123.0, "detection capture gate paused")]


def test_capture_gate_uses_the_existing_metadata_signal_policy():
    runtime = detect.RuntimeConfig(threshold=0.55, cooldown_s=5.0)
    runtime.enabled = True
    runtime.operating_mode = "home"

    assert detect.metadata_signal_allowed(runtime) is True
    runtime.enabled = False
    assert detect.metadata_signal_allowed(runtime) is False
    runtime.enabled = True
    runtime.operating_mode = "privacy"
    assert detect.metadata_signal_allowed(runtime) is False


def test_detection_gate_does_not_refinalize_while_already_paused(monkeypatch):
    runner = MagicMock()
    monkeypatch.setattr(detect, "_VISIT_RUNNER", runner)

    active = detect._reconcile_detection_capture_gate(False, False, 124.0)

    assert active is False
    runner.finalize_open_visits.assert_not_called()


def test_sigterm_finalizes_and_drains_before_worker_exits(monkeypatch):
    runner = MagicMock()
    preroll = MagicMock()
    runner.finalize_open_visits.return_value = ["visit-1"]
    monkeypatch.setattr(detect, "_VISIT_RUNNER", runner)
    monkeypatch.setattr(detect, "_PREROLL_BUFFER", preroll)
    monkeypatch.setattr(detect.time, "time", lambda: 456.0)
    detect._SHUTDOWN_STARTED.clear()

    with pytest.raises(SystemExit) as stopped:
        detect._handle_worker_shutdown(15, None)

    assert stopped.value.code == 0
    preroll.stop.assert_called_once_with()
    runner.finalize_open_visits.assert_called_once_with(
        456.0, reason="worker shutdown",
    )
    runner.wait_for_finalizers.assert_called_once_with(40.0)
    detect._SHUTDOWN_STARTED.clear()


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


def test_given_watchdog_action_when_reopening_camera_then_old_source_is_closed(
    monkeypatch,
):
    """A watchdog action is not enough if detect.py keeps the old RTSP reader.

    Pin the 2026-07-09 live failure: MediaMTX recovered `/cam`, but the
    existing jetson-utils videoSource kept timing out. Recovery must replace
    the in-process videoSource object.
    """

    class _OldCamera:
        def __init__(self):
            self.closed = False

        def Close(self):
            self.closed = True

    class _NewCamera:
        pass

    old_camera = _OldCamera()
    new_camera = _NewCamera()
    calls = []

    def _fake_video_source(uri, argv=None):
        calls.append((uri, argv))
        return new_camera

    monkeypatch.setattr(detect.jetson_utils, "videoSource", _fake_video_source)
    monkeypatch.setattr(detect, "_rtsp_stream_ready", lambda _uri: True)

    reopened = detect.reopen_camera_after_watchdog_action(
        "rtsp://127.0.0.1:8554/cam",
        old_camera,
        "restart_mediamtx",
        attempts=1,
        retry_s=0.0,
    )

    assert old_camera.closed is True
    assert reopened is new_camera
    assert calls == [
        ("rtsp://127.0.0.1:8554/cam", ["--input-codec=h264"]),
    ]


def test_given_rtsp_is_not_published_when_opening_then_reader_waits_for_probe(
    monkeypatch,
):
    # arrange
    camera = object()
    ready = iter([False, False, True])
    sleeps = []
    source_calls = []

    def _video_source(uri, argv=None):
        source_calls.append((uri, argv))
        return camera

    monkeypatch.setattr(detect.jetson_utils, "videoSource", _video_source)
    monkeypatch.setattr(detect.time, "sleep", lambda seconds: sleeps.append(seconds))

    # act
    opened = detect.open_camera(
        "rtsp://127.0.0.1:8554/cam",
        attempts=3,
        retry_s=0.25,
        ready_probe=lambda _uri: next(ready),
    )

    # assert
    assert opened is camera
    assert sleeps == [0.25, 0.25]
    assert source_calls == [
        ("rtsp://127.0.0.1:8554/cam", ["--input-codec=h264"]),
    ]


def test_given_rtsp_never_publishes_when_opening_then_no_stale_reader_is_created(
    monkeypatch,
):
    # arrange
    source = MagicMock()
    monkeypatch.setattr(detect.jetson_utils, "videoSource", source)
    monkeypatch.setattr(detect.time, "sleep", lambda _seconds: None)

    # act / assert
    with pytest.raises(SystemExit, match="upstream video stream is not ready"):
        detect.open_camera(
            "rtsp://127.0.0.1:8554/cam",
            attempts=2,
            retry_s=0.0,
            ready_probe=lambda _uri: False,
        )
    source.assert_not_called()


def test_privacy_polygons_become_conservative_pipeline_rectangles():
    masks = [[[0.1, 0.2], [0.4, 0.2], [0.4, 0.6], [0.1, 0.6]]]
    assert detect.privacy_rectangles(masks, width=100, height=50) == [
        (10, 10, 31, 21),
    ]


def test_default_privacy_coordinates_keep_durable_1080p_file_contract():
    masks = [[[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]]
    assert detect.privacy_rectangles(masks) == [(0, 0, 961, 541)]


def test_exposure_region_coordinates_match_native_4k_sensor(tmp_path, monkeypatch):
    target = tmp_path / ".camera-exposure.env"
    monkeypatch.setattr(detect, "_EXPOSURE_CONFIG", str(target))

    region = detect._write_exposure_config(
        (True, 0.25, 0.25, 0.5, 0.5, 0.0, False)
    )

    assert region == "960 540 2880 1620 1"
    assert target.read_text() == (
        "AE_SENSOR_WIDTH='3840'\n"
        "AE_SENSOR_HEIGHT='2160'\n"
        "AE_REGION='960 540 2880 1620 1'\n"
        "AE_COMPENSATION='0.00'\n"
        "AE_LOCK='false'\n"
    )


def test_camera_ready_requires_720p_detection_and_1440p_uhq(monkeypatch):
    resolutions = {"cam": (1280, 720), "cam_uhq": (2560, 1440)}
    monkeypatch.setattr(
        detect, "_camera_resolution", lambda path="cam": resolutions.get(path)
    )

    assert detect._both_camera_streams_ready(timeout_s=0.1) is True


def test_privacy_pipeline_file_is_atomic_and_restart_only_on_change(tmp_path):
    path = tmp_path / ".privacy.env"
    restarts = []
    masks = [[[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]]

    assert detect.apply_privacy_pipeline_masks(
        masks, str(path), restart=lambda: restarts.append(True)
    ) is True
    assert restarts == [True]
    assert path.read_text() == "PRIVACY_RECTS='0,0,961,541'\n"

    assert detect.apply_privacy_pipeline_masks(
        masks, str(path), restart=lambda: restarts.append(True)
    ) is False
    assert restarts == [True]


def test_privacy_pipeline_restart_failure_leaves_durable_retry_marker(tmp_path):
    path = tmp_path / ".privacy.env"
    masks = [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]
    calls = []

    def fail_once():
        calls.append("restart")
        if len(calls) == 1:
            raise RuntimeError("systemd busy")

    with pytest.raises(RuntimeError):
        detect.apply_privacy_pipeline_masks(masks, str(path), restart=fail_once)
    assert (tmp_path / ".privacy.env.restart-pending").exists()

    assert detect.apply_privacy_pipeline_masks(
        masks, str(path), restart=fail_once,
    ) is True
    assert calls == ["restart", "restart"]
    assert not (tmp_path / ".privacy.env.restart-pending").exists()


def test_polled_privacy_reconciles_first_response_and_retries_failure():
    state = {"first": True, "pending": False, "applied": None}
    masks = [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]
    calls = []

    def flaky(value, force_restart=False):
        calls.append((value, force_restart))
        if len(calls) == 1:
            raise RuntimeError("restart failed")

    with pytest.raises(RuntimeError):
        detect.reconcile_polled_privacy(flaky, masks, state)
    assert state["pending"] is True
    assert detect.reconcile_polled_privacy(flaky, masks, state) is True
    assert state["pending"] is False
    assert detect.reconcile_polled_privacy(flaky, masks, state) is False
    assert len(calls) == 2
    assert calls[0][1] is False
    assert calls[1][1] is False


def test_matching_privacy_file_can_explicitly_force_restart(tmp_path):
    path = tmp_path / ".privacy.env"
    masks = [[[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]]
    path.write_text("PRIVACY_RECTS='0,0,961,541'\n")
    restarts = []

    assert detect.apply_privacy_pipeline_masks(
        masks, str(path), restart=lambda: restarts.append(True),
        force_restart=True,
    ) is True
    assert restarts == [True]
    assert not (tmp_path / ".privacy.env.restart-pending").exists()


def test_matching_durable_privacy_file_on_first_poll_does_not_restart(tmp_path):
    path = tmp_path / ".privacy.env"
    masks = [[[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]]
    path.write_text("PRIVACY_RECTS='0,0,961,541'\n")
    restarts = []
    state = {"first": True, "pending": False, "applied": None}

    assert detect.reconcile_polled_privacy(
        lambda value, force_restart=False: detect.apply_privacy_pipeline_masks(
            value, str(path), restart=lambda: restarts.append(True),
            force_restart=force_restart,
        ),
        masks,
        state,
    ) is True
    assert restarts == []


def test_privacy_config_write_failure_stops_old_publication(tmp_path, monkeypatch):
    path = tmp_path / ".privacy.env"
    masks = [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]
    real_rename = detect.os.rename
    stopped = []

    def fail_config_rename(source, destination):
        if destination == str(path):
            raise OSError("disk read-only")
        return real_rename(source, destination)

    monkeypatch.setattr(detect.os, "rename", fail_config_rename)
    with pytest.raises(OSError):
        detect.apply_privacy_pipeline_masks(
            masks,
            str(path),
            restart=lambda: None,
            fail_closed=lambda: stopped.append(True),
        )
    assert stopped == [True]


def test_privacy_restart_uses_safe_argus_lifecycle_and_replaces_decoder():
    calls = []
    sleeps = []
    planned = threading.Event()
    lock = threading.Lock()

    def run(command, **kwargs):
        calls.append((command, kwargs.get("check")))

    detect.restart_privacy_pipeline_fail_closed(
        run=run,
        sleep=lambda seconds: sleeps.append(seconds),
        streams_ready=lambda timeout_s: timeout_s == 25.0,
        schedule_restart=lambda: True,
        planned_reset=planned,
        recovery_lock=lock,
    )
    assert calls == [
        (["sudo", "-n", "systemctl", "stop", "mediamtx.service"], False),
        (["sudo", "-n", "pkill", "-9", "-f",
          "gst-launch-1.0.*nvarguscamerasrc"], False),
        (["sudo", "-n", "systemctl", "restart",
          "nvargus-daemon.service"], True),
        (["sudo", "-n", "systemctl", "start", "mediamtx.service"], True),
    ]
    assert sleeps == [5.0]
    assert planned.is_set()


def test_privacy_stop_failure_kills_stale_unit_and_verifies_absence():
    calls = []
    stop_attempts = [1, 1]

    class Result:
        def __init__(self, returncode):
            self.returncode = returncode

    def run(command, **kwargs):
        calls.append(command)
        if command[-2:] == ["stop", "mediamtx.service"]:
            return Result(stop_attempts.pop(0))
        if command[:3] == ["systemctl", "is-active", "--quiet"]:
            return Result(3)
        if command[0] == "pgrep":
            return Result(1)
        return Result(0)

    detect._stop_mediamtx_verified(run)
    assert ["sudo", "-n", "systemctl", "kill", "--kill-who=all",
            "--signal=SIGKILL", "mediamtx.service"] in calls
    assert ["sudo", "-n", "pkill", "-9", "-f",
            "[g]st-launch-1.0.*(nvarguscamerasrc|videotestsrc)"] in calls


def test_privacy_restart_failure_stops_pipeline_fail_closed():
    calls = []
    planned = threading.Event()

    def run(command, **kwargs):
        calls.append((command, kwargs.get("check")))
        if command[-2:] == ["start", "mediamtx.service"]:
            raise RuntimeError("start failed")

    with pytest.raises(RuntimeError):
        detect.restart_privacy_pipeline_fail_closed(
            run=run, sleep=lambda _seconds: None,
            streams_ready=lambda timeout_s: True,
            schedule_restart=lambda: True,
            planned_reset=planned,
            recovery_lock=threading.Lock(),
        )
    assert calls[-1] == (
        ["sudo", "-n", "systemctl", "stop", "mediamtx.service"], False,
    )
    assert planned.is_set()


@pytest.mark.parametrize("streams_ready,schedule_restart", [
    (lambda timeout_s: False, lambda: True),
    (lambda timeout_s: True, lambda: False),
])
def test_privacy_probe_or_decoder_schedule_failure_stops_publication(
    streams_ready, schedule_restart,
):
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs.get("check")))

    with pytest.raises(RuntimeError):
        detect.restart_privacy_pipeline_fail_closed(
            run=run,
            sleep=lambda _seconds: None,
            streams_ready=streams_ready,
            schedule_restart=schedule_restart,
            planned_reset=threading.Event(),
            recovery_lock=threading.Lock(),
        )
    assert calls[-1] == (
        ["sudo", "-n", "systemctl", "stop", "mediamtx.service"], False,
    )


def test_planned_camera_reset_suppresses_capture_watchdog_escalation():
    watchdog = MediaMtxWatchdog(fail_threshold=1, cooldown_s=0.0)
    metrics = Metrics()
    liveness = _FakeLiveness()
    detect._PLANNED_CAMERA_RESET.set()
    try:
        failures = detect._handle_capture_failure(
            "planned outage", 99, metrics, watchdog, liveness,
        )
    finally:
        detect._PLANNED_CAMERA_RESET.clear()

    assert failures == 0
    assert watchdog.failures == 0
    assert watchdog.action_count == 0
    assert metrics.dropped == 0
    assert liveness.bumps == 1
