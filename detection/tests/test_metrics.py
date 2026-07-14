"""Unit tests for the extracted Metrics class.

The module imports only stdlib (`collections`, `time`), so these tests
run on the dev host without `jetson_inference` / `jetson_utils`.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from metrics import Metrics  # noqa: E402


# --- snapshot shape ----------------------------------------------------------


def test_snapshot_returns_all_documented_fields():
    m = Metrics()
    snap = m.snapshot()
    assert set(snap.keys()) == {
        "fps",
        "infer_per_s",
        "gear",
        "frames",
        "inferences",
        "emitted",
        "dropped",
        "infer_ms_recent",
        "infer_ms_p95",
        "mediamtx_restarts",
        "thumb_ms_recent",
        "uptime_s",
        "face_recog_names",
        # iter-302: stream-stale + nvargus-escalation signals.
        "last_frame_ts",
        "argus_restarts",
        # logging-plan §1.2: failure-rate counters.
        "clips_dropped_capacity",
        "clip_start_failures",
        "face_recog_failures",
        "event_post_failures",
        "thumb_save_failures",
        # plan S6: continuous-capture observability counters.
        "visits_finalized",
        "clips_dropped_disk_floor",
        # slice B: watchdog escalation + capture-wedge diagnostics surfaced
        # over the heartbeat for the god-mode wedge panel.
        "watchdog_level",
        "watchdog_last_action",
        "watchdog_last_action_at",
        "watchdog_last_reboot_at",
        "watchdog_action_count",
        "wedge_diag_at",
        "wedge_diag_argus_pending",
        "wedge_diag_gpu_temp_c",
        "wedge_diag_mem_avail_mb",
        "wedge_diag_nvargus_rss_kb",
        # Real input-power telemetry (0=unavailable on a bare Nano 2GB).
        "power_sensor_status",
        "power_volts",
        "power_amps",
        "power_watts",
        "power_sample_ts",
            "power_read_failures",
            # Low-cadence camera image-quality monitoring.
            "camera_quality_status",
            "camera_luma",
            "camera_sharpness",
            "camera_frame_delta",
        }


def test_uptime_starts_near_zero_and_grows():
    m = Metrics()
    early = m.uptime_s()
    assert early >= 0.0
    # Uptime is a strictly increasing scalar; sleep just enough to clear
    # whatever epoch resolution the test runner provides.
    time.sleep(0.02)
    later = m.uptime_s()
    assert later > early


def test_snapshot_defaults_are_safe_to_serialize():
    # New metrics objects should snapshot cleanly even before any
    # inferences have been recorded — that's the worker's first ~10 s
    # of life. No NaNs, no None, no inf.
    snap = Metrics().snapshot()
    assert snap["infer_ms_recent"] == 0.0
    assert snap["infer_ms_p95"] == 0.0
    assert snap["thumb_ms_recent"] == 0.0
    assert snap["frames"] == 0
    assert snap["dropped"] == 0
    assert snap["mediamtx_restarts"] == 0
    assert snap["gear"] == "idle"
    assert snap["face_recog_names"] == []
    assert snap["power_sensor_status"] == 0
    assert snap["power_watts"] == 0.0


def test_record_thumb_ms_updates_field_and_snapshot():
    """iter-187: `record_thumb_ms` is the operator-level signal for
    Feature #9 (NVENC thumb encode). Calling it updates the field
    and the snapshot reflects the rounded value."""
    m = Metrics()
    m.record_thumb_ms(82.34)
    assert m.thumb_ms_recent == 82.34
    snap = m.snapshot()
    # snapshot rounds to 1 decimal — keeps wire-payload compact.
    assert snap["thumb_ms_recent"] == 82.3


# --- record_infer_ms / infer_ms_p95 ------------------------------------------


def test_record_infer_ms_updates_recent_but_first_sample_skipped():
    m = Metrics()
    m.record_infer_ms(42.5)
    # `infer_ms_recent` reflects every call (raw signal).
    assert m.infer_ms_recent == 42.5
    # But the first sample is the cold-cache TRT warmup — never
    # representative — so it's excluded from the ring buffer that
    # feeds the percentile. p95 is also gated on `INFER_HISTORY_WARMUP`
    # so even the first non-skipped sample needs more before reporting.
    assert m.infer_ms_p95() == 0.0


def test_p95_is_zero_until_first_inference():
    m = Metrics()
    assert m.infer_ms_p95() == 0.0


def test_first_sample_is_excluded_from_ring_buffer():
    """The cold-cache spike must not contaminate the buffer."""
    m = Metrics()
    m.record_infer_ms(8000.0)  # cold-cache outlier
    # Fill exactly INFER_HISTORY_WARMUP normal samples so p95 fires.
    for _ in range(Metrics.INFER_HISTORY_WARMUP):
        m.record_infer_ms(40.0)
    # If the cold-cache leaked into the buffer, p95 would be 8000;
    # if skipped, p95 reflects only the 40-ms samples.
    assert m.infer_ms_p95() == 40.0


def test_p95_stays_zero_below_warmup_threshold_after_first_skipped():
    """`INFER_HISTORY_WARMUP` samples are needed beyond the skipped
    first sample. Recording exactly WARMUP-1 non-skipped samples
    (so WARMUP raw `record_infer_ms` calls including the skipped
    first) should still leave p95 at 0."""
    m = Metrics()
    for _ in range(Metrics.INFER_HISTORY_WARMUP):
        m.record_infer_ms(40.0)
    # First call was skipped → buffer has WARMUP-1 entries.
    assert m.infer_ms_p95() == 0.0


def test_p95_starts_reporting_after_warmup_excluding_first_sample():
    m = Metrics()
    # Need WARMUP+1 raw calls so the buffer reaches WARMUP entries
    # (the first call is excluded).
    for _ in range(Metrics.INFER_HISTORY_WARMUP + 1):
        m.record_infer_ms(40.0)
    assert m.infer_ms_p95() == 40.0


def test_p95_picks_high_end_of_distribution():
    m = Metrics()
    # 19 samples at 40 ms, 1 spike at 200 ms → p95 should land on the spike.
    for _ in range(19):
        m.record_infer_ms(40.0)
    m.record_infer_ms(200.0)
    assert m.infer_ms_p95() == 200.0


def test_p95_ignores_a_lone_outlier_at_small_window():
    # With a tiny window the spike gets sorted to the top — that's
    # actually fine for our use case (we want "worst recent, ignoring
    # 1-2 outliers" and a 20-sample window keeps the lookback short).
    # This test pins the chosen behaviour: at exactly 20 samples,
    # int(0.95*20) = 19 = the max, so the worst sample IS the p95.
    m = Metrics()
    for v in [40, 42, 38, 41, 39, 43, 41, 40, 42, 40,
              41, 39, 40, 41, 42, 38, 41, 40, 42, 200]:
        m.record_infer_ms(float(v))
    assert m.infer_ms_p95() == 200.0


def test_ring_buffer_drops_oldest():
    m = Metrics()
    # Fill the buffer with high values, then push 20 low values to
    # evict them. p95 should now reflect only the new (low) range.
    for _ in range(Metrics.INFER_HISTORY_CAP):
        m.record_infer_ms(500.0)
    for _ in range(Metrics.INFER_HISTORY_CAP):
        m.record_infer_ms(40.0)
    assert m.infer_ms_p95() == 40.0


# --- timing helpers ---------------------------------------------------------


def test_fps_returns_zero_when_no_frames():
    m = Metrics()
    assert m.fps() == 0.0


def test_fps_uses_started_timestamp():
    m = Metrics()
    m.frames = 30
    # Pretend the worker started 1 second ago — fps ≈ 30.
    m.started = time.time() - 1.0
    assert 25.0 < m.fps() < 35.0


def test_infer_per_s_uses_started_timestamp():
    m = Metrics()
    m.inferences = 10
    m.started = time.time() - 2.0
    assert 4.5 < m.infer_per_s() < 5.5


# --- p95 wire pin (iter-356.62 pre-YOLO win 2) -------------------------------


def test_given_warmed_up_p95_when_snapshot_then_field_carries_real_value():
    """Worker-side pin for the p95 wire: once we've cleared the
    cold-cache skip + warmup floor, `snapshot()` must surface the
    live `infer_ms_p95()` value under the SAME key the server
    whitelist (`_internal.py::_ALLOWED_METRIC_FIELDS`) expects.

    If anyone renames the snapshot key or accidentally drops it from
    the dict, this fails here BEFORE the field silently disappears
    from `/api/status.worker_metrics` in the UI."""
    # arrange — push WARMUP+1 raw samples so the buffer hits warmup
    # (first call is the cold-cache skip).
    m = Metrics()
    for _ in range(Metrics.INFER_HISTORY_WARMUP + 1):
        m.record_infer_ms(57.0)

    # act
    snap = m.snapshot()

    # assert — key is present AND carries the live percentile, not 0.
    assert "infer_ms_p95" in snap
    assert snap["infer_ms_p95"] == 57.0
    # And it matches the live method — the snapshot must not lag.
    assert snap["infer_ms_p95"] == m.infer_ms_p95()
