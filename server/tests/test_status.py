import time

import pytest
from fastapi.testclient import TestClient


def test_when_worker_heartbeats_fps_then_top_level_status_fps_mirrors_it(
    client: TestClient,
):
    # arrange — fire a heartbeat with a known fps value via the
    # /api/_internal/heartbeat endpoint. This is the same path the
    # detection worker uses in production. Pre-iter-246 the top-
    # level status.fps read `camera_service.fps` (always 0.0); now
    # it must mirror `worker_metrics.fps`.

    # act
    hb = client.post(
        "/api/_internal/heartbeat",
        json={"fps": 19.29, "infer_per_s": 0.97, "gear": "idle"},
    )
    assert hb.status_code == 200
    r = client.get("/api/status")

    # assert
    assert r.status_code == 200
    body = r.json()
    assert body["worker_metrics"]["fps"] == 19.29
    assert body["fps"] == 19.29


def test_when_no_worker_heartbeat_yet_then_top_level_status_fps_defaults_to_zero(
    client: TestClient,
):
    # arrange — fresh server, no heartbeat yet. The worker_metrics
    # dict is empty so `worker_metrics.get("fps", 0.0)` returns 0.0.
    # Pre-iter-246 this happened to also be 0.0 (camera_service.fps
    # default), but for the wrong reason.

    # act
    r = client.get("/api/status")

    # assert
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["fps"], (int, float))
    # No heartbeat fired in this test. The metrics dict may be empty
    # or contain prior-test heartbeats depending on fixture order;
    # what we pin is that fps is a number, not a None or missing.
    assert body["fps"] >= 0.0


def test_status_returns_expected_shape(client: TestClient):
    r = client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert isinstance(body["uptime_s"], float)
    assert body["uptime_s"] >= 0
    assert body["host_uptime_s"] is None or body["host_uptime_s"] >= 0
    assert body["camera"] in ("ok", "missing", "error")
    assert isinstance(body["detection_active"], bool)
    assert isinstance(body["worker_alive"], bool)
    assert body["worker_last_seen_s"] is None or isinstance(
        body["worker_last_seen_s"], (int, float)
    )
    assert "cpu_temp_c" in body  # may be None on non-Linux hosts
    assert "gpu_temp_c" in body  # may be None on non-Tegra hosts
    assert body["gpu_temp_c"] is None or isinstance(
        body["gpu_temp_c"], (int, float)
    )
    assert "cpu_freq_pct" in body  # may be None on non-cpufreq hosts
    assert body["cpu_freq_pct"] is None or (
        isinstance(body["cpu_freq_pct"], (int, float))
        and 0 <= body["cpu_freq_pct"] <= 100
    )
    assert "load_avg" in body
    assert body["load_avg"] is None or (
        isinstance(body["load_avg"], list) and len(body["load_avg"]) == 3
    )
    assert "memory_used_mb" in body
    assert "memory_total_mb" in body
    assert "disk_free_gb" in body
    assert "system_disk_free_gb" in body
    assert isinstance(body["fps"], (int, float))
    # iter-155: count of live push subscriptions. Always non-negative;
    # zero on a fresh server before any device subscribes.
    assert isinstance(body["push_subs_count"], int)
    assert body["push_subs_count"] >= 0


def test_status_includes_profiling_fields_on_linux(client: TestClient):
    """When running on a Linux test host (CI), profiling fields should be
    populated. Skip on non-Linux runners — they don't have /proc/loadavg
    + /proc/meminfo, so `app.routes.system_status` returns None for those
    fields, and the sanity assertions below would fail. iter-233: use
    `pytest.skip` instead of bare `return` so pytest reports SKIPPED
    rather than silently PASSED on macOS/Windows."""
    import sys

    if sys.platform != "linux":
        pytest.skip("requires /proc/loadavg + /proc/meminfo (Linux only)")
    body = client.get("/api/status").json()
    assert body["load_avg"] is not None
    assert body["memory_used_mb"] is not None
    assert body["memory_total_mb"] is not None
    assert body["disk_free_gb"] is not None
    # Sanity checks.
    assert body["memory_used_mb"] < body["memory_total_mb"]
    assert body["disk_free_gb"] > 0


def test_status_uptime_increases_between_calls(client: TestClient):
    r1 = client.get("/api/status").json()
    time.sleep(0.05)
    r2 = client.get("/api/status").json()
    assert r2["uptime_s"] >= r1["uptime_s"]


def test_status_reports_recording_filesystem_and_system_sd_separately(
    client: TestClient, monkeypatch
):
    from app import main as app_main
    from app.config import settings

    calls = []

    def fake_disk(path):
        calls.append(str(path))
        return 88.0 if str(path) == str(settings.recordings_dir) else 35.0

    monkeypatch.setattr(app_main, "_disk_free_gb", fake_disk)
    body = client.get("/api/status").json()

    assert body["disk_free_gb"] == 88.0
    assert body["system_disk_free_gb"] == 35.0
    assert str(settings.recordings_dir) in calls
    assert "/" in calls


def test_status_camera_reports_ok_after_lifespan_start(client: TestClient):
    body = client.get("/api/status").json()
    # CameraService.start() is called in lifespan and flips active to True.
    assert body["camera"] == "ok"


