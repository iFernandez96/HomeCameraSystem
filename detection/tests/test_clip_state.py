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
