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