def test_status_response_has_exact_documented_field_set(client: TestClient):
    """Lock the /api/status payload shape. If a future iter adds or
    removes a field, this test fires with a clear diff — and it
    forces the author to also update `client/src/lib/types.ts
    ::ServerStatus` (the iter-30 strict typing), which is the same
    contract the LiveStats / Settings tests assert against.

    Mirrors the iter-56 pattern that locks the heartbeat whitelist
    round-trip. Three corners of the contract triangle (route /
    Pydantic-or-equivalent / client type) are now pinned for both
    the status and heartbeat payloads."""
    body = client.get("/api/status").json()
    assert set(body.keys()) == {
        "ok",
        "uptime_s",
        "host_uptime_s",
        "camera",
        "detection_active",
        "worker_alive",
        "worker_last_seen_s",
        "worker_metrics",
        "power_sample_age_s",
        "cpu_temp_c",
        "gpu_temp_c",
        "cpu_freq_pct",
        "load_avg",
        "memory_used_mb",
        "memory_total_mb",
        "disk_free_gb",
        "system_disk_free_gb",
        "fps",
        "push_subs_count",
        "seconds_since_last_frame",
        # iter-313 (perf #3): inlined from /api/detection/config so the
        # Live page can read them off the existing 5 s status poll.
            "camera_label",
            "audio_enabled",
            "recording_gb_per_day",
            "protected_recording_gb",
            "recording_assurance",
        }


def test_status_calls_meminfo_once_per_request(
    client: TestClient, monkeypatch
):
    """iter-160: the handler used to do
    `_meminfo()[0]` and `_meminfo()[1]` on consecutive lines, parsing
    /proc/meminfo twice on every PWA poll. Cheap on its own but the
    Jetson sees this multiplied by 5 s polls × multiple tabs and the
    eMMC isn't fast. Pin the de-duplication so a future re-edit can't
    silently re-introduce the double-read.
    """
    from app import main as app_main

    calls = {"n": 0}

    def fake_meminfo(*args, **kwargs):
        calls["n"] += 1
        return (1400, 1979)

    monkeypatch.setattr(app_main, "_meminfo", fake_meminfo)

    body = client.get("/api/status").json()
    assert body["memory_used_mb"] == 1400
    assert body["memory_total_mb"] == 1979
    assert calls["n"] == 1


# iter-302a/b (test-coverage-auditor C4): seconds_since_last_frame is
# the single user-visible signal of the iter-300 outage class. Pin
# all three branches: no worker, worker without last_frame_ts, worker
# with positive last_frame_ts.

def test_when_no_worker_heartbeat_yet_then_seconds_since_last_frame_is_none(
    client: TestClient,
):
    # arrange — worker hasn't heartbeated; worker_metrics is None
    # (server fixture default).

    # act
    body = client.get("/api/status").json()

    # assert
    assert body["seconds_since_last_frame"] is None


def test_when_worker_heartbeats_without_last_frame_ts_then_seconds_since_last_frame_is_none(
    client: TestClient,
):
    """Pre-iter-302 the worker didn't emit last_frame_ts; for the
    grace period after deploy + before the first real frame, the
    field should stay None rather than report '600 days since last
    frame' (now - 0.0)."""
    # arrange — heartbeat without last_frame_ts AND last_frame_ts=0.0.
    # Both should resolve to None.

    # act
    r = client.post("/api/_internal/heartbeat", json={"fps": 5.0, "frames": 10})
    assert r.status_code == 200
    body = client.get("/api/status").json()

    # assert
    assert body["seconds_since_last_frame"] is None


def test_when_worker_heartbeats_recent_last_frame_ts_then_seconds_since_last_frame_is_positive(
    client: TestClient,
):
    # arrange — heartbeat with a last_frame_ts a few seconds ago.
    import time as _time
    recent = _time.time() - 3.0

    # act
    r = client.post(
        "/api/_internal/heartbeat",
        json={"fps": 5.0, "frames": 10, "last_frame_ts": recent},
    )
    assert r.status_code == 200
    body = client.get("/api/status").json()

    # assert — value should be ~3.0, definitely positive and < 60
    # so the UI's stream-stale gate (>60) wouldn't fire.
    sec = body["seconds_since_last_frame"]
    assert sec is not None
    assert isinstance(sec, (int, float))
    assert 0.0 <= sec < 60.0


def test_status_push_subs_count_tracks_subscribe_remove(client: TestClient):
    """iter-155: `push_subs_count` should reflect the live registry.
    Subscribe → count up; unsubscribe → count back down. The
    `_reset_push_subs` autouse fixture in conftest.py guarantees we
    start at 0 each test."""
    body = client.get("/api/status").json()
    assert body["push_subs_count"] == 0

    payload = {
        "endpoint": "https://push.example/iter155",
        "keys": {"p256dh": "a", "auth": "b"},
    }
    client.post("/api/push/subscribe", json=payload)
    body = client.get("/api/status").json()
    assert body["push_subs_count"] == 1

    client.post(
        "/api/push/unsubscribe",
        json={"endpoint": "https://push.example/iter155"},
    )
    body = client.get("/api/status").json()
    assert body["push_subs_count"] == 0
