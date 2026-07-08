import json
import sys
from pathlib import Path

# decision_ledger.py sits one level up.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from decision_ledger import DecisionLedger  # noqa: E402


def test_append_writes_ts_tag_and_fields(tmp_path):
    path = tmp_path / "decision.jsonl"
    ledger = DecisionLedger(str(path), clock=lambda: 123.5)

    assert ledger.append("presence", {"reason": "emit", "iou": 0.5}) is True

    row = json.loads(path.read_text().strip())
    assert row == {
        "ts": 123.5,
        "tag": "presence",
        "reason": "emit",
        "iou": 0.5,
    }


def test_append_creates_parent_dir(tmp_path):
    path = tmp_path / "nested" / "decision.jsonl"
    ledger = DecisionLedger(str(path), clock=lambda: 1.0)

    assert ledger.append("gear", {"to": "active"}) is True

    assert path.exists()
    assert json.loads(path.read_text())["to"] == "active"


def test_rotation_keeps_single_rollover(tmp_path):
    path = tmp_path / "decision.jsonl"
    path.write_text("x" * 20)
    old_rollover = tmp_path / "decision.jsonl.1"
    old_rollover.write_text("old")
    ledger = DecisionLedger(str(path), max_bytes=10, clock=lambda: 2.0)

    assert ledger.append("watchdog", {"level_to": 1}) is True

    assert old_rollover.read_text() == "x" * 20
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert rows == [{"ts": 2.0, "tag": "watchdog", "level_to": 1}]


def test_write_oserror_is_swallowed_and_counted(tmp_path, monkeypatch):
    path = tmp_path / "decision.jsonl"
    ledger = DecisionLedger(str(path), clock=lambda: 3.0)

    def boom(*_args, **_kwargs):
        raise OSError("pipe closed")

    monkeypatch.setattr("builtins.open", boom)

    assert ledger.append("presence", {"reason": "emit"}) is False
    assert ledger.errors == 1


def test_bad_json_field_is_swallowed_and_counted(tmp_path):
    path = tmp_path / "decision.jsonl"
    ledger = DecisionLedger(str(path), clock=lambda: 4.0)

    assert ledger.append("flight", {"bad": object()}) is False
    assert ledger.errors == 1
    assert not path.exists()
