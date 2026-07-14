import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import clip_state  # noqa: E402


def test_set_state_writes_machine_readable_ledger(tmp_path):
    ok = clip_state.set_state(
        str(tmp_path),
        "evt-1",
        "recording",
        start_ts=100.0,
        last_seen=105.0,
    )

    assert ok is True
    data = json.loads((tmp_path / ".clip_state.json").read_text())
    assert data["v"] == 1
    assert data["events"]["evt-1"]["state"] == "recording"
    assert data["events"]["evt-1"]["start_ts"] == 100.0
    assert data["events"]["evt-1"]["last_seen"] == 105.0
    assert "updated_ts" in data["events"]["evt-1"]


def test_get_state_returns_none_for_missing_or_corrupt_ledger(tmp_path):
    assert clip_state.get_state(str(tmp_path), "evt-ghost") is None


def _write_eta_history(tmp_path, count=12):
    events = {}
    for index in range(count):
        capture_s = 70.0 + index * 5.0
        processing_s = 45.0 + index * 3.0
        start = 100.0 + index * 1000.0
        events["done-{}".format(index)] = {
            "state": "available",
            "start_ts": start,
            "end_ts": start + capture_s,
            "updated_ts": start + capture_s + processing_s,
            "bytes": int((20.0 + index) * 1000000),
        }
    (tmp_path / ".clip_state.json").write_text(json.dumps({
        "v": 1, "events": events,
    }))


def test_recording_eta_learns_event_to_access_time_from_device_history(tmp_path):
    _write_eta_history(tmp_path)

    eta = clip_state.estimate_recording_eta(
        str(tmp_path), start_ts=20000.0, last_seen=20030.0,
        absence_finalize_s=30.0, max_visit_s=150.0, now=20030.0,
    )

    assert eta["eta_model"] == "device_history_v1"
    assert eta["eta_model_samples"] >= 8
    assert eta["eta_min_ts"] <= eta["eta_point_ts"] <= eta["eta_max_ts"]
    assert eta["eta_historical_spread_s"] > 0


def test_finalizing_eta_conditions_on_actual_duration_bytes_and_elapsed(tmp_path):
    _write_eta_history(tmp_path)

    eta = clip_state.estimate_finalizing_eta(
        str(tmp_path), end_ts=30000.0, capture_duration_s=100.0,
        input_bytes=26_000_000, now=30020.0,
    )

    assert eta["eta_model"] == "device_history_v1"
    assert eta["eta_point_ts"] > 30020.0
    assert eta["eta_min_ts"] <= eta["eta_point_ts"] <= eta["eta_max_ts"]

    (tmp_path / ".clip_state.json").write_text("{not-json")
    assert clip_state.get_state(str(tmp_path), "evt-ghost") is None


def test_reconcile_stale_marks_abandoned_active_rows_failed(tmp_path):
    (tmp_path / ".clip_state.json").write_text(json.dumps({
        "v": 1,
        "events": {
            "old-finalize": {"state": "finalizing", "updated_ts": 100.0},
            "fresh": {"state": "recording", "updated_ts": 950.0},
        },
    }))

    changed = clip_state.reconcile_stale(str(tmp_path), now=1000.0)

    assert changed == 1
    old = clip_state.get_state(str(tmp_path), "old-finalize")
    assert old["state"] == "failed"
    assert old["failure_code"] == "worker_restarted"
    assert old["failure_stage"] == "finalizing"
    assert "Waiting" not in old["failure_detail"]
    assert clip_state.get_state(str(tmp_path), "fresh")["state"] == "recording"


def test_reconcile_stale_prefers_existing_published_file(tmp_path):
    (tmp_path / ".clip_state.json").write_text(json.dumps({
        "v": 1,
        "events": {"evt": {"state": "finalizing", "updated_ts": 1.0}},
    }))
    (tmp_path / "evt.mp4").write_bytes(b"video")

    assert clip_state.reconcile_stale(str(tmp_path), now=1000.0) == 1
    state = clip_state.get_state(str(tmp_path), "evt")
    assert state["state"] == "available"
    assert state["bytes"] == 5
