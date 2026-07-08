import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.shadow_diff import diff_rows  # noqa: E402


def _write_jsonl(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))


def test_diff_rows_reports_agreement_for_aligned_matching_decisions():
    rows = [
        {
            "ts": 10.0, "tag": "presence", "transition": "emit",
            "reason": "emit", "key": "person:front_door", "emit": True,
        },
        {
            "ts": 10.05, "tag": "presence", "transition": "emit",
            "reason": "emit", "key": "person:front_door", "emit": True,
            "shadow": True,
        },
    ]

    assert diff_rows(rows, window_s=0.25) == {
        "agreements": 1,
        "disagreements": [],
    }


def test_diff_rows_reports_disagreement_for_mismatched_decisions():
    rows = [
        {
            "ts": 10.0, "tag": "presence", "transition": "emit",
            "reason": "emit", "key": "person:front_door", "emit": True,
        },
        {
            "ts": 10.02, "tag": "presence", "transition": "re-arm",
            "reason": "re-arm", "key": "person:front_door", "emit": True,
            "shadow": True,
        },
    ]

    result = diff_rows(rows, window_s=0.25)

    assert result["agreements"] == 0
    assert result["disagreements"] == [{
        "ts": 10.0,
        "active": {
            "transition": "emit",
            "reason": "emit",
            "key": "person:front_door",
            "emit": True,
        },
        "shadow": {
            "transition": "re-arm",
            "reason": "re-arm",
            "key": "person:front_door",
            "emit": True,
        },
    }]


def test_shadow_diff_cli_exits_one_on_any_disagreement(tmp_path):
    path = tmp_path / "decision.jsonl"
    _write_jsonl(path, [
        {
            "ts": 1.0, "tag": "presence", "transition": "emit",
            "reason": "emit", "key": "person:front_door", "emit": True,
        },
        {
            "ts": 1.0, "tag": "presence", "transition": "suppress-first-only",
            "reason": "suppress", "key": "person:front_door", "emit": False,
            "shadow": True,
        },
    ])

    proc = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parent.parent / "tools" / "shadow_diff.py"),
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["agreements"] == 0
    assert len(payload["disagreements"]) == 1
