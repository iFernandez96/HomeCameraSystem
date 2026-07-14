from __future__ import annotations

import json

from app.services import operational_metrics
from app.services.backup_status import record_backup_failure, record_backup_success


def test_given_backup_status_when_scraped_then_only_numeric_outcomes_are_exposed(
    tmp_path,
):
    # arrange
    path = tmp_path / "backup-status.json"
    record_backup_success(
        path,
        filename="private-name.hcbk",
        archive_digest="secret-digest",
        recipient_fingerprint="secret-fingerprint",
        now=100.0,
    )

    # act / assert
    assert operational_metrics.backup_metrics(path, now=160.0) == {
        "status_present": 1.0,
        "last_attempt_success": 1.0,
        "last_success_timestamp": 100.0,
    }
    record_backup_failure(path, reason="private failure detail", now=170.0)
    assert operational_metrics.backup_metrics(path, now=180.0) == {
        "status_present": 1.0,
        "last_attempt_success": 0.0,
        "last_success_timestamp": 100.0,
    }


def test_given_no_backup_status_when_scraped_then_missing_does_not_duplicate_failure(
    tmp_path,
):
    assert operational_metrics.backup_metrics(tmp_path / "missing.json") == {
        "status_present": 0.0,
    }


def test_given_operation_ledgers_when_scraped_then_latest_terminal_outcomes_win(
    tmp_path,
):
    # arrange
    backup = tmp_path / "backup-ledger.jsonl"
    backup.write_text(
        '\n'.join([
            json.dumps({"operation": "restore", "ok": False}),
            json.dumps({"operation": "backup", "ok": False}),
            json.dumps({"operation": "restore", "ok": True}),
        ]) + '\n',
        encoding="utf-8",
    )
    update = tmp_path / "ota-ledger.jsonl"
    update.write_text(
        '\n'.join([
            json.dumps({"status": "rejected"}),
            json.dumps({"status": "started"}),
            json.dumps({"status": "applied"}),
        ]) + '\n',
        encoding="utf-8",
    )

    # act / assert
    assert operational_metrics.latest_restore_success(backup) == 1.0
    assert operational_metrics.latest_update_success(update) == 1.0


def test_given_malformed_ledger_tail_when_scraped_then_failure_is_fail_closed(tmp_path):
    path = tmp_path / "ledger.jsonl"
    path.write_text('{"status":"applied"}\nnot-json\n', encoding="utf-8")
    assert operational_metrics.latest_update_success(path) == 0.0


def test_given_supervisor_state_when_scraped_then_restart_window_and_latch_are_numeric(
    tmp_path,
):
    path = tmp_path / "supervisor.json"
    path.write_text(
        json.dumps({
            "v": 1,
            "restart_times": [300.0, 950.0],
            "last_action_at": 950.0,
            "latched": True,
        }),
        encoding="utf-8",
    )
    assert operational_metrics.supervisor_metrics(path, now=1000.0) == {
        "state_present": 1.0,
        "state_valid": 1.0,
        "latched": 1.0,
        "restarts_in_window": 1.0,
        "last_action_timestamp": 950.0,
    }


def test_given_invalid_supervisor_state_when_scraped_then_it_is_not_trusted(tmp_path):
    path = tmp_path / "supervisor.json"
    path.write_text('{"v":1,"restart_times":[true]}', encoding="utf-8")
    assert operational_metrics.supervisor_metrics(path) == {
        "state_present": 1.0,
        "state_valid": 0.0,
    }
