import pytest

from app.config import settings
from app.services import events_db
from server.tests.harness_export_zip.fixtures import (
    CLIPS_DIR,
    EVENTS_DB,
    assert_event_matches_raw_row,
    clip_ids,
    ordered_raw_rows_for,
)


pytestmark = [
    pytest.mark.skipif(
        not CLIPS_DIR.exists(),
        reason="no Jetson clip fixtures - capture .jetson-snapshot/proof_fixtures/clips",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_captured_events_db_when_get_by_ids_called_for_fixture_clips_then_order_and_rows_match_raw_sqlite(
    monkeypatch,
):
    ids = clip_ids()
    monkeypatch.setattr(settings, "events_db_path", EVENTS_DB)

    events = events_db.get_by_ids(settings.events_db_path, ids)
    raw_rows = ordered_raw_rows_for(ids)
    report = {
        "events_db_path": str(settings.events_db_path),
        "requested_ids": ids,
        "returned_ids": [event["id"] for event in events],
        "raw_row_ids": [row["id"] for row in raw_rows],
    }

    assert [event["id"] for event in events] == ids, report
    assert [row["id"] for row in raw_rows] == ids, report
    assert len(events) == 6, report
    for event, raw_row in zip(events, raw_rows):
        assert_event_matches_raw_row(event, raw_row)
