from datetime import UTC, datetime

import pytest

from app.services.ota_ledger import (
    TerminalStatusAlreadyRecordedError,
    append_event,
    read_events,
    terminal_status_for,
)


def fixed_clock():
    return datetime(2026, 7, 8, 12, 30, tzinfo=UTC)


def test_given_requested_and_started_when_terminal_appended_then_jsonl_records_have_injected_clock(
    tmp_path,
):
    ledger = tmp_path / "ota-ledger.jsonl"

    append_event(ledger, attempt_id="attempt-1", status="requested", clock=fixed_clock)
    append_event(
        ledger,
        attempt_id="attempt-1",
        status="started",
        metadata={"target_version": "1.2.4"},
        clock=fixed_clock,
    )
    append_event(
        ledger,
        attempt_id="attempt-1",
        status="applied",
        reason="health_passed",
        clock=fixed_clock,
    )

    rows = read_events(ledger)
    assert [row["status"] for row in rows] == ["requested", "started", "applied"]
    assert {row["created_at"] for row in rows} == {"2026-07-08T12:30:00Z"}
    assert rows[1]["metadata"] == {"target_version": "1.2.4"}
    assert rows[2]["reason"] == "health_passed"
    assert terminal_status_for(ledger, "attempt-1") == "applied"


@pytest.mark.parametrize("terminal_status", ["rejected", "applied", "rolled_back"])
def test_given_attempt_already_terminal_when_second_terminal_written_then_rejected(
    tmp_path, terminal_status
):
    ledger = tmp_path / "ota-ledger.jsonl"
    append_event(
        ledger,
        attempt_id="attempt-2",
        status=terminal_status,
        clock=fixed_clock,
    )

    with pytest.raises(TerminalStatusAlreadyRecordedError):
        append_event(
            ledger,
            attempt_id="attempt-2",
            status="rolled_back",
            clock=fixed_clock,
        )

    assert [row["status"] for row in read_events(ledger)] == [terminal_status]
